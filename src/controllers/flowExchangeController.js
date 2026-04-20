'use strict';

/**
 * flowExchangeController.js
 *
 * Maneja POST /flow/exchange — Data Exchange endpoint para el Flow Adelanto.
 *
 * Misma arquitectura de cifrado que flowController:
 *   1. Detectar payload cifrado
 *   2. Decrypt RSA-OAEP + AES-256-GCM (→ 421 si falla)
 *   3. Ejecutar state machine del Adelanto con timeout 7s
 *   4. Encrypt respuesta y devolver
 *
 * Variables de entorno:
 *   FLOW_PRIVATE_KEY           — clave privada RSA inline (escapa \n)
 *   PRIVATE_KEY_PATH / PRIVATE_KEY — fallback a las claves del /flow principal
 *   MAKE_WA_INBOUND_WEBHOOK_URL — webhook de Make para acción COMPLETE
 */

const fs   = require('fs');
const path = require('path');

const { decryptRequest, encryptResponse } = require('../services/encryption');
const { processAdelantoFlow }             = require('../services/adelantoFlowService');

const FLOW_LOGIC_TIMEOUT_MS = 7_000;

// ─── Carga de clave privada ───────────────────────────────────────────────────

function loadPrivateKey() {
  // Clave específica del flow exchange (prioridad máxima)
  const inline = process.env.FLOW_PRIVATE_KEY;
  if (inline) return inline.replace(/\\n/g, '\n');

  // Fallback a las variables del /flow principal
  const keyPath = process.env.PRIVATE_KEY_PATH;
  if (keyPath) {
    const abs = path.resolve(keyPath);
    try {
      return fs.readFileSync(abs, 'utf-8');
    } catch (err) {
      throw new Error(`No se pudo leer PRIVATE_KEY_PATH (${abs}): ${err.message}`);
    }
  }

  const inlineFallback = process.env.PRIVATE_KEY;
  if (inlineFallback) return inlineFallback.replace(/\\n/g, '\n');

  return null;
}

let _cachedKey = null;
function getPrivateKey() {
  if (!_cachedKey) _cachedKey = loadPrivateKey();
  return _cachedKey;
}

// ─── Timeout wrapper ──────────────────────────────────────────────────────────

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

async function handleFlowExchange(req, res) {
  const body        = req.body;
  const isEncrypted = Boolean(body?.encrypted_flow_data);

  let decryptedBody;
  let aesKeyBuffer;
  let initialVectorBuffer;

  // ── 1. Decrypt ──────────────────────────────────────────────────────────────
  if (isEncrypted) {
    const privateKey = getPrivateKey();

    if (!privateKey) {
      console.error('[FlowExchange] Clave privada RSA no configurada (FLOW_PRIVATE_KEY o PRIVATE_KEY_PATH)');
      return res.status(500).send('Server configuration error');
    }

    try {
      ({ decryptedBody, aesKeyBuffer, initialVectorBuffer } = decryptRequest(body, privateKey));
    } catch (err) {
      console.error('[FlowExchange] Decrypt falló:', err.message);
      return res.status(421).send('Decryption failed');
    }
  } else {
    console.log('[FlowExchange] Payload no cifrado (dev mode)');
    decryptedBody = body;
  }

  const { action, flow_token, screen } = decryptedBody;
  console.log(`[FlowExchange] action=${action} screen=${screen || 'N/A'} token=${(flow_token || '').slice(-8)}`);

  // ── 2. Ejecutar state machine con timeout ───────────────────────────────────
  let responseData;

  try {
    responseData = await withTimeout(
      processAdelantoFlow(decryptedBody),
      FLOW_LOGIC_TIMEOUT_MS
    );
  } catch (err) {
    if (err.isTimeout) {
      console.error(`[FlowExchange] Timeout de ${FLOW_LOGIC_TIMEOUT_MS}ms superado`);
      return res.status(504).send('Flow processing timeout');
    }
    console.error('[FlowExchange] Error en state machine:', err.message);
    return res.status(500).send('Flow processing error');
  }

  // ── 3. Encrypt y responder ──────────────────────────────────────────────────
  if (isEncrypted) {
    let encryptedResponse;
    try {
      encryptedResponse = encryptResponse(responseData, aesKeyBuffer, initialVectorBuffer);
    } catch (err) {
      console.error('[FlowExchange] Error en encrypt de respuesta:', err.message);
      return res.status(500).send('Encryption failed');
    }

    res.set('Content-Type', 'text/plain');
    return res.send(encryptedResponse);
  }

  // Dev mode: sin cifrado
  return res.json(responseData);
}

module.exports = { handleFlowExchange };
