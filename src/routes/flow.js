'use strict';

const express = require('express');
const router = express.Router();

const { handleFlowRequest } = require('../controllers/flowController');

// POST /flow — Flow Endpoint requerido por Meta
router.post('/', handleFlowRequest);

module.exports = router;
