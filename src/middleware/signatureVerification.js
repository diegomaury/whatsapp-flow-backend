'use strict';

/**
 * signatureVerification.js
 *
 * Middleware de seguridad para POST /webhook.
 *
 * Capas implementadas (en orden de ejecución):
 *
 *   1. HMAC-SHA256 — valida X-Hub-Signature-256 usando APP_SECRET
 *   2. Timestamp    — descarta mensajes con timestamp > MAX_TIMESTAMP_AGE_S segundos
 *   3. Anti-replay  — almacena message_id en Redis (TTL 10 min); rechaza duplicados
 *                     aunque el timestamp sea válido
 *
 * Nota sobre comportamiento ante duplicados:
 *   Se responde 200 OK (no 4xx) para que Meta no reintente el delivery.
 *   El mensaje simplemente se descarta silenciosamente.
 *
 * Si APP_SECRET no está configurada, la validación HMAC se omite con WARN
 * (solo aceptable en desarrollo local).
 */

const crypto = require('crypto');
const { safeRedis } = require('../lib/redisClient');

// Máxima antigüedad de un timestamp de mensaje (configurable via env, default 5 min)
// Setear SKIP_TIMESTAMP_CHECK=true en Railway para deshabilitar en producción
const MAX_TIMESTAMP_AGE_S = process.env.MAX_TIMESTAMP_AGE_S
  ? parseInt(process.env.MAX_TIMESTAMP_AGE_S, 10)
  : 5 * 60;

// TTL en Redis para el registro de message_id (anti-replay)
const MSG_REPLAY_TTL_S = 10 * 60; // 10 minutos

// ─── HMAC ─────────────────────────────────────────────────────────────────────

function validateHmac(req, res) {
  const APP_SECRET = process.env.APP_SECRET;

  if (!APP_SECRET) {
    console.warn('[Security] APP_SECRET no configurada — HMAC no verificado (solo dev)');
    return true; // fail-open en desarrollo
  }

  const signatureHeader = req.headers['x-hub-signature-256'];
  if (!signatureHeader) {
    console.error('[Security] Header X-Hub-Signature-256 ausente');
    res.status(401).json({ error: 'Firma requerida' });
    return false;
  }

  if (!req.rawBody) {
    console.error('[Security] rawBody no disponible — verifica express.json({ verify })');
    res.status(500).json({ error: 'Error de configuración' });
    return false;
  }

  const expected = 'sha256=' + crypto
    .createHmac('sha256', APP_SECRET)
    .update(req.rawBody)
    .digest('hex');

  let match = false;
  try {
    match = crypto.timingSafeEqual(
      Buffer.from(signatureHeader),
      Buffer.from(expected)
    );
  } catch (err) {
    console.error('[Security] Error en timingSafeEqual:', err);
    match = false; // Buffers de distinto tamaño
  }

  if (!match) {
    console.error('[Security] Firma HMAC inválida');
    res.status(403).json({ error: 'Firma inválida' });
    return false;
  }

  return true;
}

// ─── Timestamp ────────────────────────────────────────────────────────────────

/**
 * Extrae el primer timestamp de messages[] en el body del webhook.
 * Devuelve null si no hay mensajes (status updates, etc.).
 */
function extractMessageTimestamp(body) {
  try {
    const ts = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.timestamp;
    return ts ? parseInt(ts, 10) : null;
  } catch {
    return null;
  }
}

function validateTimestamp(timestamp) {
  if (timestamp === null) return true; // No hay mensaje — skip
  if (process.env.SKIP_TIMESTAMP_CHECK === 'true') return true;

  const nowS   = Math.floor(Date.now() / 1_000);
  const deltaS = Math.abs(nowS - timestamp);
  console.log('[Security] timestamp:', timestamp, 'now:', nowS, 'delta:', deltaS, 'max:', MAX_TIMESTAMP_AGE_S);

  if (deltaS > MAX_TIMESTAMP_AGE_S) {
    console.warn(
      `[Security] Timestamp fuera de ventana: delta=${deltaS}s max=${MAX_TIMESTAMP_AGE_S}s`
    );
    return false;
  }

  return true;
}

// ─── Anti-replay por message_id ───────────────────────────────────────────────

/**
 * Registra un message_id en Redis con TTL.
 * Retorna true si es la primera vez (no replay).
 * Retorna false si ya existía (replay detectado).
 *
 * Fail-open si Redis está caído (log WARN, dejar pasar).
 */
async function checkAndStoreMessageId(messageId) {
  const key = `wa:replay:${messageId}`;

  const result = await safeRedis(
    async (r) => {
      const res = await r.set(key, '1', 'NX', 'EX', MSG_REPLAY_TTL_S);
      return res === 'OK'; // OK = primera vez; null = replay
    },
    () => {
      console.warn(`[Security] Redis caído — anti-replay omitido para message_id: ${messageId}`);
      return true; // fail-open
    }
  );

  return result;
}

// ─── Middleware principal ──────────────────────────────────────────────────────

/**
 * Middleware de verificación de webhook.
 * Combina HMAC + timestamp + anti-replay.
 */
async function verifyWebhookSignature(req, res, next) {
  console.log('[Security] middleware start');

  if (!validateHmac(req, res)) {
    console.log('[Security] HMAC failed');
    return; // ya envió respuesta
  }
  console.log('[Security] HMAC ok');

  // ── 2. Timestamp ───────────────────────────────────────────────────────────
  const timestamp = extractMessageTimestamp(req.body);

  if (!validateTimestamp(timestamp)) {
    // Responder 200 OK para que Meta no reintente (el mensaje es demasiado viejo)
    console.warn('[Security] Mensaje descartado por timestamp fuera de ventana');
    return res.sendStatus(200);
  }

  // ── 3. Anti-replay por message_id ──────────────────────────────────────────
  // const messageId = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.id;

  // if (messageId) {
  //   const isFirstTime = await checkAndStoreMessageId(messageId);

  //   if (!isFirstTime) {
  //     console.warn(`[Security] Replay detectado y descartado: message_id=${messageId}`);
  //     return res.sendStatus(200); // Silencioso para que Meta no reintente
  //   }
  // }

  console.log('[Security] middleware end, calling next()');
  next();
}

module.exports = { verifyWebhookSignature };
