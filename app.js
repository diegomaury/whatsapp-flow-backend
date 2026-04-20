'use strict';

/**
 * app.js — Setup de la aplicación Express.
 * Separado de server.js para facilitar testing.
 */

const path    = require('path');
const express = require('express');
const app = express();

// ─── Seguridad HTTP básica ────────────────────────────────────────────────────
app.disable('x-powered-by');
app.set('trust proxy', 1); 

// ─── Body parsing + captura de rawBody para HMAC ─────────────────────────────
app.use(
  express.json({
    limit: '1mb',
    verify: (req, _res, buf) => {
      req.rawBody = buf; 
    },
  })
);

// ─── Archivos estáticos (inbox UI) ───────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ─── Rutas ────────────────────────────────────────────────────────────────────
app.use('/api',          require('./src/routes/conversations'));
app.use('/webhook',      require('./src/routes/webhook'));
app.use('/flow',         require('./src/routes/flow'));
app.use('/send-message', require('./src/routes/sendMessage'));
app.use('/send-flow',    require('./src/middleware/internalAuth'), require('./src/routes/sendFlow'));

// ─── Health checks ────────────────────────────────────────────────────────────

/** Liveness: el proceso está vivo. */
app.get('/health/live', (_req, res) => {
  res.json({ status: 'ok', ts: Date.now() });
});

/** Debug temporal: verifica si la clave privada carga correctamente. REMOVER después. */
app.get('/health/key-check', (_req, res) => {
  const crypto = require('crypto');
  const fs = require('fs');
  const path = require('path');
  try {
    let key = null;
    const keyPath = process.env.PRIVATE_KEY_PATH;
    if (keyPath) {
      key = fs.readFileSync(path.resolve(keyPath), 'utf-8');
    } else if (process.env.PRIVATE_KEY) {
      key = process.env.PRIVATE_KEY.replace(/\\n/g, '\n');
    }
    if (!key) return res.json({ ok: false, error: 'PRIVATE_KEY no configurada' });
    const obj = crypto.createPrivateKey(key);
    res.json({
      ok: true,
      type: obj.asymmetricKeyType,
      bits: obj.asymmetricKeyDetails?.modulusLength,
      source: keyPath ? 'PRIVATE_KEY_PATH' : 'PRIVATE_KEY',
      firstChars: key.substring(0, 40),
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

/** Readiness: Redis y Postgres responden. */
app.get('/health/ready', async (_req, res, next) => {
  try {
    const checks = {};
    let allOk = true;

    // Redis
    try {
      const { safeRedis } = require('./src/lib/redisClient');
      await safeRedis(
        async (r) => r.ping(), 
        () => { throw new Error('circuit open'); }
      );
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

    res.status(allOk ? 200 : 503).json({ 
      status: allOk ? 'ready' : 'not_ready', 
      checks 
    });
  } catch (err) {
    // Captura errores inesperados fuera de los bloques internos
    next(err);
  }
});

// ─── 404 ──────────────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

// ─── Error handler centralizado ───────────────────────────────────────────────
app.use(require('./src/middleware/errorHandler').errorHandler);

module.exports = app;