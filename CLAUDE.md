# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development
npm run dev          # nodemon server.js (auto-reload)
npm start            # node server.js (production)

# Key generation (RSA key pair for Flow encryption)
npm run generate-keys

# Database migration
npm run db:migrate   # requires DATABASE_URL env var
```

There is no test suite configured. The app is tested via the running server and Meta's Flow Builder sandbox.

## Architecture

Express app split across two entry points:
- **`server.js`** — binds the port, starts the HTTP server
- **`app.js`** — registers all middleware and routes (importable without binding a port)

### Route → Controller → Service flow

| Route | Controller | Purpose |
|-------|-----------|---------|
| `POST /flow` | `flowController.handleFlowRequest` | WhatsApp Flow Endpoint (Meta calls this) |
| `POST /webhook` | `webhookController` | Incoming WA messages + Meta verification |
| `POST /send-message` | `sendMessageController` | Triggered by Make.com to send a WA message |
| `POST /send-flow` | `sendFlow` route (internalAuth middleware) | Triggered by Make.com to send a WA Flow |
| `GET /api/conversations` | `conversations` route | Inbox UI data |

### Flow Endpoint pipeline (`/flow`)

The most complex path. `flowController.js` orchestrates 10 steps in order:
1. Detect if payload is RSA-encrypted (`encrypted_flow_data` field)
2. Decrypt with private key (→ 421 on failure)
3. Anti-reuse: reject `flow_token` already marked COMPLETED
4. Idempotency: return cached response if exists (Redis)
5. Get/create session in Redis
6. Run `stateMachine.processFlowRequest()` with 7s timeout
7. Persist screen transition in Redis (optimistic locking via WATCH/MULTI/EXEC)
8. Encrypt response
9. Cache encrypted response
10. Respond

The private key is read once and cached in-memory (`_cachedPrivateKey`). Set via `PRIVATE_KEY_PATH` (file) or `PRIVATE_KEY` (inline with `\n` escaped).

### State machine (`src/services/stateMachine.js`)

Handles actions: `ping`, `INIT`, `data_exchange`, `BACK`, `error`.

Current flow is **Fliphouse** (property valuation):
- `INIT` → returns `WELCOME` screen with city/state/colonias/logo
- `data_exchange` on `VALUE` screen → calculates 20–30% advance range → returns `ESTIMATE`
- `data_exchange` on `SUMMARY` screen → returns `COMPLETE_YES` or `COMPLETE_NO` + fires Make.com webhook async

### Session storage (dual-layer)

- **Redis** (`flow:session:{flow_token}` HASH, TTL 1h) — live session state during flow execution
- **Postgres** (`flow_completions` table) — permanent record on completion

`sessionRepository.js` exposes: `create`, `get`, `transition`, `complete`, `abandon`, `isCompleted`. `transition()` uses Redis WATCH/MULTI/EXEC for optimistic locking; `flowController` retries once on `OptimisticLockError`.

### Redis resilience

`src/lib/redisClient.js` wraps ioredis with a circuit breaker (`src/lib/circuitBreaker.js`). All Redis calls go through `safeRedis(fn, fallback)` — if Redis is down, the fallback runs instead of crashing.

### Make.com integration

Two directions:
- **Inbound**: Make.com receives WA messages via `MAKE_WA_INBOUND_URL`, processes them, and calls `POST /send-message` or `POST /send-flow` back with `MAKE_SECRET` or `INTERNAL_API_TOKEN` auth.
- **Outbound**: When a flow completes (`SUMMARY` data_exchange or `nextScreen === 'SUCCESS'`), the backend fires `MAKE_WEBHOOK_URL` async (fire-and-forget, does not block the Meta response).

## Environment variables

See `.env.example` for all required variables. Key ones:

- `API_TOKEN` — WhatsApp Cloud API system user token
- `BUSINESS_PHONE` — Phone Number ID (not the phone number itself)
- `PRIVATE_KEY_PATH` or `PRIVATE_KEY` — RSA private key for Flow encryption
- `MAKE_SECRET` — shared secret for `POST /send-message` (header: `x-make-secret`)
- `INTERNAL_API_TOKEN` — shared secret for `POST /send-flow` (header: `x-internal-token`)
- `MAKE_WEBHOOK_URL` — Make.com webhook URL for completed flow events
- `REDIS_TLS=true` — required on Railway/Upstash
- `DATABASE_SSL=true` — required on Railway/Fly.io/Render

## Health endpoints

- `GET /health/live` — liveness (process alive)
- `GET /health/ready` — readiness (Redis + Postgres reachable)
- `GET /health/key-check` — debug: verifies private key loads correctly (remove before final prod hardening)
