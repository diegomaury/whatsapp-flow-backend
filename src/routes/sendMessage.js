'use strict';

const express = require('express');
const router  = express.Router();

const { handleSendMessage } = require('../controllers/sendMessageController');

// POST /send-message — envía mensajes vía WhatsApp Cloud API (llamado desde Make u otros)
router.post('/', handleSendMessage);

module.exports = router;
