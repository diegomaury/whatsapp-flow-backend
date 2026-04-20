'use strict';

/**
 * sendMessageController.js
 *
 * Maneja POST /send-message — envío de mensajes desde Make.com u otros servicios.
 *
 * Tipos soportados:
 *   text     → { phone, message }
 *   flow     → { phone, type: "flow",     payload: { flowId?, flowToken?, headerText?, bodyText?, ctaText?, screenData? } }
 *   template → { phone, type: "template", payload: { templateName, languageCode?, components? } }
 *
 * Responde:
 *   200 { success: true,  data: <respuesta Meta> }
 *   400 { success: false, error: "..." }  — validación
 *   500 { success: false, error: "..." }  — error de API
 */

const { sendTextMessage, sendFlow, sendTemplate } = require('../services/whatsappApi');

async function handleSendMessage(req, res) {
  const { phone, message, type = 'text', payload = {} } = req.body;

  if (!phone) {
    return res.status(400).json({ success: false, error: 'El campo "phone" es requerido' });
  }

  console.log(`[SendMessage] type="${type}" to=${phone.slice(-4).padStart(phone.length, '*')}`);

  try {
    let result;

    switch (type) {
      case 'text': {
        if (!message) {
          return res.status(400).json({
            success: false,
            error: 'El campo "message" es requerido para type=text',
          });
        }
        result = await sendTextMessage(phone, message);
        break;
      }

      case 'flow': {
        const {
          flowId     = process.env.FLOW_ID,
          flowToken  = `tok_${phone}_${Date.now()}`,
          headerText = '¡Bienvenido!',
          bodyText   = 'Completa el siguiente formulario.',
          ctaText    = 'Abrir formulario',
          screenData = {},
        } = payload;

        if (!flowId) {
          return res.status(400).json({
            success: false,
            error: 'payload.flowId es requerido (o configura FLOW_ID en .env)',
          });
        }

        result = await sendFlow({ to: phone, flowId, flowToken, headerText, bodyText, ctaText, screenData });
        break;
      }

      case 'template': {
        const {
          templateName,
          languageCode = 'es_MX',
          components   = [],
        } = payload;

        if (!templateName) {
          return res.status(400).json({
            success: false,
            error: 'payload.templateName es requerido para type=template',
          });
        }

        result = await sendTemplate(phone, templateName, languageCode, components);
        break;
      }

      default:
        return res.status(400).json({
          success: false,
          error: `Tipo "${type}" no soportado. Valores válidos: text, flow, template`,
        });
    }

    return res.json({ success: true, data: result });
  } catch (err) {
    const detail = err.response?.data?.error?.message || err.message;
    console.error('[SendMessage] Error de API:', detail);
    return res.status(500).json({ success: false, error: detail });
  }
}

module.exports = { handleSendMessage };
