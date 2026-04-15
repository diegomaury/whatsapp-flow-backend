'use strict';

/**
 * webhookController.js
 *
 * Maneja GET /webhook (verificación) y POST /webhook (mensajes entrantes).
 *
 * Seguridad aplicada en este controller (el resto en middleware):
 *   - La validación HMAC + anti-replay de message_id ya ocurrió en signatureVerification
 *   - Aquí solo procesamos lógica de negocio
 *
 * Idempotencia de webhook:
 *   - La deduplicación por message_id en Redis ya está en acquireWebhookLock(),
 *     llamada ANTES de cualquier side effect.
 *   - Responder 200 OK inmediatamente → procesar async para no bloquear Meta.
 */

const { sendTextMessage, markMessageAsRead, sendFlow } = require('../services/whatsappApi');
const { acquireWebhookLock } = require('../services/idempotency');

// ─── GET /webhook — verificación ──────────────────────────────────────────────

function verifyWebhook(req, res) {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  console.log(`[Webhook] Verificación: mode="${mode}"`);

  if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    console.log('[Webhook] ✓ Verificado');
    return res.status(200).send(challenge);
  }

  console.warn('[Webhook] ✗ Verificación fallida — token o modo incorrecto');
  return res.sendStatus(403);
}

// ─── POST /webhook — mensajes ─────────────────────────────────────────────────

async function receiveMessage(req, res) {
  const body = req.body;

  if (body?.object !== 'whatsapp_business_account') {
    return res.sendStatus(404);
  }

  // Responder 200 inmediatamente — Meta requiere <5s de respuesta
  res.sendStatus(200);

  // Procesamiento async post-respuesta
  processEntries(body.entry || []).catch((err) => {
    console.error('[Webhook] Error inesperado procesando entries:', err.message);
  });
}

// ─── Procesamiento interno ────────────────────────────────────────────────────

async function processEntries(entries) {
  for (const entry of entries) {
    for (const change of (entry.changes || [])) {
      await processChange(change).catch((err) => {
        console.error('[Webhook] Error en change:', err.message);
      });
    }
  }
}

async function processChange(change) {
  const value = change?.value;
  if (!value) return;

  if (value.messages?.length) {
    for (const message of value.messages) {
      await handleMessage(message, value);
    }
  }

  if (value.statuses?.length) {
    for (const status of value.statuses) {
      logStatus(status);
    }
  }
}

/**
 * Procesa un mensaje entrante.
 * La deduplicación final por message_id ocurre aquí (primera línea de defensa
 * tras el anti-replay de signatureVerification que ya corrió en el middleware).
 */
async function handleMessage(message, value) {
  const from      = message.from;
  const messageId = message.id;
  const type      = message.type;

  // Adquirir lock de idempotencia — descarta duplicados que pasaron el anti-replay
  // (puede ocurrir en escenarios de reconexión o multi-instancia con Redis caído)
  const isNew = await acquireWebhookLock(messageId);
  if (!isNew) {
    console.debug(`[Webhook] Mensaje duplicado ignorado: ${messageId}`);
    return;
  }

  console.log(`[Webhook] Procesando mensaje de ${from} — tipo: ${type} id: ${messageId}`);

  // Marcar como leído (best-effort, no bloquear si falla)
  markMessageAsRead(messageId).catch((err) =>
    console.warn('[Webhook] No se pudo marcar como leído:', err.message)
  );

  switch (type) {
    case 'text':
      await handleTextMessage(from, message);
      break;

    case 'interactive':
      await handleInteractive(from, message);
      break;

    case 'image':
      await sendTextMessage(from, '📷 Imagen recibida. ¡Gracias!');
      break;

    case 'audio':
      await sendTextMessage(from, '🎵 Audio recibido. ¡Gracias!');
      break;

    case 'document':
      await sendTextMessage(from, '📄 Documento recibido. ¡Gracias!');
      break;

    case 'location': {
      const { latitude, longitude } = message.location || {};
      await sendTextMessage(from, `📍 Ubicación recibida: ${latitude}, ${longitude}`);
      break;
    }

    default:
      console.log(`[Webhook] Tipo no manejado: ${type}`);
      await sendTextMessage(from, '✅ Mensaje recibido. ¡Gracias!');
  }
}

async function handleTextMessage(from, message) {
  const text = (message.text?.body || '').trim();
  console.log(`[Webhook] Texto de ${from}: "${text.slice(0, 80)}"`);

  const lower = text.toLowerCase();

  if (lower === 'flow' || lower === 'formulario') {
    // Trigger de Flow: usar texto clave para iniciar
    const flowId    = process.env.FLOW_ID || 'TU_FLOW_ID_AQUI';
    const flowToken = `tok_${from}_${Date.now()}`;

    await sendFlow({
      to:         from,
      flowId,
      flowToken,
      headerText: '¡Bienvenido!',
      bodyText:   'Completa el siguiente formulario rápido.',
      ctaText:    'Abrir formulario',
    });
  } else {
    // Echo por defecto
    await sendTextMessage(from, `Recibido: "${text}"`);
  }
}

async function handleInteractive(from, message) {
  const interactiveType = message.interactive?.type;
  console.log(`[Webhook] Interactive de ${from}: ${interactiveType}`);

  if (interactiveType === 'nfm_reply') {
    // Completion callback de un Flow
    const rawJson = message.interactive.nfm_reply?.response_json;
    if (rawJson) {
      let flowData = {};
      try { flowData = JSON.parse(rawJson); } catch { /* ignore */ }

      console.log(`[Webhook] Flow completado por ${from}:`, {
        flow_token: flowData.flow_token,
        name:       flowData.name,
      });

      const name = flowData.name || 'Usuario';
      await sendTextMessage(
        from,
        `¡Gracias, ${name}! Recibimos tu información correctamente. 🎉`
      );
    }
  } else if (interactiveType === 'button_reply') {
    const buttonId = message.interactive.button_reply?.id;
    console.log(`[Webhook] Button reply de ${from}: ${buttonId}`);
    await sendTextMessage(from, `Seleccionaste: ${message.interactive.button_reply?.title}`);
  }
}

function logStatus(status) {
  const { id, status: st, recipient_id, errors } = status;
  if (st === 'failed') {
    console.error(`[Webhook] Mensaje ${id} FALLIDO para ${recipient_id}:`, errors);
  } else {
    console.log(`[Webhook] Mensaje ${id} → ${st} (${recipient_id})`);
  }
}

module.exports = { verifyWebhook, receiveMessage };
