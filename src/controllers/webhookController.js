'use strict';

/**
 * webhookController.js
 *
 * Maneja GET /webhook (verificación) y POST /webhook (mensajes entrantes).
 *
 * Arquitectura: Make.com es el cerebro. Este controller reenvía todos los
 * mensajes entrantes a MAKE_WA_INBOUND_URL para que Make decida qué hacer.
 * Railway solo actúa como middleware entre Meta y Make.
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

const axios = require('axios');
const { sendTextMessage, markMessageAsRead } = require('../services/whatsappApi');
const { acquireWebhookLock } = require('../services/idempotency');

// ─── Forward a Make ───────────────────────────────────────────────────────────

/**
 * Reenvía el payload de un mensaje entrante al webhook de Make.
 * No bloquea — Make procesa la lógica de negocio de forma independiente.
 *
 * @param {object} payload - Datos del mensaje normalizado
 */
async function forwardToMake(payload) {
  const makeUrl = process.env.MAKE_WA_INBOUND_URL || process.env.MAKE_WEBHOOK_URL;
  if (!makeUrl) {
    console.warn('[Webhook] MAKE_WA_INBOUND_URL/MAKE_WEBHOOK_URL no configurada — mensaje no reenviado');
    return;
  }

  try {
    // Log del JSON exacto que se envía a Make
    const outgoing = [payload];
    console.log('[Webhook] Payload enviado a Make:', JSON.stringify(outgoing));
    const response = await axios.post(makeUrl, outgoing, { timeout: 5000 });
    console.log(`[Webhook] → Make status: ${response.status} body: ${JSON.stringify(response.data)} (from: ${payload.from}, type: ${payload.type})`);
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;
    console.error(`[Webhook] Error forwarding a Make: status=${status} body=${JSON.stringify(data)} msg=${err.message}`);
  }
}

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
  // Log para depuración: imprime el body recibido
  console.log('[Webhook] Body recibido:', JSON.stringify(body, null, 2));

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
  if (messageId) {
    markMessageAsRead(messageId).catch((err) =>
      console.warn('[Webhook] No se pudo marcar como leído:', err.message)
    );
  }

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

  // Reenviar a Make — Make decide la respuesta
  await forwardToMake({
    from,
    type:       'text',
    message_id: message.id,
    text,
    timestamp:  message.timestamp,
  });
}

async function handleInteractive(from, message) {
  const interactiveType = message.interactive?.type;
  console.log(`[Webhook] Interactive de ${from}: ${interactiveType}`);

  if (interactiveType === 'nfm_reply') {
    // Completion callback de un WhatsApp Flow — reenviar payload completo a Make
    const rawJson = message.interactive.nfm_reply?.response_json;
    let flowData  = {};
    try { flowData = JSON.parse(rawJson || '{}'); } catch { /* ignore */ }

    console.log(`[Webhook] Flow completado por ${from} — flow_token: ${flowData.flow_token?.slice(-8)}`);

    await forwardToMake({
      from,
      type:       'flow_completion',
      message_id: message.id,
      flow_data:  flowData,
      timestamp:  message.timestamp,
    });

  } else if (interactiveType === 'button_reply') {
    // Respuesta a botón — reenviar a Make
    await forwardToMake({
      from,
      type:       'button_reply',
      message_id: message.id,
      button_id:  message.interactive.button_reply?.id,
      button_title: message.interactive.button_reply?.title,
      timestamp:  message.timestamp,
    });

  } else if (interactiveType === 'list_reply') {
    // Respuesta a lista — reenviar a Make
    await forwardToMake({
      from,
      type:       'list_reply',
      message_id: message.id,
      list_id:    message.interactive.list_reply?.id,
      list_title: message.interactive.list_reply?.title,
      timestamp:  message.timestamp,
    });
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
