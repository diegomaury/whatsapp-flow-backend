'use strict';

const INTERNAL_TOKEN = process.env.INTERNAL_API_TOKEN;

if (!INTERNAL_TOKEN) {
  throw new Error('INTERNAL_API_TOKEN no está definida en el entorno. El endpoint /send-flow no puede arrancar sin ella.');
}

function internalAuth(req, res, next) {
  const token = req.headers['x-internal-token'];
  if (!token || token !== INTERNAL_TOKEN) {
    return res.status(401).json({ ok: false, error: 'No autorizado' });
  }
  next();
}

module.exports = internalAuth;
