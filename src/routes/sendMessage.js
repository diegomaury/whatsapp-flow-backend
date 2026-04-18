'use strict';

const express = require('express');
const router  = express.Router();

const { sendMessage } = require('../controllers/sendMessageController');

// POST /send-message — exclusivo para Make.com
router.post('/', sendMessage);

module.exports = router;
