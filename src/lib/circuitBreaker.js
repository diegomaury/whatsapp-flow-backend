'use strict';

/**
 * circuitBreaker.js
 *
 * Circuit breaker simple para proteger llamadas a dependencias externas (Redis, APIs).
 *
 * Estados:
 *   CLOSED     → funcionando normal, las llamadas pasan
 *   OPEN       → demasiados fallos, rechaza llamadas inmediatamente
 *   HALF_OPEN  → probando recuperación, deja pasar una llamada
 *
 * Transiciones:
 *   CLOSED → OPEN         si consecutiveFails >= failureThreshold
 *   OPEN   → HALF_OPEN    si han pasado recoveryTimeoutMs desde el último fallo
 *   HALF_OPEN → CLOSED    si successThreshold llamadas exitosas seguidas
 *   HALF_OPEN → OPEN      si la llamada de prueba falla
 */
class CircuitBreaker {
  /**
   * @param {object} options
   * @param {string} options.name             - Nombre del breaker (para logs)
   * @param {number} options.failureThreshold - Fallos consecutivos para abrir (default: 5)
   * @param {number} options.successThreshold - Éxitos seguidos para cerrar desde HALF_OPEN (default: 2)
   * @param {number} options.recoveryTimeout  - Ms en OPEN antes de probar HALF_OPEN (default: 15000)
   */
  constructor(options = {}) {
    this.name = options.name || 'unnamed';
    this.failureThreshold = options.failureThreshold ?? 5;
    this.successThreshold = options.successThreshold ?? 2;
    this.recoveryTimeout  = options.recoveryTimeout  ?? 15_000;

    this._state          = 'CLOSED';
    this._consecutiveFails = 0;
    this._consecutiveSuccesses = 0;
    this._lastFailureAt  = null;
  }

  get state() { return this._state; }
  get isOpen() { return this._state === 'OPEN'; }

  /**
   * Ejecuta fn() pasando por el circuit breaker.
   * Lanza CircuitOpenError si el breaker está abierto.
   *
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async execute(fn) {
    this._maybeTransitionToHalfOpen();

    if (this._state === 'OPEN') {
      throw new CircuitOpenError(`[CircuitBreaker:${this.name}] Estado OPEN — llamada rechazada`);
    }

    try {
      const result = await fn();
      this._onSuccess();
      return result;
    } catch (err) {
      this._onFailure();
      throw err;
    }
  }

  /** Si el breaker es OPEN y ya pasó recoveryTimeout, mover a HALF_OPEN. */
  _maybeTransitionToHalfOpen() {
    if (
      this._state === 'OPEN' &&
      this._lastFailureAt !== null &&
      Date.now() - this._lastFailureAt >= this.recoveryTimeout
    ) {
      this._transition('HALF_OPEN');
    }
  }

  _onSuccess() {
    if (this._state === 'HALF_OPEN') {
      this._consecutiveSuccesses++;
      if (this._consecutiveSuccesses >= this.successThreshold) {
        this._reset();
      }
    } else {
      this._consecutiveFails = 0;
    }
  }

  _onFailure() {
    this._lastFailureAt = Date.now();
    this._consecutiveSuccesses = 0;

    if (this._state === 'HALF_OPEN') {
      this._transition('OPEN');
      return;
    }

    this._consecutiveFails++;
    if (this._consecutiveFails >= this.failureThreshold) {
      this._transition('OPEN');
    }
  }

  _reset() {
    this._consecutiveFails = 0;
    this._consecutiveSuccesses = 0;
    this._transition('CLOSED');
  }

  _transition(newState) {
    if (this._state !== newState) {
      console.warn(`[CircuitBreaker:${this.name}] ${this._state} → ${newState}`);
      this._state = newState;
    }
  }
}

class CircuitOpenError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CircuitOpenError';
    this.isCircuitOpen = true;
  }
}

module.exports = { CircuitBreaker, CircuitOpenError };
