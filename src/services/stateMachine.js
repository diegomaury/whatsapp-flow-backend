'use strict';

/**
 * stateMachine.js — Fliphouse
 *
 * Flow JSON en Meta (data_api_version: 4.0):
 *   WELCOME → LOCATION → PROPERTY → VALUE ──data_exchange──→ ESTIMATE
 *           → AUTHORIZATION → SUMMARY ──data_exchange──→ COMPLETE_YES | COMPLETE_NO
 *
 * Solo hay 2 data_exchanges que llegan al endpoint:
 *   1. VALUE   → calcula rango 20-30% → responde ESTIMATE
 *   2. SUMMARY → dispara Make.com     → responde COMPLETE_YES o COMPLETE_NO
 *
 * El resto de pantallas usan `navigate` con cross-screen references y
 * no requieren intervención del servidor.
 *
 * INIT solo se llama si el flow se envió con flow_action: "data_exchange".
 * Responde con WELCOME y los datos iniciales (city, state, colonias, logo).
 */

const FLOW_VERSION = '4.0'; // debe coincidir con data_api_version del flow JSON

const IMG_PLACEHOLDER = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const COLONIAS_EJEMPLO = [
  { id: 'centro',      title: 'Centro'      },
  { id: 'residencial', title: 'Residencial' },
  { id: 'otra',        title: 'Otra'        },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatMXN(n) {
  return '$' + Math.round(n).toLocaleString('es-MX');
}

// ─── Punto de entrada ─────────────────────────────────────────────────────────

async function processFlowRequest(decryptedBody) {
  const { action, screen, data, flow_token } = decryptedBody;

  console.log(`[StateMachine] action="${action}" screen="${screen || 'N/A'}"`);

  switch (action) {

    case 'ping':
      return { data: { status: 'active' } };

    case 'INIT':
      return handleInit(decryptedBody);

    case 'data_exchange':
      return handleDataExchange(screen, data, decryptedBody);

    case 'BACK':
      // El flow actual no usa refresh_on_back, pero lo manejamos por si acaso
      console.warn(`[StateMachine] BACK recibido en screen="${screen}" — no esperado`);
      return { version: FLOW_VERSION, screen: 'WELCOME', data: {} };

    case 'error':
      console.error(`[StateMachine] Error notification de Meta:`, JSON.stringify(data));
      return { data: { acknowledged: true } };

    default:
      console.warn(`[StateMachine] Acción desconocida: "${action}"`);
      return { data: { acknowledged: true } };
  }
}

// ─── INIT ─────────────────────────────────────────────────────────────────────

function handleInit(decryptedBody) {
  const d = decryptedBody.data || {};

  // Los valores reales (city, state, colonias) llegan inyectados desde Make
  // cuando se envía el flow con flow_action: "data_exchange".
  // Si no vienen (testing), se usan valores de ejemplo.
  return {
    version: FLOW_VERSION,
    screen:  'WELCOME',
    data: {
      city:           d.city           || 'Tu ciudad',
      state:          d.state          || '',
      colonias:       d.colonias       || COLONIAS_EJEMPLO,
      logo_fliphouse: d.logo_fliphouse || IMG_PLACEHOLDER,
    },
  };
}

// ─── DATA EXCHANGE ────────────────────────────────────────────────────────────

function handleDataExchange(screen, data = {}, decryptedBody) {
  if (screen === 'VALUE') {
    return handleValueExchange(data);
  }

  if (screen === 'SUMMARY') {
    return handleSummaryExchange(data, decryptedBody);
  }

  // Fallback para el Flow Builder (a veces no manda screen)
  const hasValor   = data?.valor_aproximado_de_tu_propiedad !== undefined;
  const hasResumen = data?.acepto_continuar !== undefined;

  if (hasValor && !hasResumen) return handleValueExchange(data);
  if (hasResumen)              return handleSummaryExchange(data, decryptedBody);

  console.warn(`[StateMachine] data_exchange sin handler: screen="${screen}"`);
  return { data: { error_message: `Pantalla no soportada: ${screen}` } };
}

// ─── VALUE → ESTIMATE ─────────────────────────────────────────────────────────

function handleValueExchange(data) {
  const rawValor = parseFloat(data?.valor_aproximado_de_tu_propiedad) || 0;

  if (rawValor <= 0) {
    return {
      version: FLOW_VERSION,
      screen:  'VALUE',
      data: { error_message: 'Por favor ingresa un valor válido mayor a cero.' },
    };
  }

  const min = rawValor * 0.20;
  const max = rawValor * 0.30;

  console.log(`[StateMachine] VALUE→ESTIMATE: valor=${rawValor} min=${min} max=${max}`);

  return {
    version: FLOW_VERSION,
    screen:  'ESTIMATE',
    data: {
      valor_display: formatMXN(rawValor),
      adelanto_min:  formatMXN(min),
      adelanto_max:  formatMXN(max),
      money_icon:    IMG_PLACEHOLDER,
    },
  };
}

// ─── SUMMARY → COMPLETE_YES | COMPLETE_NO ─────────────────────────────────────

function handleSummaryExchange(data, decryptedBody) {
  const acepto     = data?.acepto_continuar;
  const nextScreen = acepto === 'si' ? 'COMPLETE_YES' : 'COMPLETE_NO';

  // Disparar Make.com asíncrono — no bloquea la respuesta a Meta
  const makeWebhookUrl = process.env.MAKE_WEBHOOK_URL;
  if (makeWebhookUrl) {
    const axios = require('axios');
    axios.post(makeWebhookUrl, {
      flow_token: decryptedBody.flow_token,
      timestamp:  new Date().toISOString(),
      payload:    data,
      phone:      decryptedBody.phone_number,
    }).catch(err => console.error('[Make Error]', err.message));
  }

  console.log(`[StateMachine] SUMMARY→${nextScreen}: acepto_continuar=${acepto}`);

  // Pasar todos los campos que necesitan COMPLETE_YES / COMPLETE_NO
  return {
    version: FLOW_VERSION,
    screen:  nextScreen,
    data: {
      city:                             data?.city                             || '',
      state:                            data?.state                            || '',
      colonia_propiedad:                data?.colonia_propiedad                || '',
      tipo_propiedad:                   data?.tipo_propiedad                   || '',
      tiene_escrituras:                 data?.tiene_escrituras                 || '',
      valor_aproximado_de_tu_propiedad: data?.valor_aproximado_de_tu_propiedad || '',
      adelanto_min:                     data?.adelanto_min                     || '',
      adelanto_max:                     data?.adelanto_max                     || '',
      acepto_continuar:                 acepto                                 || 'no',
    },
  };
}

module.exports = { processFlowRequest };
