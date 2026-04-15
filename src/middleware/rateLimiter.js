'use strict';

/**
 * rateLimiter.js
 *
 * Rate limiting por número de teléfono usando sliding window en Redis.
 *
 * Algoritmo: Fixed Window con Redis INCR + EXPIRE.
 * (Sliding window puro requeriría ZADD con timestamps — mayor complejidad,
 * para un primer hardening la fixed window es suficiente y más simple.)
 *
 * Comportamiento cuando Redis está caído:
 *   Fail-open: deja pasar las peticiones (preferimos falsos negativos a
 *   bloquear usuarios legítimos por un fallo de infraestructura).
 *   Se registra WARN en log para alertar.
 *
 * Límites configurables por ruta:
 *   webhook : 30 req / 60s por número
 *   flow    : 10 req / 60s por número
 *
 * Nota de privacidad:
 *   Los números de teléfono NO se loguean en claro.
 *   Se usa el hash SHA-256 truncado a 12 chars en logs y keys de Redis.
 */

const crypto = require('crypto');
const { safeRedis } = require('../lib/redisClient');

// ─── Configuración de límites ─────────────────────────────────────────────────

const LIMITS = {
  webhook: { maxRequests: 30, windowSecs: 60 },
  flow:    { maxRequests: 10, windowSecs: 60 },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Devuelve un hash de 12 chars del número (para logs y keys de Redis). */
function phoneHash(phoneNumber) {
  return crypto
    .createHash('sha256')
    .update(phoneNumber)
    .digest('hex')
    .slice(0, 12);
}

/**
 * Verifica y registra una petición en la ventana de rate limit.
 *
 * @param {string} phoneNumber  - Número E.164
 * @param {'webhook'|'flow'} endpoint
 * @returns {Promise<{allowed: boolean, count: number, limit: number, resetInSecs: number}>}
 */
async function checkRateLimit(phoneNumber, endpoint) {
  const { maxRequests, windowSecs } = LIMITS[endpoint] || LIMITS.webhook;
  const hash = phoneHash(phoneNumber);
  const key  = `rl:${endpoint}:${hash}`;

  const result = await safeRedis(
    async (r) => {
      const pipeline = r.pipeline();
      pipeline.incr(key);
      pipeline.ttl(key);
      const [[, count], [, ttl]] = await pipeline.exec();

      // En el primer request de la ventana, establecer TTL
      if (ttl === -1) {
        await r.expire(key, windowSecs);
      }

      const resetInSecs = ttl > 0 ? ttl : windowSecs;
      return { count, resetInSecs };
    },
    () => null // Redis caído → fail-open
  );

  if (result === null) {
    console.warn(`[RateLimit] Redis caído — fail-open para ${endpoint}:${hash}`);
    return { allowed: true, count: 0, limit: maxRequests, resetInSecs: windowSecs };
  }

  const { count, resetInSecs } = result;
  const allowed = count <= maxRequests;

  if (!allowed) {
    console.warn(
      `[RateLimit] BLOQUEADO endpoint=${endpoint} phone_hash=${hash} count=${count} limit=${maxRequests}`
    );
  }

  return { allowed, count, limit: maxRequests, resetInSecs };
}

// ─── Middleware factories ─────────────────────────────────────────────────────

/**
 * Extrae el número de teléfono de la petición.
 * Para webhook: viene en body.entry[0].changes[0].value.messages[0].from
 * Para flow: viene en el body desencriptado (disponible después del decrypt)
 *
 * Esta función es para el WEBHOOK (antes del decrypt).
 */
function extractPhoneFromWebhookBody(body) {
  try {
    return body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from || null;
  } catch {
    return null;
  }
}

/**
 * Middleware de rate limit para el webhook.
 * Extrae el número del body JSON ya parseado.
 *
 * Nota: si no hay número de teléfono (ej: status updates), se omite el check.
 */
function webhookRateLimit() {
  return async (req, res, next) => {
    const phone = extractPhoneFromWebhookBody(req.body);

    if (!phone) {
      // Sin número identificable (status update, etc.) → pasar
      return next();
    }

    const { allowed, count, limit, resetInSecs } = await checkRateLimit(phone, 'webhook');

    if (!allowed) {
      // Para webhook: responder 200 OK silenciosamente para que Meta no reintente.
      // El usuario no verá error — simplemente no se procesará el mensaje.
      console.warn(
        `[RateLimit] Webhook descartado silenciosamente — phone_hash=${phoneHash(phone)}`
      );
      return res.sendStatus(200);
    }

    next();
  };
}

/**
 * Middleware de rate limit para el Flow Endpoint.
 * El número de teléfono debe estar disponible en req.phoneNumber
 * (seteado por el flowController después del decrypt).
 *
 * Retorna 429 si se excede el límite (Meta puede mostrar error al usuario).
 */
function flowRateLimit() {
  return async (req, res, next) => {
    const phone = req.phoneNumber; // Seteado por flowController

    if (!phone) {
      return next(); // Sin número → no podemos limitar
    }

    const { allowed, resetInSecs } = await checkRateLimit(phone, 'flow');

    if (!allowed) {
      res.set('Retry-After', String(resetInSecs));
      return res.status(429).json({ error: 'Demasiadas peticiones. Intenta más tarde.' });
    }

    next();
  };
}

module.exports = { webhookRateLimit, flowRateLimit, checkRateLimit, phoneHash };
