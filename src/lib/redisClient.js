
const Redis = require('ioredis');

const redis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: 1,
  enableReadyCheck: true,
});

redis.on('connect', () => {
  console.log('[Redis] Conectado');
});

redis.on('error', (err) => {
  console.error('[Redis] Error:', err.message);
});

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
