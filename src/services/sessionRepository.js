'use strict';

/**
 * sessionRepository.js
 *
 * Repositorio de sesiones de WhatsApp Flows.
 *
 * Storage dual:
 *   Redis  → estado efímero en ejecución (TTL 1h). Lectura/escritura en todo request de /flow.
 *   Postgres → registro permanente al completar o abandonar. Fuente de verdad para negocio.
 *
 * Esquema Redis (HASH en `flow:session:{flow_token}`):
 *   phone_number   : string (E.164, ej: "521234567890")
 *   flow_id        : string
 *   current_screen : string (WELCOME|FORM|CONFIRM|SUCCESS)
 *   captured_data  : JSON serializado
 *   status         : ACTIVE | COMPLETED | ABANDONED | FAILED
 *   version        : int (optimistic locking — se incrementa en cada transición)
 *   created_at     : ISO-8601
 *   updated_at     : ISO-8601
 *
 * Optimistic locking:
 *   transition() hace WATCH + MULTI/EXEC. Si otro proceso modificó la sesión
 *   entre el WATCH y el EXEC, la transacción falla y se lanza OptimisticLockError.
 *   El caller (flowController) debe releer y reintentar (máx 1 reintento).
 */

const { safeRedis, getRedisClient } = require('../lib/redisClient');
const { getPool } = require('./pgPool');

const SESSION_TTL_S = 60 * 60; // 1h

const VALID_SCREENS = ['WELCOME', 'FORM', 'CONFIRM', 'SUCCESS'];
const VALID_STATUSES = ['ACTIVE', 'COMPLETED', 'ABANDONED', 'FAILED'];

// ─── Clase de error ───────────────────────────────────────────────────────────

class OptimisticLockError extends Error {
  constructor(flowToken) {
    super(`Conflicto de escritura en sesión ${flowToken} — reintenta`);
    this.name = 'OptimisticLockError';
    this.flowToken = flowToken;
  }
}

