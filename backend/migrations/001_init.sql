-- ==========================================================================
-- 001_init.sql — BuildMind core schema
--
-- Rules encoded here rather than in application code where the database can
-- enforce them:
--   * every user-owned row carries user_id, and every read is scoped by it
--   * provider credentials live in their own table, never on projects/builds
--   * build_events carry no free-form payload that could hold a secret
--   * status values are constrained, so the row cannot claim a state the
--     state machine does not know about
-- ==========================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- users ----
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL,
  email_lower   TEXT NOT NULL GENERATED ALWAYS AS (lower(email)) STORED,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT users_email_unique UNIQUE (email_lower)
);

-- ------------------------------------------------------------- sessions ----
-- Only a hash of the session token is stored. A database leak does not
-- yield usable session cookies.
CREATE TABLE sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ
);

CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expiry_idx ON sessions (expires_at);

-- -------------------------------------------------------------- projects ---
CREATE TABLE projects (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  prompt      TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'draft',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_build_at TIMESTAMPTZ,
  CONSTRAINT projects_status_valid CHECK (
    status IN ('draft','ready','queued','building','testing','fixing',
               'validating','complete','stopped','error')
  )
);

CREATE INDEX projects_user_idx ON projects (user_id, updated_at DESC);

-- ---------------------------------------------------------------- builds ---
CREATE TABLE builds (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  run_id        UUID NOT NULL DEFAULT gen_random_uuid(),
  status        TEXT NOT NULL DEFAULT 'queued',
  current_stage TEXT,
  progress      SMALLINT NOT NULL DEFAULT 0,
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  -- Retry chain: which build this one re-runs, if any.
  retry_of      UUID REFERENCES builds(id) ON DELETE SET NULL,
  started_at    TIMESTAMPTZ,
  ended_at      TIMESTAMPTZ,
  cancel_requested_at TIMESTAMPTZ,
  error_code    TEXT,
  error_message_safe TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT builds_status_valid CHECK (
    status IN ('queued','preparing','understanding','planning','building',
               'testing','fixing','validating','complete','failed',
               'cancelled')
  ),
  CONSTRAINT builds_progress_range CHECK (progress >= 0 AND progress <= 100)
);

CREATE INDEX builds_project_idx ON builds (project_id, created_at DESC);
CREATE INDEX builds_user_idx ON builds (user_id, created_at DESC);
CREATE INDEX builds_active_idx ON builds (status)
  WHERE status NOT IN ('complete','failed','cancelled');

-- ---------------------------------------------------------- build_events ---
-- Safe operational events only. The column list is deliberately narrow: there
-- is no jsonb payload column, so a secret cannot be smuggled into an event.
CREATE TABLE build_events (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  build_id    UUID NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  run_id      UUID NOT NULL,
  seq         INTEGER NOT NULL,
  stage       TEXT,
  status      TEXT NOT NULL,
  progress    SMALLINT NOT NULL DEFAULT 0,
  activity    TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT build_events_stage_valid CHECK (
    stage IS NULL OR stage IN ('understanding','planning','building','testing',
                               'fixing','validating','complete')
  )
);

CREATE INDEX build_events_build_idx ON build_events (build_id, seq);
CREATE INDEX build_events_created_idx ON build_events (created_at);

-- --------------------------------------------------- provider_credentials ---
-- BYOK keys, encrypted at rest with AES-256-GCM under ENCRYPTION_KEY.
-- Kept in their own table so that a project or build row can never carry one,
-- and so the whole table can be dropped/purged independently.
CREATE TABLE provider_credentials (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider    TEXT NOT NULL,
  -- ciphertext, iv and auth tag are stored separately and never joined
  ciphertext  BYTEA NOT NULL,
  iv          BYTEA NOT NULL,
  auth_tag    BYTEA NOT NULL,
  key_hint    TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  expires_at  TIMESTAMPTZ NOT NULL,
  CONSTRAINT provider_credentials_unique UNIQUE (user_id, provider)
);

CREATE INDEX provider_credentials_user_idx ON provider_credentials (user_id);

-- ------------------------------------------------------- roblox_accounts ---
CREATE TABLE roblox_accounts (
  user_id       UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  roblox_user_id TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  scopes        TEXT NOT NULL DEFAULT '',
  connected_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ,
  -- Access/refresh tokens are encrypted exactly like BYOK keys.
  ciphertext    BYTEA NOT NULL,
  iv            BYTEA NOT NULL,
  auth_tag      BYTEA NOT NULL
);

-- ------------------------------------------------------- studio_sessions ---
-- A Studio plugin registers here, then must authenticate every message.
CREATE TABLE studio_sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,
  protocol_version INTEGER NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ
);

CREATE INDEX studio_sessions_user_idx ON studio_sessions (user_id);
