'use strict';

const express = require('express');
const router  = express.Router();

const { verifyWebhook, receiveMessage }   = require('../controllers/webhookController');
const { verifyWebhookSignature }          = require('../middleware/signatureVerification');
const { webhookRateLimit }                = require('../middleware/rateLimiter');

// GET /webhook — verificación del webhook por Meta (sin auth, Meta lo llama directamente)
router.get('/', verifyWebhook);

// POST /webhook — mensajes entrantes
// Pipeline: HMAC + anti-replay → lógica (rate limit temporalmente deshabilitado)
router.post('/', verifyWebhookSignature, receiveMessage);

module.exports = router;