class SessionNotFoundError extends Error {
  constructor(flowToken) {
    super(`Sesión no encontrada para flow_token: ${flowToken}`);
    this.name = 'SessionNotFoundError';
    this.flowToken = flowToken;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function redisKey(flowToken) {
  return `flow:session:${flowToken}`;
}

function serialize(session) {
  return {
    phone_number:   session.phoneNumber,
    flow_id:        session.flowId,
    current_screen: session.currentScreen,
    captured_data:  JSON.stringify(session.capturedData || {}),
    status:         session.status,
    version:        String(session.version),
    created_at:     session.createdAt,
    updated_at:     session.updatedAt,
  };
}

function deserialize(hash) {
  return {
    phoneNumber:   hash.phone_number,
    flowId:        hash.flow_id,
    currentScreen: hash.current_screen,
    capturedData:  JSON.parse(hash.captured_data || '{}'),
    status:        hash.status,
    version:       parseInt(hash.version, 10),
    createdAt:     hash.created_at,
    updatedAt:     hash.updated_at,
  };
}

// ─── API pública ──────────────────────────────────────────────────────────────

/**
 * Crea una nueva sesión de flow.
 * Lanza si ya existe una sesión ACTIVE con ese flow_token.
 *
 * @param {{flowToken, phoneNumber, flowId, initialScreen?}} params
 * @returns {Promise<object>} session
 */
async function create({ flowToken, phoneNumber, flowId, initialScreen = 'WELCOME' }) {
  const now = new Date().toISOString();
  const session = {
    phoneNumber,
    flowId,
    currentScreen: initialScreen,
    capturedData:  {},
    status:        'ACTIVE',
    version:       1,
    createdAt:     now,
    updatedAt:     now,
  };

  const key = redisKey(flowToken);

  await safeRedis(async (r) => {
    const exists = await r.exists(key);
    if (exists) throw new Error(`Sesión ya existe para flow_token: ${flowToken}`);

    await r.hset(key, serialize(session));
    await r.expire(key, SESSION_TTL_S);
  });

  return session;
}

/**
 * Lee una sesión por flow_token.
 * Lanza SessionNotFoundError si no existe.
 *
 * @param {string} flowToken
 * @returns {Promise<object>} session
 */
async function get(flowToken) {
  const key = redisKey(flowToken);

  const hash = await safeRedis(
    async (r) => r.hgetall(key),
    () => null
  );

  if (!hash || Object.keys(hash).length === 0) {
    throw new SessionNotFoundError(flowToken);
  }

  return deserialize(hash);
}

/**
 * Transiciona la sesión a una nueva pantalla con datos opcionales.
 * Usa WATCH + MULTI/EXEC para garantizar atomicidad (optimistic locking).
 *
 * @param {string} flowToken
 * @param {string} newScreen
 * @param {object} [newData={}] - Datos a MERGEAR con los existentes
 * @returns {Promise<object>} sesión actualizada
 * @throws {OptimisticLockError} si otro proceso modificó la sesión concurrentemente
 */
async function transition(flowToken, newScreen, newData = {}) {
  if (!VALID_SCREENS.includes(newScreen)) {
    throw new Error(`Pantalla inválida: ${newScreen}`);
  }

  const key = redisKey(flowToken);
  const client = getRedisClient();

  // WATCH → leer versión actual → MULTI/EXEC
  try {
    await client.watch(key);

    const hash = await client.hgetall(key);
    if (!hash || Object.keys(hash).length === 0) {
      await client.unwatch();
      throw new SessionNotFoundError(flowToken);
    }

    const session = deserialize(hash);

    // Bloquear transición si el flow ya terminó
    if (session.status === 'COMPLETED' || session.status === 'ABANDONED') {
      await client.unwatch();
      throw new Error(`Sesión ${flowToken} ya está ${session.status} — no se puede transicionar`);
    }

    const now = new Date().toISOString();
    const updatedData = { ...session.capturedData, ...newData };
    const newVersion  = session.version + 1;

    const result = await client
      .multi()
      .hset(key, {
        current_screen: newScreen,
        captured_data:  JSON.stringify(updatedData),
        version:        String(newVersion),
        updated_at:     now,
      })
      .expire(key, SESSION_TTL_S)
      .exec();

    // exec() devuelve null si el WATCH detectó modificación concurrente
    if (result === null) {
      throw new OptimisticLockError(flowToken);
    }

    return {
      ...session,
      currentScreen: newScreen,
      capturedData:  updatedData,
      version:       newVersion,
      updatedAt:     now,
    };
  } catch (err) {
    // Asegurar que el WATCH se libera ante cualquier error
    if (!(err instanceof OptimisticLockError) && !(err instanceof SessionNotFoundError)) {
      try { await client.unwatch(); } catch {}
    }
    throw err;
  }
}

/**
 * Marca la sesión como COMPLETED y persiste en Postgres.
 *
 * @param {string} flowToken
 * @param {object} [finalData={}] - Datos finales capturados
 */
async function complete(flowToken, finalData = {}) {
  const key = redisKey(flowToken);
  const now  = new Date().toISOString();

  // Leer sesión actual antes de marcarla como completada
  const hash = await safeRedis(
    async (r) => r.hgetall(key),
    () => null
  );

  const session = hash && Object.keys(hash).length > 0
    ? deserialize(hash)
    : null;

  // Actualizar Redis (keep TTL extra para que reintentos tardíos de Meta vean COMPLETED)
  await safeRedis(async (r) => {
    await r.hset(key, {
      status:       'COMPLETED',
      captured_data: JSON.stringify({ ...(session?.capturedData || {}), ...finalData }),
      updated_at:   now,
    });
    // TTL extra: 2h para absorber reintentos tardíos
    await r.expire(key, SESSION_TTL_S * 2);
  });

  // Persistir en Postgres (no bloquear si falla — log el error)
  if (session) {
    try {
      const pool = getPool();
      const capturedData = { ...session.capturedData, ...finalData };
      const createdAt = session.createdAt;
      const durationMs = new Date(now) - new Date(createdAt);

      await pool.query(
        `INSERT INTO flow_completions
           (flow_token, phone_number, flow_id, captured_data, completed_at, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (flow_token) DO NOTHING`,
        [flowToken, session.phoneNumber, session.flowId, capturedData, now, durationMs]
      );
    } catch (pgErr) {
      console.error(`[SessionRepo] Error persistiendo en Postgres (flow_token=${flowToken}):`, pgErr.message);
      // No relanzar — la marca en Redis es suficiente para la operación actual
    }
  }
}

/**
 * Marca la sesión como ABANDONED (timeout, error irrecuperable).
 * @param {string} flowToken
 * @param {string} [reason='']
 */
async function abandon(flowToken, reason = '') {
  const key = redisKey(flowToken);

  await safeRedis(async (r) => {
    await r.hset(key, {
      status:     'ABANDONED',
      updated_at: new Date().toISOString(),
      ...(reason ? { abandon_reason: reason } : {}),
    });
    await r.expire(key, SESSION_TTL_S);
  });

  console.warn(`[SessionRepo] Sesión abandonada: ${flowToken}${reason ? ` (${reason})` : ''}`);
}

/**
 * Verifica si un flow_token ya fue completado (anti-reuse).
 * @param {string} flowToken
 * @returns {Promise<boolean>}
 */
async function isCompleted(flowToken) {
  const key = redisKey(flowToken);

  const status = await safeRedis(
    async (r) => r.hget(key, 'status'),
    () => null
  );

  return status === 'COMPLETED';
}

module.exports = {
  create,
  get,
  transition,
  complete,
  abandon,
  isCompleted,
  OptimisticLockError,
  SessionNotFoundError,
};
