'use strict';

require('dotenv').config();

// ─── Validación de variables requeridas ───────────────────────────────────────
const REQUIRED = [
  'WEBHOOK_VERIFY_TOKEN',
  'API_TOKEN',
  'BUSINESS_PHONE',
  'API_VERSION',
];

const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`[Server] Variables de entorno faltantes: ${missing.join(', ')}`);
  console.error('Copia .env.example → .env y completa los valores.');
  process.exit(1);
}

if (!process.env.PRIVATE_KEY_PATH && !process.env.PRIVATE_KEY) {
  console.warn('[Server] ADVERTENCIA: Clave privada RSA no configurada. /flow sin cifrado.');
}

if (!process.env.APP_SECRET) {
  console.warn('[Server] ADVERTENCIA: APP_SECRET no configurado. Firma de webhook NO verificada.');
}

if (!process.env.DATABASE_URL) {
  console.warn('[Server] ADVERTENCIA: DATABASE_URL no configurado. Completions no persistirán en Postgres.');
}

// ─── Servidor ─────────────────────────────────────────────────────────────────
const app  = require('./app');
const PORT = parseInt(process.env.PORT, 10) || 3000;

const server = app.listen(PORT, () => {
  console.log('─────────────────────────────────────────────────');
  console.log(`  WhatsApp Flow Backend v1.1 (hardened)`);
  console.log(`  Puerto    : ${PORT}`);
  console.log(`  Webhook   : http://localhost:${PORT}/webhook`);
  console.log(`  Flow      : http://localhost:${PORT}/flow`);
  console.log(`  Flow Xchg : http://localhost:${PORT}/flow/exchange`);
  console.log(`  Send Msg  : http://localhost:${PORT}/send-message`);
  console.log(`  Health    : http://localhost:${PORT}/health/ready`);
  console.log(`  Env       : ${process.env.NODE_ENV || 'development'}`);
  console.log('─────────────────────────────────────────────────');
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────
async function shutdown(signal) {
  console.log(`\n[Server] ${signal} — cerrando...`);

  // 1. Dejar de aceptar nuevas conexiones
  server.close(async () => {
    try {
      // 2. Cerrar pool de Postgres
      const { closePool } = require('./src/services/pgPool');
      await closePool();

      // 3. Cerrar cliente Redis
      const { getRedisClient } = require('./src/lib/redisClient');
      await getRedisClient().quit();
    } catch (err) {
      console.error('[Server] Error durante shutdown:', err.message);
    }

    console.log('[Server] Shutdown completo');
    process.exit(0);
  });

  // Forzar cierre si tarda demasiado
  setTimeout(() => {
    console.error('[Server] Shutdown forzado después de 15s');
    process.exit(1);
  }, 15_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// Capturar excepciones no manejadas para evitar crash silencioso
process.on('uncaughtException', (err) => {
  console.error('[Server] uncaughtException:', err);
  shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
  console.error('[Server] unhandledRejection:', reason);
});
