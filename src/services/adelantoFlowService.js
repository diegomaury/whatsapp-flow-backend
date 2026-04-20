'use strict';

/**
 * adelantoFlowService.js
 *
 * State machine del Flow "Adelanto" (calificación de propiedad).
 *
 * Pantallas: WELCOME → LOCATION → PROPERTY → VALUE → ESTIMATE → AUTH → SUMMARY → DONE
 *
 * Interacciones con el data exchange endpoint:
 *   - INIT           → devuelve WELCOME + city_list pre-cargada
 *   - data_exchange LOCATION → devuelve colonias filtradas por ciudad
 *   - data_exchange VALUE    → calcula rango de adelanto (20 %–30 % del valor)
 *   - COMPLETE       → notifica Make.com con el payload completo y cierra
 */

const axios = require('axios');

const FLOW_VERSION = '3.0';

// ─── Datos de referencia ──────────────────────────────────────────────────────

const CITY_LIST = [
  { id: 'torreon', title: 'Torreón' },
  { id: 'gomez',   title: 'Gómez Palacio' },
  { id: 'lerdo',   title: 'Lerdo' },
  { id: 'otra',    title: 'Otra ciudad' },
];

const COLONIAS_POR_CIUDAD = {
  torreon: [
    { id: 'centro',        title: 'Centro' },
    { id: 'campestre',     title: 'Residencial Campestre' },
    { id: 'lomas',         title: 'Lomas del Nazas' },
    { id: 'las_quintas',   title: 'Las Quintas' },
    { id: 'jardines',      title: 'Jardines del Prado' },
    { id: 'rinconada',     title: 'Rinconada del Bosque' },
    { id: 'nueva_torreon', title: 'Nueva Torreón' },
    { id: 'san_isidro',    title: 'San Isidro' },
    { id: 'montecarlo',    title: 'Monte Carlo' },
    { id: 'las_trojes',    title: 'Las Trojes' },
  ],
  gomez: [
    { id: 'centro_gp',  title: 'Centro' },
    { id: 'san_jose',   title: 'San José' },
    { id: 'fracc_real', title: 'Fraccionamiento Real' },
    { id: 'nuevo_gp',   title: 'Nuevo Gómez' },
  ],
  lerdo: [
    { id: 'centro_lerdo', title: 'Centro' },
    { id: 'villas_lerdo', title: 'Villas del Lago' },
    { id: 'fracc_lerdo',  title: 'Fraccionamiento Lerdo' },
  ],
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Formatea un número como pesos MXN sin decimales.
 * Ejemplo: 300000 → "$300,000"
 */
function formatMXN(amount) {
  return new Intl.NumberFormat('es-MX', {
    style:                 'currency',
    currency:              'MXN',
    maximumFractionDigits: 0,
  }).format(amount);
}

// ─── Handlers por acción ──────────────────────────────────────────────────────

function handleInit(flow_token) {
  return {
    version: FLOW_VERSION,
    screen:  'WELCOME',
    data: {
      flow_token,
      city_list: CITY_LIST,   // pre-cargada para la pantalla LOCATION
    },
  };
}

function handleLocationExchange(data = {}, flow_token) {
  const city    = (data.city || '').toLowerCase().trim();
  const colonias = COLONIAS_POR_CIUDAD[city] || [];

  return {
    version: FLOW_VERSION,
    screen:  'PROPERTY',
    data: {
      flow_token,
      colonia_list: colonias,
    },
  };
}

function handleValueExchange(data = {}, flow_token) {
  // El flow envía el campo como "valor" (payload del footer en adelanto.json)
  const raw = parseFloat(
    String(data.valor || data.valor_propiedad || '0').replace(/[^0-9.]/g, '')
  );

  if (!raw || raw <= 0) {
    return {
      version: FLOW_VERSION,
      screen:  'VALUE',
      data: {
        flow_token,
        error_message: 'Ingresa un valor numérico válido mayor a cero.',
      },
    };
  }

  const min = Math.round(raw * 0.20);
  const max = Math.round(raw * 0.30);

  return {
    version: FLOW_VERSION,
    screen:  'ESTIMATE',
    data: {
      flow_token,
      rango_estimado: `Recibirías entre ${formatMXN(min)} y ${formatMXN(max)}`,
    },
  };
}

async function handleComplete(data = {}, flow_token, phone) {
  const makeUrl = process.env.MAKE_WA_INBOUND_WEBHOOK_URL;

  if (makeUrl) {
    // Fire-and-forget — no bloquear la respuesta a Meta
    axios.post(makeUrl, {
      flow_token,
      phone,
      timestamp: new Date().toISOString(),
      payload:   data,
    }).catch((err) => {
      console.error('[AdelantoFlow] Error notificando Make:', err.message);
    });
  } else {
    console.warn('[AdelantoFlow] MAKE_WA_INBOUND_WEBHOOK_URL no configurada — COMPLETE no notificado');
  }

  return {
    version: FLOW_VERSION,
    screen:  'SUCCESS',
    data: {
      extension_message_response: {
        params: {
          flow_token,
          completed_at: new Date().toISOString(),
        },
      },
    },
  };
}

// ─── Punto de entrada ─────────────────────────────────────────────────────────

/**
 * Procesa el body desencriptado del Flow Adelanto y retorna la respuesta para Meta.
 *
 * @param {object} decryptedBody
 * @returns {Promise<object>}
 */
async function processAdelantoFlow(decryptedBody) {
  const { action, screen, data = {}, flow_token } = decryptedBody;
  const phone = decryptedBody.phone_number || '';

  console.log(`[AdelantoFlow] action="${action}" screen="${screen || 'N/A'}"`);

  switch (action) {
    case 'ping':
      return { version: FLOW_VERSION, data: { status: 'active' } };

    case 'INIT':
      return handleInit(flow_token);

    case 'data_exchange':
      switch (screen) {
        case 'LOCATION':
          return handleLocationExchange(data, flow_token);

        case 'VALUE':
          return handleValueExchange(data, flow_token);

        default:
          console.warn(`[AdelantoFlow] data_exchange en pantalla no manejada: "${screen}"`);
          return { version: FLOW_VERSION, screen, data: { flow_token } };
      }

    case 'COMPLETE':
      return handleComplete(data, flow_token, phone);

    case 'BACK': {
      const backMap = {
        LOCATION: 'WELCOME',
        PROPERTY: 'LOCATION',
        VALUE:    'PROPERTY',
        ESTIMATE: 'VALUE',
        AUTH:     'ESTIMATE',
        SUMMARY:  'AUTH',
      };
      const prev = backMap[screen] || 'WELCOME';
      console.log(`[AdelantoFlow] BACK: ${screen} → ${prev}`);
      return { version: FLOW_VERSION, screen: prev, data: { flow_token, ...data } };
    }

    default:
      console.warn(`[AdelantoFlow] Acción desconocida: "${action}"`);
      return { version: FLOW_VERSION, data: { error: `Acción no soportada: ${action}` } };
  }
}

module.exports = { processAdelantoFlow };
