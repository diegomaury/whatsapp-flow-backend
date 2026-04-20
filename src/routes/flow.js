'use strict';

const express = require('express');
const router = express.Router();

const { handleFlowRequest }  = require('../controllers/flowController');
const { handleFlowExchange } = require('../controllers/flowExchangeController');

// POST /flow — Flow Endpoint genérico (state machine base)
router.post('/', handleFlowRequest);

// POST /flow/exchange — Data Exchange endpoint del Flow Adelanto
router.post('/exchange', handleFlowExchange);

module.exports = router;
