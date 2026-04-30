'use strict';

/**
 * whatsappApi.js
 *
 * Capa de comunicación con WhatsApp Cloud API (Graph API).
 * Todas las funciones lanzan el error original para que el caller lo maneje.
 */

const axios = require('axios');

const GRAPH_BASE = 'https://graph.facebook.com';

/** Construye la URL base para el número de teléfono configurado. */
function messagesUrl() {
  const { API_VERSION, BUSINESS_PHONE } = process.env;
  return `${GRAPH_BASE}/${API_VERSION}/${BUSINESS_PHONE}/messages`;
}

/** Headers de autorización comunes. */
function authHeaders() {
  return {
    Authorization: `Bearer ${process.env.API_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

// ─── Mensajes básicos ──────────────────────────────────────────────────────────

/**
 * Envía un mensaje de texto plano.
 *
 * @param {string} to   - Número destino con código de país, sin "+" (ej: "521234567890")
 * @param {string} text - Texto a enviar
 */
async function sendTextMessage(to, text) {
  const body = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: { body: text },
  };

  try {
    const { data } = await axios.post(messagesUrl(), body, { headers: authHeaders() });
    console.log(`[API] Texto enviado a ${to}:`, data);
    return data;
  } catch (err) {
    console.error('[API] Error enviando texto:', err.response?.data || err.message);
    throw err;
  }
}

/**
 * Marca un mensaje como leído.
 *
 * @param {string} messageId - ID del mensaje recibido
 */
async function markMessageAsRead(messageId) {
  const body = {
    messaging_product: 'whatsapp',
    status: 'read',
    message_id: messageId,
  };

  try {
    await axios.post(messagesUrl(), body, { headers: authHeaders() });
  } catch (err) {
    // No crítico — solo loggear
    console.warn('[API] No se pudo marcar como leído:', err.response?.data || err.message);
  }
}

// ─── WhatsApp Flows ────────────────────────────────────────────────────────────

/**
 * Envía un Flow a un usuario.
 *
 * El Flow debe estar publicado en Meta y el flow_id disponible.
 *
 * @param {object} options
 * @param {string} options.to           - Número destino
 * @param {string} options.flowId       - ID del Flow en Meta
 * @param {string} options.flowToken    - Token único de sesión (generado por ti)
 * @param {string} options.headerText   - Texto del header del mensaje CTA
 * @param {string} options.bodyText     - Texto del cuerpo del mensaje CTA
 * @param {string} options.ctaText      - Texto del botón CTA (máx 20 chars)
 * @param {object} [options.screenData] - Datos iniciales para la primera pantalla
 */
async function sendFlow({
  to,
  flowId,
  flowToken,
  headerText,
  bodyText,
  ctaText,
  screenData = {},
}) {
  /*
   * Referencia de body (interactive/flow):
   * https://developers.facebook.com/docs/whatsapp/flows/guides/sendingaflow
   */
  const body = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'flow',
      header: {
        type: 'text',
        text: headerText,
      },
      body: {
        text: bodyText,
      },
      footer: {
        text: 'Powered by WhatsApp Flows',
      },
      action: {
        name: 'flow',
        parameters: {
          flow_message_version: '3',
          flow_token: flowToken,
          flow_id: flowId,
          flow_cta: ctaText,
          flow_action: 'navigate',
          flow_action_payload: screenData,
        },
      },
    },
  };

    // Log temporal para depuración (consola y error)
    const payloadStr = JSON.stringify(body, null, 2);
    console.log('[DEBUG] Payload enviado a WhatsApp:', payloadStr);
    console.error('[DEBUG] Payload enviado a WhatsApp:', payloadStr);
  try {
    const { data } = await axios.post(messagesUrl(), body, { headers: authHeaders() });
    console.log(`[API] Flow enviado a ${to} (flowId=${flowId}):`, data);
    return data;
  } catch (err) {
    console.error('[API] Error enviando Flow:', err.response?.data || err.message);
    throw err;
  }
}

/**
 * Envía una plantilla (template) aprobada.
 *
 * @param {string} to             - Número destino
 * @param {string} templateName   - Nombre de la plantilla aprobada
 * @param {string} languageCode   - Código de idioma (ej: "es_MX", "en_US")
 * @param {Array}  [components]   - Componentes de la plantilla (header, body params, etc.)
 */
async function sendTemplate(to, templateName, languageCode = 'es_MX', components = []) {
  const body = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode },
      ...(components.length > 0 && { components }),
    },
  };

  try {
    const { data } = await axios.post(messagesUrl(), body, { headers: authHeaders() });
    console.log(`[API] Template "${templateName}" enviada a ${to}:`, data);
    return data;
  } catch (err) {
    console.error('[API] Error enviando template:', err.response?.data || err.message);
    throw err;
  }
}

module.exports = { sendTextMessage, markMessageAsRead, sendFlow, sendTemplate };
