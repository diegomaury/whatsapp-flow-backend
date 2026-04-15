'use strict';

/**
 * redisClient.js
 *
 * Cliente Redis singleton con circuit breaker integrado.
 *
 * Uso:
 *   const { redis } = require('./redisClient');
 *   await redis.set('key', 'value', 'EX', 60);
 *
 *   // Con circuit breaker (fail-open: si Redis está caído, ejecuta fallbackFn)
 *   const { safeRedis } = require('./redisClient');
 *   const val = await safeRedis(r => r.get('key'), () => null);
 */

const Redis = require('ioredis');
const { CircuitBreaker, CircuitOpenError } = require('./circuitBreaker');

// ─── Cliente ──────────────────────────────────────────────────────────────────

let _client = null;

function buildClient() {
  const client = new Redis({
    host:     process.env.REDIS_HOST     || 'localhost',
    port:     parseInt(process.env.REDIS_PORT, 10) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    tls:      process.env.REDIS_TLS === 'true' ? {} : undefined,
    // Falla rápido — no retries interminables que consuman el presupuesto de 10s
    maxRetriesPerRequest: 1,
    connectTimeout:       3_000,
    commandTimeout:       2_000,
    enableReadyCheck:     true,
    lazyConnect:          true,
    // Reconexión exponencial con cap
    retryStrategy: (times) => {
      if (times > 10) return null; // Dejar de reintentar
      return Math.min(times * 200, 3_000);
    },
  });

  client.on('connect',      () => console.log('[Redis] Conectando...'));
  client.on('ready',        () => console.log('[Redis] Listo'));
  client.on('error',  (err) => console.error('[Redis] Error:', err.message));
  client.on('close',        () => console.warn('[Redis] Conexión cerrada'));
  client.on('reconnecting', () => console.warn('[Redis] Reconectando...'));

  return client;
}

function getRedisClient() {
  if (!_client) {
    _client = buildClient();
    _client.connect().catch((err) => {
      console.error('[Redis] Fallo al conectar inicialmente:', err.message);
    });
  }
  return _client;
}

// ─── Circuit Breaker ──────────────────────────────────────────────────────────

const _breaker = new CircuitBreaker({
  name:             'redis',
  failureThreshold: 3,    // 3 fallos consecutivos → OPEN
  successThreshold: 2,    // 2 éxitos seguidos → CLOSED
  recoveryTimeout:  15_000, // 15s en OPEN antes de probar
});

/**
 * Ejecuta una operación Redis envuelta en el circuit breaker.
 * Si Redis está caído o el breaker está abierto, ejecuta fallbackFn.
 *
 * @template T
 * @param {(client: Redis) => Promise<T>} redisFn  - Operación sobre el cliente Redis
 * @param {() => T} [fallbackFn]                   - Fallback si Redis falla (fail-open)
 * @returns {Promise<T>}
 */
async function safeRedis(redisFn, fallbackFn = null) {
  try {
    return await _breaker.execute(() => redisFn(getRedisClient()));
  } catch (err) {
    const isOpen = err instanceof CircuitOpenError;
    const label  = isOpen ? 'CIRCUIT_OPEN' : 'REDIS_ERROR';
    console.warn(`[Redis:${label}] ${err.message}`);

    if (fallbackFn !== null) {
      return fallbackFn();
    }
    throw err;
  }
}

/**
 * Acceso directo al cliente (sin circuit breaker).
 * Usar solo cuando quieras manejar los errores manualmente.
 */
const redis = new Proxy({}, {
  get(_target, prop) {
    return (...args) => getRedisClient()[prop](...args);
  },
});

/** Estado actual del circuit breaker (para health check). */
function breakerState() {
  return _breaker.state;
}

module.exports = { safeRedis, redis, getRedisClient, breakerState };
