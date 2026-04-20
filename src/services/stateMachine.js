'use strict';

/**
 * stateMachine.js — Fliphouse
 *
 * Protocolo según docs.facebook.com/whatsapp/flows/guides/implementingyourflowendpoint
 *
 * Actions que llegan al endpoint:
 *   ping          → responder { data: { status: "active" } }
 *   INIT          → primera pantalla con su data inicial
 *   data_exchange → lógica de negocio; responder next screen o SUCCESS
 *   BACK          → pantalla anterior (solo si refresh_on_back: true en el flow JSON)
 *   error         → notificación de error de Meta; responder { data: { acknowledged: true } }
 *
 * Flujo adelanto:
 *   BIENVENIDA → UBICACION → PROPIEDAD
 *     → VALOR ──data_exchange──→ ESTIMADO
 *     → AUTORIZACION → RESUMEN ──data_exchange──→ SUCCESS (cierra el flow)
 *
 * Flujo listing:
 *   WELCOME → SEARCH_LOCATION → PROPERTY_TYPE → BUDGET → SUMMARY_CTA ──data_exchange──→ SUCCESS
 */

// ─── Constantes ───────────────────────────────────────────────────────────────

const FLOW_VERSION = '3.0';

// Imagen placeholder 1×1 px transparente (para campos de imagen requeridos en testing)
const IMG_PLACEHOLDER = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// Colonias de ejemplo para testing (en producción vienen inyectadas por Make al enviar el flow)
const COLONIAS_EJEMPLO = [
  { id: 'centro',      title: 'Centro'      },
  { id: 'residencial', title: 'Residencial' },
  { id: 'otra',        title: 'Otra'        },
];

// Mapas ID → texto display
const TIPO_MAP       = { casa: 'Casa', departamento: 'Departamento', otro: 'Otro' };
const ESCRITURAS_MAP = { si: 'Sí', no: 'No', no_se: 'No lo sé aún' };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function detectProduct(flowId) {
  if (!flowId) return 'adelanto';
  if (flowId === process.env.FLOW_ID_LISTING) return 'listing';
  return 'adelanto';
}

function formatMXN(n) {
  return '$' + Math.round(n).toLocaleString('es-MX');
}

// ─── Punto de entrada ─────────────────────────────────────────────────────────

async function processFlowRequest(decryptedBody) {
  const { action, screen, data, flow_token, flow_id } = decryptedBody;
  const producto = detectProduct(flow_id);

  console.log(`[StateMachine] producto=${producto} action="${action}" screen="${screen || 'N/A'}"`);

  switch (action) {

    // Health check periódico de Meta
    case 'ping':
      return { data: { status: 'active' } };

    // Flow abierto con flow_action: "data_exchange"
    case 'INIT':
      return handleInit(decryptedBody, producto);

    // Envío de formulario desde una pantalla
    case 'data_exchange':
      return handleDataExchange(screen, data, flow_token, producto, decryptedBody);

    // Botón atrás con refresh_on_back: true
    case 'BACK':
      return handleBack(screen, data, flow_token, producto);

    // Meta notifica que devolvimos JSON inválido en una request anterior
    case 'error':
      console.error(`[StateMachine] Error notification de Meta:`, JSON.stringify(data));
      return { data: { acknowledged: true } };

    default:
      console.warn(`[StateMachine] Acción desconocida: "${action}"`);
      return { data: { acknowledged: true } };
  }
}

// ─── INIT ─────────────────────────────────────────────────────────────────────

function handleInit(decryptedBody, producto) {
  const initData = decryptedBody.data || {};

  if (producto === 'listing') {
    return {
      version: FLOW_VERSION,
      screen:  'WELCOME',
      data: {
        firstname: initData.firstname || '',
      },
    };
  }

  // adelanto: primera pantalla BIENVENIDA
  // city, state, colonias y logo llegan inyectados desde Make cuando se envía el flow.
  // Si no vienen (testing), se usan valores de ejemplo.
  return {
    version: FLOW_VERSION,
    screen:  'BIENVENIDA',
    data: {
      logo:     initData.logo     || IMG_PLACEHOLDER,
      city:     initData.city     || 'Tu ciudad',
      state:    initData.state    || '',
      colonias: initData.colonias || COLONIAS_EJEMPLO,
    },
  };
}

// ─── DATA EXCHANGE ────────────────────────────────────────────────────────────

