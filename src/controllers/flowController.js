'use strict';

/**
 * flowController.js
 *
 * Maneja POST /flow — Flow Endpoint de WhatsApp.
 *
 * Pipeline de ejecución con todos los controles de hardening:
 *
 *   1. Detectar si el payload viene cifrado
 *   2. Decrypt (→ 421 si falla)
 *   3. Verificar que flow_token no esté COMPLETED (anti-reuse)
 *   4. Verificar idempotencia: si ya hay respuesta cacheada, devolverla directo
 *   5. Obtener/crear sesión en Redis
 *   6. Ejecutar state machine con timeout de 7s
 *   7. Persistir transición de estado en Redis
 *   8. Encrypt respuesta
 *   9. Cachear respuesta cifrada
 *  10. Responder
 *
 * Presupuesto de latencia interno: 7s para lógica, 3s margen hacia el límite de 10s de Meta.
 * Cualquier operación que pueda superar 7s debe moverse a async + pantalla intermedia.
 *
 * Regla operativa Make.com:
 *   - Flow crítico (completa una acción de negocio): NUNCA pasa por Make.
 *     Ejemplo: confirmar reserva, pago, registro. Lógica directa en el state machine.
 *   - Flow no crítico (notificaciones, leads, CRM updates): encolar async, responder
 *     pantalla intermedia ("procesando...") y notificar al usuario cuando termine.
 */

const fs   = require('fs');
const path = require('path');
const { decryptRequest, encryptResponse }  = require('../services/encryption');
const { processFlowRequest }               = require('../services/stateMachine');
const { getFlowResponseCache, setFlowResponseCache } = require('../services/idempotency');
const sessionRepo = require('../services/sessionRepository');

// ─── Configuración ────────────────────────────────────────────────────────────

/** Presupuesto máximo para lógica interna del /flow (7s → queda 3s de margen hacia Meta). */
const FLOW_LOGIC_TIMEOUT_MS = 7_000;

// ─── Carga de clave privada ───────────────────────────────────────────────────

function loadPrivateKey() {
  const keyPath = process.env.PRIVATE_KEY_PATH;
  if (keyPath) {
    const abs = path.resolve(keyPath);
    try {
      return fs.readFileSync(abs, 'utf-8');
    } catch (err) {
      throw new Error(`No se pudo leer PRIVATE_KEY_PATH (${abs}): ${err.message}`);
    }
  }

  const inline = process.env.PRIVATE_KEY;
  if (inline) return inline.replace(/\\n/g, '\n');

  return null;
}

// Cache de la clave en memoria para no releer el disco en cada request
let _cachedPrivateKey = null;
function getPrivateKey() {
  if (!_cachedPrivateKey) {
    _cachedPrivateKey = loadPrivateKey();
  }
  return _cachedPrivateKey;
}

// ─── Timeout wrapper ──────────────────────────────────────────────────────────

