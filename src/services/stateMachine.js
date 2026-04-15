'use strict';

/**
 * stateMachine.js
 *
 * State machine de WhatsApp Flows con validación de inputs por pantalla.
 *
 * Flujo:
 *   [INIT] → WELCOME → FORM → CONFIRM → SUCCESS (cierra el flow)
 *
 * Input validation:
 *   Cada pantalla define un schema con reglas: tipo, longitud, regex, etc.
 *   Los errores de validación NO lanzan excepción — devuelven la misma pantalla
 *   con un campo error_message que WhatsApp muestra al usuario.
 *
 * Regla operativa Make.com (documentada en código):
 *   - Flow CRÍTICO (ej: confirma una acción de negocio): lógica directa aquí. NUNCA Make.
 *   - Flow NO CRÍTICO (ej: actualizar CRM, notificar Slack): encolar async aquí,
 *     responder pantalla intermedia. El worker notifica al usuario cuando termine.
 */

const FLOW_VERSION = '3.0';

// ─── Schemas de validación ────────────────────────────────────────────────────

/**
 * Valida los datos de un submit de pantalla.
 * Retorna null si todo es válido; string con el primer error encontrado si no.
 *
 * @param {object} data
 * @param {Array<{field, label, required?, maxLength?, minLength?, pattern?, patternMsg?}>} schema
 * @returns {string|null}
 */
function validate(data, schema) {
  for (const rule of schema) {
    const value = (data?.[rule.field] || '').toString().trim();

    if (rule.required && !value) {
      return `${rule.label} es requerido.`;
    }

    if (value && rule.minLength && value.length < rule.minLength) {
      return `${rule.label} debe tener al menos ${rule.minLength} caracteres.`;
    }

    if (value && rule.maxLength && value.length > rule.maxLength) {
      return `${rule.label} no puede superar ${rule.maxLength} caracteres.`;
    }

    if (value && rule.pattern && !rule.pattern.test(value)) {
      return rule.patternMsg || `${rule.label} tiene un formato inválido.`;
    }
  }
  return null;
}

// Schemas por pantalla
const SCHEMAS = {
  FORM: [
    {
      field:      'name',
      label:      'Nombre',
      required:   true,
      minLength:  2,
      maxLength:  80,
      // Bloquea caracteres de control, zero-width, etc.
      pattern:    /^[\p{L}\p{M}\s'\-\.]+$/u,
      patternMsg: 'El nombre solo puede contener letras, espacios y los caracteres \' - .',
    },
  ],
  // Añadir schemas para otras pantallas conforme crezca el flow
};

// ─── Punto de entrada ─────────────────────────────────────────────────────────

/**
 * Procesa el body desencriptado y retorna la respuesta para Meta.
 * Esta función puede ser async para soportar operaciones asíncronas en el futuro.
 *
 * @param {object} decryptedBody
 * @returns {Promise<object>} - Objeto de respuesta (antes de cifrar)
 */
async function processFlowRequest(decryptedBody) {
  const { action, screen, data, flow_token } = decryptedBody;

  console.log(`[StateMachine] action="${action}" screen="${screen || 'N/A'}"`);

  switch (action) {
    case 'ping':
      return { version: FLOW_VERSION, data: { status: 'active' } };

    case 'INIT':
      return handleInit(flow_token);

    case 'data_exchange':
      return handleDataExchange(screen, data, flow_token);

    case 'BACK':
      return handleBack(screen, data, flow_token);

    default:
      console.warn(`[StateMachine] Acción desconocida: "${action}"`);
      return buildError(`Acción no soportada: ${action}`);
  }
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

function handleInit(flow_token) {
  return {
    version: FLOW_VERSION,
    screen:  'WELCOME',
    data: {
      flow_token,
      welcome_message: '¡Hola! Completa el siguiente formulario.',
    },
  };
}

function handleDataExchange(screen, data = {}, flow_token) {
  switch (screen) {

    // WELCOME → FORM
    case 'WELCOME':
      return {
        version: FLOW_VERSION,
        screen:  'FORM',
        data:    { flow_token },
      };

    // FORM → CONFIRM (con validación)
    case 'FORM': {
      const error = validate(data, SCHEMAS.FORM);
      if (error) {
        return {
          version: FLOW_VERSION,
          screen:  'FORM',
          data: { flow_token, error_message: error },
        };
      }

      const name = data.name.trim();
      return {
        version: FLOW_VERSION,
        screen:  'CONFIRM',
        data: {
          flow_token,
          name,
          summary: `Nombre: ${name}. ¿Confirmas?`,
        },
      };
    }

    // CONFIRM → SUCCESS
    // REGLA: lógica de negocio crítica va aquí directamente.
    // Si necesitas llamar a Make u otro servicio externo, encola ASYNC y devuelve
    // una pantalla "PROCESANDO" en su lugar.
    case 'CONFIRM': {
      const { name } = data;

      // ── Aquí iría la lógica de negocio síncrona (máx 7s total) ──────────
      // Ejemplo: await crearRegistroInterno(flow_token, name);
      // Si tarda >7s → mover a cola async y devolver pantalla intermedia.
      // ─────────────────────────────────────────────────────────────────────

      return {
        version: FLOW_VERSION,
        screen:  'SUCCESS',
        data: {
          extension_message_response: {
            params: {
              flow_token,
              name:         name || '',
              completed_at: new Date().toISOString(),
            },
          },
        },
      };
    }

    default:
      console.warn(`[StateMachine] data_exchange en pantalla desconocida: "${screen}"`);
      return {
        version: FLOW_VERSION,
        screen:  'WELCOME',
        data:    { flow_token },
      };
  }
}

function handleBack(screen, data = {}, flow_token) {
  const backMap = {
    FORM:    'WELCOME',
    CONFIRM: 'FORM',
  };

  const prev = backMap[screen] || 'WELCOME';
  console.log(`[StateMachine] BACK: ${screen} → ${prev}`);

  return {
    version: FLOW_VERSION,
    screen:  prev,
    data:    { flow_token, ...data },
  };
}

function buildError(message) {
  return { version: FLOW_VERSION, data: { error: message } };
}

module.exports = { processFlowRequest, validate };
