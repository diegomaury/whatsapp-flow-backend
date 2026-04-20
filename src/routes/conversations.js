'use strict';

const express = require('express');
const router = express.Router();
const { getPool } = require('../services/pgPool');

// POST /api/log-message — persiste un mensaje (usado por webhook y Make)
router.post('/log-message', async (req, res, next) => {
  try {
    const { phone, lead_name, direction, content, message_type = 'text' } = req.body;

    if (!phone || !direction || !content) {
      return res.status(400).json({ success: false, error: 'phone, direction y content son requeridos' });
    }
    if (!['in', 'out'].includes(direction)) {
      return res.status(400).json({ success: false, error: 'direction debe ser "in" o "out"' });
    }

    // conversation_id: número normalizado sin caracteres especiales
    const conversation_id = String(phone).replace(/\D/g, '').slice(-12);

    const { rows } = await getPool().query(
      `INSERT INTO messages (conversation_id, phone, lead_name, direction, content, message_type)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [conversation_id, phone, lead_name || 'Sin nombre', direction, content, message_type]
    );

    res.status(201).json({ success: true, data: rows[0] });
  } catch (err) {
    next(err);
  }
});

// GET /api/conversations — lista de conversaciones con último mensaje
router.get('/conversations', async (_req, res, next) => {
  try {
    const { rows } = await getPool().query(`
      SELECT DISTINCT ON (conversation_id)
        conversation_id,
        phone,
        lead_name,
        content   AS last_message,
        direction AS last_direction,
        created_at
      FROM messages
      ORDER BY conversation_id, created_at DESC
    `);

    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/conversations/:id/messages — mensajes de una conversación
router.get('/conversations/:id/messages', async (req, res, next) => {
  try {
    const { id } = req.params;
    const limit  = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = parseInt(req.query.offset, 10) || 0;

    const { rows } = await getPool().query(
      `SELECT * FROM messages
       WHERE conversation_id = $1
       ORDER BY created_at ASC
       LIMIT $2 OFFSET $3`,
      [id, limit, offset]
    );

    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