/**
 * Ejecuta una promesa con timeout.
 * Si el timeout se alcanza antes, rechaza con TimeoutError.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms) {
  let timerId;
  const timeoutPromise = new Promise((_, reject) => {
    timerId = setTimeout(() => {
      reject(Object.assign(new Error(`Timeout de ${ms}ms superado`), { isTimeout: true }));
    }, ms);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timerId));
}

// ─── Handler principal ────────────────────────────────────────────────────────

async function handleFlowRequest(req, res) {
  const body       = req.body;
  const isEncrypted = Boolean(body?.encrypted_flow_data);

  let decryptedBody;
  let aesKeyBuffer;
  let initialVectorBuffer;

  // ── 1. Decrypt ──────────────────────────────────────────────────────────────
  if (isEncrypted) {
    const privateKey = getPrivateKey();

    if (!privateKey) {
      console.error('[Flow] PRIVATE_KEY no configurada');
      return res.status(500).send('Server configuration error');
    }

    try {
      ({ decryptedBody, aesKeyBuffer, initialVectorBuffer } = decryptRequest(body, privateKey));
    } catch (err) {
      console.error('[Flow] Decrypt falló:', err.message);
      // 421 = clave pública registrada en Meta no coincide con nuestra clave privada
      return res.status(421).send('Decryption failed');
    }
  } else {
    console.log('[Flow] Payload no cifrado (dev mode)');
    decryptedBody = body;
  }

  const { action, flow_token, screen } = decryptedBody;

  console.log(`[Flow] action=${action} screen=${screen || 'N/A'} token=${(flow_token || '').slice(-8)}`);

  // ── 2. Anti-reuse: verificar que flow_token no esté COMPLETED ───────────────
  // Solo si hay flow_token y no es ping/INIT (los pings no tienen sesión)
  if (flow_token && action !== 'ping' && action !== 'INIT') {
    const alreadyDone = await sessionRepo.isCompleted(flow_token).catch(() => false);
    if (alreadyDone) {
      console.warn(`[Flow] flow_token ya COMPLETED: ${flow_token.slice(-8)}`);
      return res.status(421).send('Flow already completed');
    }
  }

  // ── 3. Idempotencia: buscar respuesta cacheada ──────────────────────────────
  if (flow_token && action !== 'ping') {
    const cached = await getFlowResponseCache(decryptedBody);

    if (cached && cached.status === 'SUCCESS' && cached.encryptedResponse) {
      console.log(`[Flow] Cache hit — devolviendo respuesta cacheada`);
      if (isEncrypted) {
        res.set('Content-Type', 'text/plain');
        return res.send(cached.encryptedResponse);
      }
      return res.json(JSON.parse(
        Buffer.from(cached.encryptedResponse, 'base64').toString('utf-8')
      ));
    }
  }

  // ── 4. Ejecutar state machine con timeout ───────────────────────────────────
  let responseData;

  try {
    responseData = await withTimeout(
      processFlowRequest(decryptedBody),
      FLOW_LOGIC_TIMEOUT_MS
    );
  } catch (err) {
    if (err.isTimeout) {
      console.error(`[Flow] Timeout de ${FLOW_LOGIC_TIMEOUT_MS}ms superado — respondiendo error`);
      // No cachear timeouts
      return res.status(504).send('Flow processing timeout');
    }
    console.error('[Flow] Error en state machine:', err.message);
    await setFlowResponseCache(decryptedBody, 'ERROR', null).catch(() => {});
    return res.status(500).send('Flow processing error');
  }

  // ── 5. Persistir transición en Redis (si hay sesión activa) ────────────────
  if (flow_token && action !== 'ping') {
    await persistStateTransition(decryptedBody, responseData).catch((err) => {
      // No fatal — la respuesta ya está lista; solo loguear
      console.warn('[Flow] Error persistiendo transición de estado:', err.message);
    });
  }

  // ── 6. Encrypt y responder ──────────────────────────────────────────────────
  if (isEncrypted) {
    let encryptedResponse;
    try {
      encryptedResponse = encryptResponse(responseData, aesKeyBuffer, initialVectorBuffer);
    } catch (err) {
      console.error('[Flow] Error en encrypt de respuesta:', err.message);
      return res.status(500).send('Encryption failed');
    }

    // Cachear la respuesta cifrada antes de responder
    await setFlowResponseCache(decryptedBody, 'SUCCESS', encryptedResponse).catch(() => {});

    res.set('Content-Type', 'text/plain');
    return res.send(encryptedResponse);
  }

  // Dev mode: sin cifrado
  await setFlowResponseCache(
    decryptedBody,
    'SUCCESS',
    Buffer.from(JSON.stringify(responseData)).toString('base64')
  ).catch(() => {});

  return res.json(responseData);
}

// ─── Persistencia de transición de estado ─────────────────────────────────────

/**
 * Persiste la transición de pantalla en Redis basándose en el resultado del state machine.
 * Si la sesión no existe (primer INIT), la crea.
 */
async function persistStateTransition(decryptedBody, responseData) {
  const { action, flow_token, screen, data } = decryptedBody;
  const nextScreen = responseData?.screen;

  if (!flow_token || !nextScreen) return;

  if (action === 'INIT') {
    // Crear nueva sesión
    const phone = decryptedBody.phone_number || 'unknown';
    const flowId = decryptedBody.flow_id || process.env.FLOW_ID || 'unknown';

    await sessionRepo.create({
      flowToken:     flow_token,
      phoneNumber:   phone,
      flowId,
      initialScreen: nextScreen,
    }).catch((err) => {
      if (err.message?.includes('ya existe')) {
        console.debug('[Flow] Sesión ya existía (reintento de INIT)');
      } else {
        throw err;
      }
    });

    return;
  }

  if (nextScreen === 'SUCCESS') {
    // Completar sesión
    await sessionRepo.complete(flow_token, data || {});
    return;
  }

  // Transición normal entre pantallas
  // Reintento con 1 retry ante OptimisticLockError
  try {
    await sessionRepo.transition(flow_token, nextScreen, data || {});
  } catch (err) {
    if (err instanceof sessionRepo.OptimisticLockError) {
      console.warn('[Flow] OptimisticLockError — reintentando transición');
      await sessionRepo.transition(flow_token, nextScreen, data || {});
    } else if (err instanceof sessionRepo.SessionNotFoundError) {
      console.warn('[Flow] Sesión no encontrada en Redis — posiblemente expirada');
      // No es fatal: el state machine ya procesó y la respuesta está lista
    } else {
      throw err;
    }
  }
}

module.exports = { handleFlowRequest };
