'use strict';

/**
 * generateKeys.js
 *
 * Genera un par de claves RSA 2048 para usar con el Flow Endpoint de WhatsApp.
 *
 * Uso:
 *   node utils/generateKeys.js
 *
 * Salida:
 *   keys/private_key.pem  → PRIVADA: configurar en PRIVATE_KEY_PATH
 *   keys/public_key.pem   → PÚBLICA: subir a Meta Business Platform
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const KEYS_DIR = path.join(__dirname, '..', 'keys');

// Crear directorio si no existe
if (!fs.existsSync(KEYS_DIR)) {
  fs.mkdirSync(KEYS_DIR, { recursive: true });
}

console.log('Generando par de claves RSA 2048...');

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding:  { type: 'spki',   format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8',  format: 'pem' },
});

const privateKeyPath = path.join(KEYS_DIR, 'private_key.pem');
const publicKeyPath  = path.join(KEYS_DIR, 'public_key.pem');

fs.writeFileSync(privateKeyPath, privateKey,  { mode: 0o600 }); // solo lectura por el owner
fs.writeFileSync(publicKeyPath,  publicKey);

console.log('\n✓ Claves generadas exitosamente:');
console.log(`  Privada : ${privateKeyPath}`);
console.log(`  Pública : ${publicKeyPath}`);
console.log('\n─── PRÓXIMOS PASOS ───────────────────────────────────────');
console.log('1. Agrega en tu .env:');
console.log('     PRIVATE_KEY_PATH=./keys/private_key.pem');
console.log('\n2. Sube keys/public_key.pem a Meta Business Platform:');
console.log('   WhatsApp → Configuración → Flows → Clave pública');
console.log('\n3. NUNCA commitees private_key.pem al repositorio.');
console.log('   Agrega /keys/*.pem a tu .gitignore');
console.log('─────────────────────────────────────────────────────────');
