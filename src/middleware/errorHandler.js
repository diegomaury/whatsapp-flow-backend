'use strict';

/**
 * errorHandler.js
 *
 * Middleware de manejo de errores centralizado para Express.
 * Debe ser el ÚLTIMO middleware registrado en app.js.
 */

function errorHandler(err, req, res, next) {  // eslint-disable-line no-unused-vars
  const statusCode = err.statusCode || 500;
  const isDev = process.env.NODE_ENV !== 'production';

  console.error(`[Error] ${req.method} ${req.path} →`, err.message);
  if (isDev) console.error(err.stack);

  res.status(statusCode).json({
    error: err.expose ? err.message : 'Error interno del servidor',
    ...(isDev && { stack: err.stack }),
  });
}

module.exports = { errorHandler };
