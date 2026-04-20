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

// Mapas para convertir IDs a textos de display
const TIPO_MAP       = { casa: 'Casa', departamento: 'Departamento', otro: 'Otro' };
const ESCRITURAS_MAP = { si: 'Sí', no: 'No', no_se: 'No lo sé aún' };

// Imagen placeholder (1×1 px transparente) para campos de imagen requeridos
const IMG_PLACEHOLDER = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function handleDataExchange(screen, data = {}, flow_token, producto, decryptedBody) {
  if (producto === 'adelanto') {
    // Detectar qué data_exchange es por contenido cuando falta `screen`
    const hasValor   = data?.valor_aproximado !== undefined ||
                       data?.valor_aproximado_de_tu_propiedad !== undefined ||
                       data?.valor !== undefined;
    const hasResumen = data?.acepto_continuar !== undefined;

    if (screen === 'VALOR' || (!screen && hasValor && !hasResumen)) {
      return handleValueExchange(data, decryptedBody);
    }
    if (screen === 'RESUMEN' || (!screen && hasResumen)) {
      return handleResumenExchange(data, decryptedBody);
    }
  }

  console.warn(`[StateMachine] data_exchange inesperado en screen="${screen}" producto="${producto}"`);
  return buildError(`data_exchange no soportado en pantalla: ${screen}`);
}

/**
 * Pantalla VALOR → responde con ESTIMADO y todos sus campos requeridos.
 */
function handleValueExchange(data, decryptedBody) {
  const rawValor = parseFloat(
    data?.valor_aproximado ||
    data?.valor_aproximado_de_tu_propiedad ||
    data?.valor
  ) || 0;

  if (rawValor <= 0) {
    return {
      version: FLOW_VERSION,
      screen:  'VALOR',
      data: { error_message: 'Por favor ingresa un valor válido mayor a cero.' },
    };
  }

  const min = rawValor * 0.20;
  const max = rawValor * 0.30;

  const tipo_display       = TIPO_MAP[data?.tipo_propiedad]     || data?.tipo_propiedad     || '';
  const escrituras_display = ESCRITURAS_MAP[data?.tiene_escrituras] || data?.tiene_escrituras || '';
  // colonia_display: si no viene el texto, usar el id como fallback
  const colonia_display    = data?.colonia_display || data?.colonia_propiedad || '';

  console.log(`[StateMachine] VALOR→ESTIMADO: valor=${rawValor} min=${min} max=${max}`);

  return {
    version: FLOW_VERSION,
    screen:  'ESTIMADO',
    data: {
      city:               data?.city               || '',
      state:              data?.state              || '',
      colonia_propiedad:  data?.colonia_propiedad  || '',
      colonia_display,
      tipo_propiedad:     data?.tipo_propiedad     || '',
      tipo_display,
      tiene_escrituras:   data?.tiene_escrituras   || '',
      escrituras_display,
      valor_display:      formatMXN(rawValor),
      adelanto_min:       formatMXN(min),
      adelanto_max:       formatMXN(max),
      icono_dinero:       IMG_PLACEHOLDER,
    },
  };
}

/**
 * Pantalla RESUMEN → dispara Make.com y responde con CONFIRMADO o ENTENDIDO.
 */
function handleResumenExchange(data, decryptedBody) {
  const acepto     = data?.acepto_continuar;
  const nextScreen = acepto === 'si' ? 'CONFIRMADO' : 'ENTENDIDO';

  // Disparar Make.com asíncrono (no bloquea la respuesta)
  const makeWebhookUrl = process.env.MAKE_WEBHOOK_URL;
  if (makeWebhookUrl) {
    const axios = require('axios');
    axios.post(makeWebhookUrl, {
      flow_token:  decryptedBody.flow_token,
      timestamp:   new Date().toISOString(),
      payload:     data,
      phone:       decryptedBody.phone_number,
    }).catch(err => console.error('[Make Error]', err.message));
  }

  console.log(`[StateMachine] RESUMEN→${nextScreen}: acepto_continuar=${acepto}`);

  return {
    version: FLOW_VERSION,
    screen:  nextScreen,
    data: {
      city:        data?.city        || '',
      adelanto_min: data?.adelanto_min || '',
      adelanto_max: data?.adelanto_max || '',
    },
  };
}

// ─── BACK ─────────────────────────────────────────────────────────────────────

function handleBack(screen, data = {}, flow_token, producto) {
  const backMaps = {
    adelanto: {
      // IDs del Flow JSON (adelanto.json)
      UBICACION:    'BIENVENIDA',
      PROPIEDAD:    'UBICACION',
      VALOR:        'PROPIEDAD',
      ESTIMADO:     'VALOR',
      AUTORIZACION: 'ESTIMADO',
      RESUMEN:      'AUTORIZACION',
      // Aliases legacy por si acaso
      LOCATION: 'BIENVENIDA',
      PROPERTY: 'UBICACION',
      VALUE:    'PROPIEDAD',
      ESTIMATE: 'VALOR',
      AUTH:     'ESTIMADO',
      SUMMARY:  'AUTORIZACION',
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
