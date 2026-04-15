# WhatsApp Flow Backend

Backend de producción para WhatsApp Cloud API con **Webhook** + **Flow Endpoint** con cifrado RSA/AES-GCM completo, persistencia de sesiones, idempotencia, rate limiting, anti-replay, circuit breaker y timeout control.

---

## Estructura del proyecto

```
whatsapp-flow-backend/
├── src/
│   ├── controllers/
│   │   ├── webhookController.js   # GET + POST /webhook
│   │   └── flowController.js      # Decrypt → idempotencia → state machine → encrypt
│   ├── db/
│   │   └── schema.sql             # Schema PostgreSQL
│   ├── lib/
│   │   ├── circuitBreaker.js      # Circuit breaker (CLOSED/OPEN/HALF_OPEN)
│   │   ├── redisClient.js         # Cliente ioredis + wrapper safeRedis()
│   │   └── ttlMap.js              # Map en memoria con TTL (fallback de Redis)
│   ├── middleware/
│   │   ├── errorHandler.js        # Error handler centralizado
│   │   ├── rateLimiter.js         # Sliding window por número (Redis)
│   │   └── signatureVerification.js # HMAC + timestamp + anti-replay
│   ├── routes/
│   │   ├── webhook.js
│   │   └── flow.js
│   └── services/
│       ├── encryption.js          # decryptRequest() + encryptResponse()
│       ├── idempotency.js         # Dedup webhook + cache de respuesta flow
│       ├── pgPool.js              # Pool de conexiones PostgreSQL
│       ├── sessionRepository.js   # Sesiones en Redis + completions en Postgres
│       ├── stateMachine.js        # INIT → WELCOME → FORM → CONFIRM → SUCCESS
│       └── whatsappApi.js         # sendTextMessage, sendFlow, markMessageAsRead
├── utils/
│   └── generateKeys.js            # Genera par RSA 2048
├── app.js
├── server.js
├── .env.example
└── package.json
```

---

## Instalación

```bash
cd whatsapp-flow-backend
npm install
```

---

## Configuración

### 1. Variables de entorno

```bash
cp .env.example .env
```

| Variable | Descripción | Requerida |
|---|---|---|
| `PORT` | Puerto del servidor | No (default: 3000) |
| `WEBHOOK_VERIFY_TOKEN` | Token que defines al registrar el webhook en Meta | Sí |
| `API_TOKEN` | System User Token de WhatsApp | Sí |
| `BUSINESS_PHONE` | Phone Number ID (no el número, el ID) | Sí |
| `API_VERSION` | Versión de Graph API (ej: `v20.0`) | Sí |
| `APP_SECRET` | App Secret de Meta — valida firma HMAC del webhook | Sí (prod) |
| `FLOW_ID` | ID del Flow publicado en Meta | Sí (para enviar flows) |
| `PRIVATE_KEY_PATH` | Ruta al `.pem` de clave privada RSA | Sí (para flows cifrados) |
| `REDIS_HOST` | Host de Redis | Sí |
| `REDIS_PORT` | Puerto de Redis | No (default: 6379) |
| `REDIS_PASSWORD` | Password de Redis | Si tu instancia lo requiere |
| `REDIS_TLS` | `true` si Redis usa TLS (Railway, Upstash) | Si aplica |
| `DATABASE_URL` | Connection string PostgreSQL | Sí (para persistencia) |
| `DATABASE_SSL` | `true` si Postgres usa TLS | Si aplica |

### 2. Generar claves RSA

```bash
npm run generate-keys
```

Crea `keys/private_key.pem` y `keys/public_key.pem`.

**Subir la clave pública a Meta:**
> WhatsApp Manager → Cuenta → Configuración → Flows → Clave pública del negocio

### 3. Inicializar base de datos

```bash
npm run db:migrate
```

O manualmente:

```bash
psql $DATABASE_URL -f src/db/schema.sql
```

---

## Ejecutar

```bash
# Desarrollo (con nodemon)
npm run dev

# Producción
npm start
```

---

## Exponer con ngrok (desarrollo)

```bash
ngrok http 3000
```

Usa la URL HTTPS en la configuración de Meta (ej: `https://abc123.ngrok-free.app`).

---

## Configurar Webhook en Meta

1. Meta for Developers → Tu App → WhatsApp → Configuración → Webhook
2. URL: `https://TU-DOMINIO/webhook`
3. Token de verificación: valor de `WEBHOOK_VERIFY_TOKEN`
4. Suscribirse a: `messages`

---

## Configurar Flow Endpoint en Meta

1. WhatsApp Manager → Flows → Seleccionar Flow → Editar
2. Endpoint URL: `https://TU-DOMINIO/flow`
3. Verificar que la clave pública esté subida

---

## Health checks

```bash
# Liveness (solo el proceso)
GET /health/live

# Readiness (Redis + Postgres)
GET /health/ready
```

Respuesta `/health/ready`:
```json
{ "status": "ready", "checks": { "redis": "ok", "postgres": "ok" } }
```

---

## Protocolo de cifrado

