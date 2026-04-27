
const Redis = require('ioredis');

const redisUrl = process.env.REDIS_URL;

if (!redisUrl) {
  console.warn('[Redis] ADVERTENCIA: REDIS_URL no está definida. El cliente Redis no podrá conectarse.');
}

const redis = new Redis(redisUrl, {
  maxRetriesPerRequest: 1,
  enableReadyCheck: true,
});

redis.on('connect', () => {
  console.log('[Redis] Conectado');
});

redis.on('error', (err) => {
  console.error('[Redis] Error:', err.message);
});

/**
 * Returns the shared Redis client instance.
 * Used by consumers that need direct access (e.g. graceful shutdown, WATCH/MULTI).
 */
function getRedisClient() {
  return redis;
}

module.exports = {
  redis,
  getRedisClient,
  safeRedis: async (fn, fallback) => {
    try {
      return await fn(redis);
    } catch (err) {
      if (fallback) return fallback(err);
      throw err;
    }
  },
};
