
# Arquitectura y Funcionamiento — WhatsApp Flow Backend

## Contexto y Objetivo

**OBJETIVO:** Crear un chatbot o inteligencia artificial para el sector Proptech y Bienes Raíces.

- **Empresa:** Fliphouse
- **Sector:** Proptech y Bienes Raíces
- **Administrador de WhatsApp:** Sofí de Fliphouse
- **WAPI:**
  - Identificador: 1563044718885403
  - Número: 🇲🇽 ‎+52 1 871 578 6874
  - Identificador de número de teléfono: 1003582039515911
- **Meta App:** Fliphouse Flows
  - Identificador: 1945045596221320
- **Lógica de Flujos:** Make (Integromat)
- **BackEnd:** Railway — whatsapp-flow-backend-production.up.railway.app
- **Redis:** redis-production-8cbb.up.railway.app
- **Proxy:** monorail.proxy.rlwy.net:46935

Este sistema permite automatizar la atención, gestión de leads y flujos conversacionales en WhatsApp, integrando lógica personalizada y conectividad con herramientas de negocio.


## Resumen General

Este backend implementa una API y servicios para gestionar flujos conversacionales de WhatsApp, integrando lógica de negocio, almacenamiento, seguridad y comunicación con la API de WhatsApp Cloud. El sistema está construido sobre Express.js y sigue una arquitectura modular, separando rutas, controladores, servicios, middlewares y utilidades.

## Diagrama de Alto Nivel

```mermaid
graph TD
  UI[Inbox UI (public/inbox.html)]
  subgraph API
    A[Express App (app.js)]
    R1[/api (conversations.js)]
    R2[/webhook (webhook.js)]
    R3[/flow (flow.js)]
    R4[/send-message (sendMessage.js)]
    R5[/send-flow (sendFlow.js)]
  end
  subgraph Middlewares
    M1[internalAuth]
    M2[errorHandler]
    M3[rateLimiter]
    M4[signatureVerification]
  end
  subgraph Services
    S1[whatsappApi]
    S2[sessionRepository]
    S3[stateMachine]
    S4[encryption]
    S5[idempotency]
    S6[pgPool (Postgres)]
  end
  subgraph Infra
    DB[(Postgres)]
    REDIS[(Redis)]
  end
  UI-->|HTTP|A
  A-->|static|UI
  A-->|/api|R1
  A-->|/webhook|R2
  A-->|/flow|R3
  A-->|/send-message|R4
  A-->|/send-flow|M1-->|auth ok|R5
  R1-->|logic|S2
  R2-->|webhook|S1
  R3-->|flows|S3
  R4-->|send|S1
  R5-->|send flow|S1
  S2-->|sessions|REDIS
  S3-->|state|REDIS
  S6-->|queries|DB
  S1-->|API calls|WhatsAppCloudAPI
```

## Principales Flujos y Procesos

### 1. Recepción de Webhooks
- WhatsApp envía eventos a `/webhook`.
- Se verifica la firma (HMAC) y se procesa el evento.
- Se actualiza el estado de la conversación y se responde según el flujo.

### 2. Envío de Mensajes y Flows
- Rutas `/send-message` y `/send-flow` permiten enviar mensajes o flujos a usuarios.
- `/send-flow` requiere autenticación interna (`internalAuth`).
- Se utiliza el servicio `whatsappApi` para interactuar con la API de WhatsApp.

### 3. Gestión de Conversaciones
- Rutas bajo `/api` permiten consultar y manipular conversaciones activas.
- Se usa `sessionRepository` y Redis para almacenar el estado de cada sesión.

### 4. Health Checks
- `/health/live`: Verifica que el proceso está vivo.
- `/health/ready`: Verifica conectividad con Redis y Postgres.
- `/health/key-check`: (Debug) Verifica carga de clave privada.

### 5. Seguridad y Middleware
- `internalAuth`: Protege rutas internas.
- `rateLimiter`: Limita la tasa de peticiones.
- `signatureVerification`: Verifica firmas de webhooks.
- `errorHandler`: Manejo centralizado de errores.

## Estructura de Carpetas Clave

- `src/routes/` — Define las rutas Express.
- `src/controllers/` — Lógica de controladores para cada endpoint.
- `src/services/` — Servicios de negocio, acceso a datos, integración con WhatsApp, etc.
- `src/lib/` — Utilidades como Redis, circuit breaker, TTL map.
- `src/middleware/` — Middlewares de seguridad, autenticación, rate limiting, etc.
- `public/` — UI estática para inbox y recursos web.
- `utils/` — Scripts utilitarios (ej: generación de claves).
- `templates/` — Plantillas de flujos JSON.

## Notas
- El backend es extensible: se pueden agregar nuevos flujos, controladores o servicios según necesidades.
- Redis se usa para sesiones y control de estado rápido; Postgres para persistencia estructurada.
- El sistema está preparado para escalar y proteger endpoints críticos.

---

> Este documento resume la arquitectura y funcionamiento general del backend. Para detalles de endpoints, ver los archivos en `src/routes/` y los controladores asociados.