```
DECRYPT:
  encrypted_aes_key   → RSA-OAEP-SHA256(private_key) → aes_key (32 bytes)
  encrypted_flow_data → AES-256-GCM(aes_key, iv)
  encrypted_flow_data[-16:] → auth tag GCM

ENCRYPT (respuesta):
  flipped_iv = iv XOR 0xFF (byte a byte)
  AES-256-GCM(aes_key, flipped_iv, JSON_respuesta) + auth_tag → Base64
```

---

## Pipeline de seguridad por endpoint

### POST /webhook

```
→ express.json() [captura rawBody]
→ verifyWebhookSignature()
    1. HMAC-SHA256 (X-Hub-Signature-256 vs APP_SECRET)
    2. Timestamp del mensaje (ventana ±5 min)
    3. Anti-replay: message_id en Redis (TTL 10 min)
→ webhookRateLimit()
    sliding window 30 req/min por número (Redis, fail-open)
→ receiveMessage()
    acquireWebhookLock() — dedup final por message_id (Redis + memoria fallback)
    responde 200 OK inmediato → procesa async
```

### POST /flow

```
→ express.json()
→ handleFlowRequest()
    1. Decrypt RSA+AES-GCM (→ 421 si falla)
    2. Anti-reuse: flow_token COMPLETED rechazado (→ 421)
    3. Idempotencia: busca respuesta cacheada en Redis (TTL 10 min)
    4. processFlowRequest() con timeout de 7s (Promise.race)
    5. Persiste transición en Redis (optimistic locking)
    6. Encrypt respuesta
    7. Cachea respuesta cifrada
    8. Responde text/plain Base64
```

---

## State machine

```
[INIT]
   │
   ▼
WELCOME ──(clic Comenzar)──▶ FORM ──(nombre válido)──▶ CONFIRM ──(confirmar)──▶ SUCCESS
                              │ ▲                        │ ▲
                       (BACK)─┘ └──────────────── (BACK)─┘
```

**Validación en FORM:**
- `name`: requerido, 2-80 chars, solo letras/espacios/`'-`.

---

## Regla operativa Make.com

| Tipo de flow | Usar Make | Patrón |
|---|---|---|
| **Crítico** (confirma acción de negocio) | ❌ NUNCA | Lógica directa en `CONFIRM` handler |
| **No crítico** (actualizar CRM, Slack) | ✅ Async | Encolar en `CONFIRM`, devolver pantalla "Procesando..." |

**Motivo:** Meta impone un SLA estricto de 10s en `/flow`. Make puede tardar >10s fácilmente.

---

## Infraestructura Redis

| Clave | Propósito | TTL |
|---|---|---|
| `wa:msg:{message_id}` | Dedup de webhook | 24h |
| `wa:replay:{message_id}` | Anti-replay | 10 min |
| `wa:flow:req:{hash}` | Cache de respuesta de /flow | 10 min |
| `flow:session:{flow_token}` | Sesión activa del flow | 1h (2h post-SUCCESS) |
| `rl:webhook:{phone_hash}` | Rate limit webhook | 60s |
| `rl:flow:{phone_hash}` | Rate limit flow | 60s |

**Circuit breaker Redis:** 3 fallos → OPEN → 15s → HALF_OPEN → 2 éxitos → CLOSED

---

## Despliegue (Railway)

1. Conectar repo a Railway
2. Agregar add-ons: **Redis** + **PostgreSQL**
3. Configurar variables de entorno en el dashboard
4. Para la clave privada RSA, usar Railway Secrets con `PRIVATE_KEY_PATH` o inline con `PRIVATE_KEY`
5. El health check del deployment debe apuntar a `/health/ready`
6. Mínimo **2 réplicas** para zero-downtime deploys

---

## Probar localmente (sin cifrado)

```bash
# Ping
curl -X POST http://localhost:3000/flow \
  -H "Content-Type: application/json" \
  -d '{"action":"ping"}'

# INIT
curl -X POST http://localhost:3000/flow \
  -H "Content-Type: application/json" \
  -d '{"version":"3.0","action":"INIT","flow_token":"tok_test_001"}'

# FORM con nombre válido
curl -X POST http://localhost:3000/flow \
  -H "Content-Type: application/json" \
  -d '{"version":"3.0","action":"data_exchange","screen":"FORM","flow_token":"tok_test_001","data":{"name":"Diego"}}'

# FORM con nombre vacío (validación)
curl -X POST http://localhost:3000/flow \
  -H "Content-Type: application/json" \
  -d '{"version":"3.0","action":"data_exchange","screen":"FORM","flow_token":"tok_test_001","data":{"name":""}}'

# CONFIRM → SUCCESS
curl -X POST http://localhost:3000/flow \
  -H "Content-Type: application/json" \
  -d '{"version":"3.0","action":"data_exchange","screen":"CONFIRM","flow_token":"tok_test_001","data":{"name":"Diego"}}'
```

---

## Disparar un flow desde WhatsApp

Envía el texto `flow` (o `formulario`) al número configurado. El backend detecta el keyword y llama a `sendFlow()` automáticamente.

---

## Stack

- Node.js ≥ 18
- Express 4
- ioredis 5
- pg 8
- Axios
- dotenv
- `crypto` nativo (sin librerías externas para cifrado)
