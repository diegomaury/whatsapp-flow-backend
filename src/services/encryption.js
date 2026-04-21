'use strict';

/**
 * encryption.js
 *
 * Implementación completa del protocolo de cifrado de WhatsApp Flows.
 *
 * Protocolo Meta:
 *   DECRYPT:
 *     1. RSA-OAEP-SHA256 para desencriptar la AES key
 *     2. AES-256-GCM para desencriptar el payload
 *        - Los últimos 16 bytes del encrypted_flow_data son el auth tag GCM
 *
 *   ENCRYPT:
 *     1. Flip the IV (XOR cada byte con 0xFF)
 *     2. AES-256-GCM con el IV flippeado para cifrar la respuesta
 *     3. Concatenar ciphertext + auth tag → Base64
 */

const crypto = require('crypto');

const GCM_AUTH_TAG_LENGTH = 16; // bytes

/**
 * Desencripta una petición de WhatsApp Flow.
 *
 * @param {object} body  - Body recibido con los campos encriptados
 * @param {string} privateKeyPem - Clave privada RSA en formato PEM
 *
 * @returns {{
 *   decryptedBody: object,
 *   aesKeyBuffer: Buffer,
 *   initialVectorBuffer: Buffer
 * }}
 *
 * @throws {Error} si el AES key o el payload no pueden desencriptarse
 */
function decryptRequest(body, privateKeyPem) {
  const { encrypted_aes_key, encrypted_flow_data, initial_vector } = body;

  if (!encrypted_aes_key || !encrypted_flow_data || !initial_vector) {
    throw new Error(
      'Payload incompleto: faltan encrypted_aes_key, encrypted_flow_data o initial_vector'
    );
  }

  // ── PASO 1: Decodificar de Base64 ─────────────────────────────────────────
  const encryptedAesKeyBuffer = Buffer.from(encrypted_aes_key, 'base64');
  const encryptedFlowDataBuffer = Buffer.from(encrypted_flow_data, 'base64');
  const initialVectorBuffer = Buffer.from(initial_vector, 'base64');

  // ── PASO 2: Desencriptar la AES key con RSA-OAEP-SHA256 ──────────────────
  let aesKeyBuffer;
  try {
    aesKeyBuffer = crypto.privateDecrypt(
      {
        key: privateKeyPem,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      encryptedAesKeyBuffer
    );
  } catch (err) {
    throw new Error(`RSA decrypt falló (clave privada incorrecta o payload corrupto): ${err.message}`);
  }

  // ── PASO 3: Separar ciphertext y auth tag GCM ─────────────────────────────
  // El auth tag son los últimos GCM_AUTH_TAG_LENGTH bytes
  const ciphertext = encryptedFlowDataBuffer.slice(0, -GCM_AUTH_TAG_LENGTH);
  const authTag = encryptedFlowDataBuffer.slice(-GCM_AUTH_TAG_LENGTH);

  // ── PASO 4: Desencriptar payload con AES-256-GCM ──────────────────────────
  let decryptedBuffer;
  try {
    const decipher = crypto.createDecipheriv('aes-128-gcm', aesKeyBuffer, initialVectorBuffer);
    decipher.setAuthTag(authTag);
    decryptedBuffer = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (err) {
    throw new Error(`AES-GCM decrypt falló (auth tag inválido o datos corruptos): ${err.message}`);
  }

  // ── PASO 5: Parsear JSON ───────────────────────────────────────────────────
  let decryptedBody;
  try {
    decryptedBody = JSON.parse(decryptedBuffer.toString('utf-8'));
  } catch (err) {
    throw new Error(`El payload desencriptado no es JSON válido: ${err.message}`);
  }

  return { decryptedBody, aesKeyBuffer, initialVectorBuffer };
}

/**
 * Encripta la respuesta para WhatsApp Flows.
 *
 * @param {object} responseData       - Objeto de respuesta a encriptar
 * @param {Buffer} aesKeyBuffer       - AES key obtenida de decryptRequest
 * @param {Buffer} initialVectorBuffer - IV original obtenido de decryptRequest
 *
 * @returns {string} - String Base64 listo para enviar como respuesta
 */
function encryptResponse(responseData, aesKeyBuffer, initialVectorBuffer) {
  // ── PASO 1: Flip the IV (XOR cada byte con 0xFF) ──────────────────────────
  const flippedIV = Buffer.alloc(initialVectorBuffer.length);
  for (let i = 0; i < initialVectorBuffer.length; i++) {
    flippedIV[i] = initialVectorBuffer[i] ^ 0xff;
  }

  // ── PASO 2: Cifrar con AES-256-GCM y el IV flippeado ─────────────────────
  const cipher = crypto.createCipheriv('aes-128-gcm', aesKeyBuffer, flippedIV);
  const responseJson = JSON.stringify(responseData);

  const encryptedData = Buffer.concat([
    cipher.update(responseJson, 'utf-8'),
    cipher.final(),
  ]);

  // ── PASO 3: Concatenar ciphertext + auth tag → Base64 ─────────────────────
  const authTag = cipher.getAuthTag();
  const result = Buffer.concat([encryptedData, authTag]);

  return result.toString('base64');
}

module.exports = { decryptRequest, encryptResponse };
