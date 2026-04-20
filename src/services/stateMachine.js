'use strict';

/**
 * stateMachine.js — Fliphouse
 *
 * Maneja la lógica de pantallas para dos productos:
 *
 *   adelanto → WELCOME → LOCATION → PROPERTY → VALUE ──data_exchange──→ ESTIMATE → AUTH → SUMMARY → DONE
 *   listing  → WELCOME → SEARCH_LOCATION → PROPERTY_TYPE → BUDGET → SUMMARY_CTA → DONE
 *
 * El producto se detecta comparando flow_id contra FLOW_ID_ADELANTO / FLOW_ID_LISTING.
 * Si no coincide con ninguno, se usa el flujo adelanto por default.
 *
 * Única llamada data_exchange real:
 *   - Producto adelanto, pantalla VALUE: recibe `valor` numérico → calcula min/max → devuelve ESTIMATE.
 *   - El resto de transiciones son navigate (client-side) y no necesitan respuesta del server.
 */

const FLOW_VERSION = '3.0';

// ─── Ciudades de La Laguna ────────────────────────────────────────────────────

const CITY_LIST = [
  { id: 'torreon',       title: 'Torreón'       },
  { id: 'gomez_palacio', title: 'Gómez Palacio'  },
  { id: 'lerdo',         title: 'Lerdo'          },
  { id: 'otra',          title: 'Otra ciudad'    },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Detecta el producto desde el flow_id.
 * @param {string|undefined} flowId
 * @returns {'adelanto'|'listing'}
 */
function detectProduct(flowId) {
  if (!flowId) return 'adelanto';
  if (flowId === process.env.FLOW_ID_LISTING) return 'listing';
  return 'adelanto'; // default (incluye FLOW_ID_ADELANTO)
}

/**
 * Formatea un número como pesos MXN (sin decimales, con comas).
 * @param {number} n
 * @returns {string}  Ejemplo: "$1,500,000"
 */
function formatMXN(n) {
  return '$' + Math.round(n).toLocaleString('es-MX');
}

// ─── Punto de entrada ─────────────────────────────────────────────────────────

async function processFlowRequest(decryptedBody) {
  const { action, screen, data, flow_token, flow_id } = decryptedBody;
  const producto = detectProduct(flow_id);

  console.log(`[StateMachine] producto=${producto} action="${action}" screen="${screen || 'N/A'}"`);

  switch (action) {
    case 'ping':
      return { version: FLOW_VERSION, data: { status: 'active' } };

    case 'INIT':
      return handleInit(decryptedBody, producto);

    case 'data_exchange':
      return handleDataExchange(screen, data, flow_token, producto, decryptedBody);

    case 'BACK':
      return handleBack(screen, data, flow_token, producto);

    default:
      console.warn(`[StateMachine] Acción desconocida: "${action}"`);
      return buildError(`Acción no soportada: ${action}`);
  }
}

// ─── INIT ─────────────────────────────────────────────────────────────────────

function handleInit(decryptedBody, producto) {
  const initData = decryptedBody.data || {};

  if (producto === 'listing') {
    // Para listing, WELCOME usa ${data.firstname} inyectado desde Make
    return {
      version: FLOW_VERSION,
      screen:  'WELCOME',
      data: {
        firstname: initData.firstname || '',
      },
    };
  }

  // adelanto: WELCOME → LOCATION necesita city_list
  return {
    version: FLOW_VERSION,
    screen:  'WELCOME',
    data: {
      city_list: CITY_LIST,
    },
  };
}

// ─── DATA EXCHANGE ────────────────────────────────────────────────────────────

function handleDataExchange(screen, data = {}, flow_token, producto, decryptedBody) {
  // La única pantalla con data_exchange real es VALUE (adelanto)
  // Acepta screen='VALUE' explícito O detección por contenido del data
  const hasValor = data?.valor_aproximado_de_tu_propiedad !== undefined || data?.valor !== undefined;

  if (producto === 'adelanto' && (screen === 'VALUE' || (!screen && hasValor))) {
    return handleValueExchange(data, decryptedBody);
  }

  // Para cualquier otra pantalla con data_exchange inesperado, devolver error suave
  console.warn(`[StateMachine] data_exchange inesperado en screen="${screen}" producto="${producto}"`);
  return buildError(`data_exchange no soportado en pantalla: ${screen}`);
}

/**
 * Pantalla VALUE del flow adelanto:
 * Recibe el valor de la propiedad → calcula rango 20-30% → devuelve ESTIMATE.
 */
function handleValueExchange(data, decryptedBody) {
  // Acepta ambos nombres de campo: 'valor' o 'valor_aproximado_de_tu_propiedad'
  const rawValor = parseFloat(data?.valor_aproximado_de_tu_propiedad || data?.valor) || 0;

  if (rawValor <= 0) {
    return {
      version: FLOW_VERSION,
      screen:  'VALUE',
      data: {
        error_message: 'Por favor ingresa un valor válido mayor a cero.',
      },
    };
  }

  const min = rawValor * 0.20;
  const max = rawValor * 0.30;

  const rango_estimado =
    `Con una propiedad de ${formatMXN(rawValor)} podrías recibir entre ${formatMXN(min)} y ${formatMXN(max)}.`;

  console.log(`[StateMachine] Cálculo adelanto: valor=${rawValor} → min=${min} max=${max}`);

  return {
    version: FLOW_VERSION,
    screen:  'ESTIMATE',
    data: {
      rango_estimado,
    },
  };
}

// ─── BACK ─────────────────────────────────────────────────────────────────────

function handleBack(screen, data = {}, flow_token, producto) {
  const backMaps = {
    adelanto: {
      LOCATION: 'WELCOME',
      PROPERTY: 'LOCATION',
      VALUE:    'PROPERTY',
      ESTIMATE: 'VALUE',
      AUTH:     'ESTIMATE',
      SUMMARY:  'AUTH',
    },
    listing: {
      SEARCH_LOCATION: 'WELCOME',
      PROPERTY_TYPE:   'SEARCH_LOCATION',
      BUDGET:          'PROPERTY_TYPE',
      SUMMARY_CTA:     'BUDGET',
    },
  };

  const map  = backMaps[producto] || backMaps.adelanto;
  const prev = map[screen] || 'WELCOME';

  console.log(`[StateMachine] BACK: ${screen} → ${prev} (producto: ${producto})`);

  return {
    version: FLOW_VERSION,
    screen:  prev,
    data:    { flow_token, ...data },
  };
}

// ─── Error helper ─────────────────────────────────────────────────────────────

function buildError(message) {
  return { version: FLOW_VERSION, data: { error: message } };
}

module.exports = { processFlowRequest };
