'use strict';

/**
 * idempotency.js
 *
 * Servicio de idempotencia con dos niveles de storage:
 *   1. Redis (primario) — persistente, compartido entre instancias
 *   2. TTLMap en memoria (fallback) — solo cuando Redis falla / circuit breaker abierto
 *
 * ── Webhook (/webhook POST) ───────────────────────────────────────────────────
 *   Clave   : wa:msg:{message_id}
 *   TTL     : 24h (ventana de re-delivery documentada por Meta)
 *   Fallback: memoria (acepta el riesgo de duplicado cross-instancia cuando Redis cae)
 *
 * ── Flow Endpoint (/flow POST) ────────────────────────────────────────────────
 *   Clave   : wa:flow:req:{hash(flow_token + screen + action + data)}
 *   TTL     : 10 min (reintentos de Meta duran minutos, no horas)
 *   Valor   : { status: 'SUCCESS'|'ERROR', encryptedResponse?: string }
 *   Fallback: NO. Si Redis está caído, procesamos sin cache (fail-open con log WARN).
 *             Motivo: el flow endpoint YA tiene idempotencia de estado en la sesión Redis;
 *             el fallback en memoria en multi-instancia sería peor que no tenerlo.
 */

const crypto = require('crypto');
const { safeRedis } = require('../lib/redisClient');
const { TTLMap } = require('../lib/ttlMap');

// ─── Constantes ───────────────────────────────────────────────────────────────

const WEBHOOK_MSG_TTL_S = 24 * 60 * 60;     // 24h en segundos (para Redis EX)
const WEBHOOK_MSG_TTL_MS = WEBHOOK_MSG_TTL_S * 1_000;  // Para TTLMap

const FLOW_REQ_TTL_S  = 10 * 60;            // 10 min
const FLOW_REQ_TTL_MS = FLOW_REQ_TTL_S * 1_000;

// Fallback en memoria solo para webhook
const _memCache = new TTLMap({ maxSize: 10_000, cleanupMs: 5 * 60_000 });

// ─── Webhook — deduplicación por message_id ───────────────────────────────────

/**
 * Registra un message_id como procesado.
 * Retorna true si fue registrado (primera vez) o false si ya existía (duplicado).
 *
 * Comportamiento:
 *   - Redis disponible: SETNX con TTL 24h
 *   - Redis caído:      TTLMap en memoria + log WARN (riesgo de duplicado cross-instancia aceptado)
 *
 * @param {string} messageId
 * @returns {Promise<boolean>} true = procesar; false = duplicado, descartar
 */
async function acquireWebhookLock(messageId) {
  const key = `wa:msg:${messageId}`;

  // Intentar en Redis primero
  const redisResult = await safeRedis(
    async (r) => {
      // SET key "1" NX EX ttl → retorna "OK" si se insertó, null si ya existía
      const res = await r.set(key, '1', 'NX', 'EX', WEBHOOK_MSG_TTL_S);
      return res === 'OK'; // true = primera vez, false = duplicado
    },
    () => null  // null = Redis no disponible → usar fallback
  );

  if (redisResult !== null) {
    if (!redisResult) {
      console.debug(`[Idempotency] Webhook duplicado descartado: ${messageId}`);
    }
    return redisResult;
  }

  // Fallback en memoria
  console.warn(`[Idempotency] Redis caído — usando fallback en memoria para message_id: ${messageId}`);
  if (_memCache.has(key)) {
    console.debug(`[Idempotency] Webhook duplicado (memory fallback): ${messageId}`);
    return false;
  }
  _memCache.set(key, '1', WEBHOOK_MSG_TTL_MS);
  return true;
}

// ─── Flow Endpoint — cache de respuesta cifrada ───────────────────────────────

/**
 * Computa la clave de idempotencia para una petición al /flow endpoint.
 * Incluye: flow_token, screen, action, y hash del data.
 *
 * @param {object} decryptedBody
 * @returns {string} clave Redis
 */
function computeFlowRequestKey(decryptedBody) {
  const { flow_token = '', screen = '', action = '', data = {} } = decryptedBody;

  // Canonicalizar data para hash estable (orden de claves determinista)
  const canonicalData = JSON.stringify(
    Object.keys(data).sort().reduce((acc, k) => { acc[k] = data[k]; return acc; }, {})
  );

  const hash = crypto
    .createHash('sha256')
    .update(`${flow_token}|${screen}|${action}|${canonicalData}`)
    .digest('hex')
    .slice(0, 32); // 32 chars es suficiente para unicidad

  return `wa:flow:req:${hash}`;
}

/**
 * Busca una respuesta cacheada para esta petición de /flow.
 *
 * @param {object} decryptedBody
 * @returns {Promise<{status: string, encryptedResponse?: string}|null>}
 *   null si no hay cache (procesar normalmente)
 */
async function getFlowResponseCache(decryptedBody) {
  const key = computeFlowRequestKey(decryptedBody);

  const cached = await safeRedis(
    async (r) => {
      const val = await r.get(key);
      return val ? JSON.parse(val) : null;
    },
    () => null // Redis caído → sin cache, procesar normalmente
  );

  if (cached) {
    console.debug(`[Idempotency] Flow cache hit: ${key.slice(-12)} status=${cached.status}`);
  }
  return cached;
}

/**
 * Guarda la respuesta de /flow en cache.
 *
 * @param {object} decryptedBody
 * @param {'SUCCESS'|'ERROR'} status
 * @param {string|null} encryptedResponse - Respuesta cifrada en Base64 (solo si status=SUCCESS)
 */
async function setFlowResponseCache(decryptedBody, status, encryptedResponse = null) {
  const key = computeFlowRequestKey(decryptedBody);

  const value = JSON.stringify({
    status,
    encryptedResponse,
    cachedAt: new Date().toISOString(),
  });

  await safeRedis(
    async (r) => r.set(key, value, 'EX', FLOW_REQ_TTL_S),
    () => {
      // Redis caído — no cachear, solo loguear. No usar memoria para flow responses.
      console.warn(`[Idempotency] Redis caído — respuesta de flow NO cacheada para key: ${key.slice(-12)}`);
    }
  );
}

module.exports = {
  acquireWebhookLock,
  getFlowResponseCache,
  setFlowResponseCache,
  computeFlowRequestKey, // exportado para tests
};
