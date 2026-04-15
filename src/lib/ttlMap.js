'use strict';

/**
 * ttlMap.js
 *
 * Mapa en memoria con soporte de TTL por clave.
 * Usado como fallback cuando Redis no está disponible.
 *
 * Características:
 *   - Expiración lazy (al leer) + cleanup periódico activo
 *   - Tamaño máximo configurable (LRU simple: expulsa las más viejas al superar el límite)
 *   - Thread-safe en el contexto de Node.js (single-threaded event loop)
 */
class TTLMap {
  /**
   * @param {object} options
   * @param {number} options.maxSize       - Número máximo de entradas (default: 5000)
   * @param {number} options.cleanupMs     - Intervalo de limpieza activa en ms (default: 60_000)
   */
  constructor(options = {}) {
    this._maxSize   = options.maxSize   ?? 5_000;
    this._cleanupMs = options.cleanupMs ?? 60_000;
    this._store     = new Map(); // key → { value, expiresAt }

    // Cleanup periódico para no acumular memoria
    this._timer = setInterval(() => this._cleanup(), this._cleanupMs);
    // No bloquear el proceso si solo queda este timer
    if (this._timer.unref) this._timer.unref();
  }

  /**
   * Guarda un valor con TTL.
   * @param {string} key
   * @param {*}      value
   * @param {number} ttlMs - Tiempo de vida en milisegundos
   */
  set(key, value, ttlMs) {
    // Expulsar la más vieja si se alcanza el límite
    if (this._store.size >= this._maxSize && !this._store.has(key)) {
      const oldestKey = this._store.keys().next().value;
      this._store.delete(oldestKey);
    }

    this._store.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
    });
  }

  /**
   * Obtiene el valor si no expiró; null si no existe o expiró.
   * @param {string} key
   * @returns {*|null}
   */
  get(key) {
    const entry = this._store.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this._store.delete(key);
      return null;
    }

    return entry.value;
  }

  /**
   * Devuelve true si la clave existe y no expiró.
   * @param {string} key
   * @returns {boolean}
   */
  has(key) {
    return this.get(key) !== null;
  }

  /**
   * Elimina una clave.
   * @param {string} key
   */
  delete(key) {
    this._store.delete(key);
  }

  /** Número de entradas activas (incluyendo potencialmente expiradas no limpiadas aún). */
  get size() {
    return this._store.size;
  }

  /** Elimina todas las entradas expiradas. */
  _cleanup() {
    const now = Date.now();
    for (const [key, entry] of this._store) {
      if (now > entry.expiresAt) {
        this._store.delete(key);
      }
    }
  }

  /** Libera recursos (detiene el timer). */
  destroy() {
    clearInterval(this._timer);
    this._store.clear();
  }
}

module.exports = { TTLMap };
