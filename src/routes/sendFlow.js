'use strict';

const express   = require('express');
const router    = express.Router();
const { sendFlow } = require('../services/whatsappApi');

// POST /send-flow — exclusivo para Make.com
router.post('/', async (req, res) => {
  const { to, flowId, flowToken, headerText, bodyText, ctaText, screenData = {} } = req.body;

  try {
    const result = await sendFlow({ to, flowId, flowToken, headerText, bodyText, ctaText, screenData });
    return res.json({ ok: true, whatsapp_response: result });
  } catch (err) {
    const message = err.response?.data?.error?.message || err.message || 'Error desconocido';
    return res.status(502).json({ ok: false, error: message });
  }
});

module.exports = router;
