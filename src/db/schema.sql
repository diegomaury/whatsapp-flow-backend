-- ──────────────────────────────────────────────────────────────────────────────
-- schema.sql
-- Schema mínimo para WhatsApp Flow Backend
-- Ejecutar: psql $DATABASE_URL -f src/db/schema.sql
-- ──────────────────────────────────────────────────────────────────────────────

-- Extensión para UUID
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ──────────────────────────────────────────────────────────────────────────────
-- flow_completions
-- Registro permanente de flows completados exitosamente.
-- El estado activo vive en Redis; esto es la fuente de verdad de negocio.
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS flow_completions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    flow_token      TEXT NOT NULL,
    phone_number    TEXT NOT NULL,                    -- E.164 sin "+"
    flow_id         TEXT NOT NULL,                    -- ID del Flow en Meta
    captured_data   JSONB NOT NULL DEFAULT '{}',      -- Datos capturados en el flow
    completed_at    TIMESTAMPTZ NOT NULL,
    duration_ms     INTEGER,                          -- Duración total de la sesión

    CONSTRAINT flow_completions_flow_token_unique UNIQUE (flow_token)
);

-- Índices de consulta frecuente
CREATE INDEX IF NOT EXISTS idx_flow_completions_phone
    ON flow_completions (phone_number);

CREATE INDEX IF NOT EXISTS idx_flow_completions_flow_id
    ON flow_completions (flow_id);

CREATE INDEX IF NOT EXISTS idx_flow_completions_completed_at
    ON flow_completions (completed_at DESC);

-- ──────────────────────────────────────────────────────────────────────────────
-- webhook_events
-- Log de eventos de webhook para auditoría y debugging.
-- Opcional pero muy útil para reproducir bugs.
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS webhook_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id      TEXT NOT NULL,
    phone_number    TEXT NOT NULL,
    event_type      TEXT NOT NULL,       -- 'text' | 'interactive' | 'status' | etc.
    payload_hash    TEXT,                -- SHA-256 del payload (para dedup sin guardar PII)
    processed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    status          TEXT NOT NULL DEFAULT 'processed' -- 'processed' | 'duplicate' | 'error'
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_message_id
    ON webhook_events (message_id);

CREATE INDEX IF NOT EXISTS idx_webhook_events_phone
    ON webhook_events (phone_number);

CREATE INDEX IF NOT EXISTS idx_webhook_events_processed_at
    ON webhook_events (processed_at DESC);

-- ──────────────────────────────────────────────────────────────────────────────
-- Comentarios
-- ──────────────────────────────────────────────────────────────────────────────
COMMENT ON TABLE flow_completions IS 'Registro permanente de flows completados. El estado activo está en Redis.';
COMMENT ON TABLE webhook_events IS 'Log de auditoría de eventos de webhook recibidos.';

COMMENT ON COLUMN flow_completions.flow_token   IS 'Token único de sesión enviado por el backend al abrir el flow.';
COMMENT ON COLUMN flow_completions.phone_number IS 'Número en formato E.164 sin el símbolo +.';
COMMENT ON COLUMN flow_completions.captured_data IS 'JSON con todos los datos capturados durante el flow (nombre, etc.).';
COMMENT ON COLUMN flow_completions.duration_ms  IS 'Milisegundos entre creación de sesión y completion.';

-- ──────────────────────────────────────────────────────────────────────────────
-- messages
-- Inbox de conversaciones WhatsApp (mensajes entrantes y salientes).
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
  id              SERIAL PRIMARY KEY,
  conversation_id VARCHAR(50)  NOT NULL,
  phone           VARCHAR(20)  NOT NULL,
  lead_name       VARCHAR(100) DEFAULT 'Sin nombre',
  direction       VARCHAR(3)   NOT NULL CHECK (direction IN ('in', 'out')),
  content         TEXT         NOT NULL,
  message_type    VARCHAR(20)  DEFAULT 'text',
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages (conversation_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_messages_latest          ON messages (created_at DESC);
