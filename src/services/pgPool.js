'use strict';

/**
 * pgPool.js
 *
 * Pool de conexiones PostgreSQL singleton.
 * Exporta getPool() que inicializa el pool en el primer uso.
 */

const { Pool } = require('pg');

let _pool = null;

function getPool() {
  if (!_pool) {
    _pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
      max:             parseInt(process.env.PG_POOL_MAX, 10) || 10,
      idleTimeoutMillis:  30_000,
      connectionTimeoutMillis: 10_000,
    });

    _pool.on('error', (err) => {
      console.error('[Postgres] Error en cliente idle:', err.message);
    });

    _pool.on('connect', () => {
      console.log('[Postgres] Nueva conexión en pool');
    });
  }

  return _pool;
}

/** Cierra el pool (usar en graceful shutdown). */
async function closePool() {
  if (_pool) {
    await _pool.end();
    _pool = null;
    console.log('[Postgres] Pool cerrado');
  }
}

module.exports = { getPool, closePool };
