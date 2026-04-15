'use strict';

/**
 * app.js — Setup de la aplicación Express.
 * Separado de server.js para facilitar testing.
 */

const express = require('express');
const app = express();

// ─── Seguridad HTTP básica ────────────────────────────────────────────────────
app.disable('x-powered-by');
app.set('trust proxy', 1); // necesario si hay reverse proxy (Railway, Fly, Nginx)

// ─── Body parsing + captura de rawBody para HMAC ─────────────────────────────
// IMPORTANTE: este middleware debe ir ANTES que cualquier ruta.
app.use(
  express.json({
    limit: '1mb', // Limite razonable — los payloads de Flow raramente superan los KB
    verify: (req, _res, buf) => {
      req.rawBody = buf; // Usado por signatureVerification para validar HMAC
    },
  })
);

// ─── Rutas ────────────────────────────────────────────────────────────────────
app.use('/webhook', require('./src/routes/webhook'));
app.use('/flow',    require('./src/routes/flow'));

// ─── Health checks ────────────────────────────────────────────────────────────

/** Liveness: el proceso está vivo. No toca dependencias. */
app.get('/health/live', (_req, res) => {
  res.json({ status: 'ok', ts: Date.now() });
});

/** Readiness: Redis y Postgres responden. El LB usa este para sacar del pool. */
app.get('/health/ready', async (_req, res) => {
  const checks = {};
  let allOk = true;

  // Redis
  try {
    const { safeRedis } = require('./src/lib/redisClient');
    await safeRedis(async (r) => r.ping(), () => { throw new Error('circuit open'); });
    checks.redis = 'ok';
  } catch (err) {
    checks.redis = `fail: ${err.message}`;
    allOk = false;
  }

  // Postgres
  try {
    const { getPool } = require('./src/services/pgPool');
    await getPool().query('SELECT 1');
    checks.postgres = 'ok';
  } catch (err) {
    checks.postgres = `fail: ${err.message}`;
    allOk = false;
  }

  res.status(allOk ? 200 : 503).json({ status: allOk ? 'ready' : 'not_ready', checks });
});

// ─── 404 ──────────────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

// ─── Error handler centralizado ───────────────────────────────────────────────
app.use(require('./src/middleware/errorHandler').errorHandler);

module.exports = app;
