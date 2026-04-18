'use strict';

/**
 * sendMessageController.js
 *
 * POST /send-message
 *
 * Endpoint exclusivo para Make.com — permite que Make envíe mensajes
 * de WhatsApp a través de Railway sin exponer las credenciales de Meta.
 *
 * Autenticación: header X-Make-Secret debe coincidir con env MAKE_SECRET.
 *
 * Tipos soportados:
 *   "text"     → mensaje de texto plano
 *   "flow"     → mensaje interactivo con botón de WhatsApp Flow
 *   "template" → plantilla aprobada en Meta Business
 */

const { sendTextMessage, sendFlow, sendTemplate } = require('../services/whatsappApi');

async function sendMessage(req, res) {
  // ── Autenticación ────────────────────────────────────────────────────────────
  const secret = req.headers['x-make-secret'];
  if (!process.env.MAKE_SECRET || secret !== process.env.MAKE_SECRET) {
    console.warn('[SendMessage] Acceso no autorizado — secret inválido o faltante');
    return res.status(401).json({ error: 'No autorizado' });
  }

  const {
    type,
    to,
    // text
    message,
    // flow
    flow_id,
    flow_token,
    header_text,
    body_text,
    cta_text,
    screen_data,
    // template
    template_name,
    language,
    components,
  } = req.body;

  if (!type || !to) {
    return res.status(400).json({ error: 'Campos requeridos: type, to' });
  }

  try {
    let result;

    switch (type) {

      case 'text': {
        if (!message) return res.status(400).json({ error: 'Falta "message" para tipo text' });
        result = await sendTextMessage(to, message);
        break;
      }

      case 'flow': {
        if (!flow_id || !flow_token) {
          return res.status(400).json({ error: 'Faltan flow_id y flow_token para tipo flow' });
        }
        result = await sendFlow({
          to,
          flowId:     flow_id,
          flowToken:  flow_token,
          headerText: header_text || 'Fliphouse',
          bodyText:   body_text   || 'Completa el formulario para continuar.',
          ctaText:    cta_text    || 'Abrir formulario',
          screenData: screen_data || {},
        });
        break;
      }

      case 'template': {
        if (!template_name) {
          return res.status(400).json({ error: 'Falta "template_name" para tipo template' });
        }
        result = await sendTemplate(to, template_name, language || 'es_MX', components || []);
        break;
      }

      default:
        return res.status(400).json({ error: `Tipo no soportado: ${type}` });
    }

    console.log(`[SendMessage] OK → ${to} (tipo: ${type})`);
    return res.json({ success: true, result });

  } catch (err) {
    console.error('[SendMessage] Error:', err.response?.data || err.message);
    return res.status(500).json({
      error:  'Error enviando mensaje',
      detail: err.response?.data || err.message,
    });
  }
}

module.exports = { sendMessage };