function handleDataExchange(screen, data = {}, flow_token, producto, decryptedBody) {
  if (producto === 'adelanto') {
    // VALOR → calcula estimado y navega a ESTIMADO
    if (screen === 'VALOR') {
      return handleValueExchange(data);
    }

    // RESUMEN → completa el flow y dispara Make.com
    if (screen === 'RESUMEN') {
      return handleResumenExchange(data, decryptedBody);
    }

    // Fallback: si screen no llega (Flow Builder test), detectar por contenido
    const hasValor   = data?.valor_aproximado !== undefined ||
                       data?.valor_aproximado_de_tu_propiedad !== undefined ||
                       data?.valor !== undefined;
    const hasResumen = data?.acepto_continuar !== undefined;

    if (hasValor && !hasResumen) return handleValueExchange(data);
    if (hasResumen)              return handleResumenExchange(data, decryptedBody);
  }

  console.warn(`[StateMachine] data_exchange sin handler: screen="${screen}" producto="${producto}"`);
  return { data: { error_message: `Pantalla no soportada: ${screen}` } };
}

/**
 * VALOR → ESTIMADO
 * Recibe valor de la propiedad, calcula rango 20–30%, devuelve todos los campos
 * que necesita la pantalla ESTIMADO del Flow JSON.
 */
function handleValueExchange(data) {
  const rawValor = parseFloat(
    data?.valor_aproximado              ||
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

  const tipo_display       = TIPO_MAP[data?.tipo_propiedad]       || data?.tipo_propiedad    || '';
  const escrituras_display = ESCRITURAS_MAP[data?.tiene_escrituras] || data?.tiene_escrituras || '';
  const colonia_display    = data?.colonia_display || data?.colonia_propiedad || '';

  console.log(`[StateMachine] VALOR→ESTIMADO: valor=${rawValor} min=${min} max=${max}`);

  return {
    version: FLOW_VERSION,
    screen:  'ESTIMADO',
    data: {
      city:               data?.city              || '',
      state:              data?.state             || '',
      colonia_propiedad:  data?.colonia_propiedad || '',
      colonia_display,
      tipo_propiedad:     data?.tipo_propiedad    || '',
      tipo_display,
      tiene_escrituras:   data?.tiene_escrituras  || '',
      escrituras_display,
      valor_display:      formatMXN(rawValor),
      adelanto_min:       formatMXN(min),
      adelanto_max:       formatMXN(max),
      icono_dinero:       IMG_PLACEHOLDER,
    },
  };
}

/**
 * RESUMEN → SUCCESS (cierra el flow)
 * Según la doc, la respuesta que cierra el flow es:
 *   { screen: "SUCCESS", data: { extension_message_response: { params: { flow_token, ...data } } } }
 * También dispara Make.com de forma asíncrona.
 */
function handleResumenExchange(data, decryptedBody) {
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

  console.log(`[StateMachine] RESUMEN→SUCCESS: acepto_continuar=${data?.acepto_continuar}`);

  // Respuesta de cierre según protocolo de WhatsApp Flows
  return {
    version: FLOW_VERSION,
    screen:  'SUCCESS',
    data: {
      extension_message_response: {
        params: {
          flow_token:       decryptedBody.flow_token,
          acepto_continuar: data?.acepto_continuar || 'no',
          ciudad:           data?.city             || '',
          adelanto_min:     data?.adelanto_min      || '',
          adelanto_max:     data?.adelanto_max      || '',
        },
      },
    },
  };
}

// ─── BACK ─────────────────────────────────────────────────────────────────────

function handleBack(screen, data = {}, flow_token, producto) {
  const backMap = producto === 'listing'
    ? {
        SEARCH_LOCATION: 'WELCOME',
        PROPERTY_TYPE:   'SEARCH_LOCATION',
        BUDGET:          'PROPERTY_TYPE',
        SUMMARY_CTA:     'BUDGET',
      }
    : {
        UBICACION:    'BIENVENIDA',
        PROPIEDAD:    'UBICACION',
        VALOR:        'PROPIEDAD',
        ESTIMADO:     'VALOR',
        AUTORIZACION: 'ESTIMADO',
        RESUMEN:      'AUTORIZACION',
      };

  const prev = backMap[screen] || 'BIENVENIDA';
  console.log(`[StateMachine] BACK: ${screen} → ${prev}`);

  return {
    version: FLOW_VERSION,
    screen:  prev,
    data:    { ...data, flow_token },
  };
}

module.exports = { processFlowRequest };
