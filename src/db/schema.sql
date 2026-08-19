-- Hevn schema
-- Run in the Supabase SQL editor, or via `psql $DATABASE_URL -f schema.sql`

CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- for gen_random_uuid()

CREATE TABLE IF NOT EXISTS users (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform               TEXT NOT NULL CHECK (platform IN ('telegram', 'whatsapp')),
  platform_user_id       TEXT NOT NULL,
  display_name           TEXT,
  timezone               TEXT NOT NULL DEFAULT 'UTC',
  onboarded              BOOLEAN NOT NULL DEFAULT false,
  onboarding_state       TEXT NOT NULL DEFAULT 'WELCOME' CHECK (onboarding_state IN ('WELCOME', 'AWAITING_NAME', 'AWAITING_ASSISTANT_NAME', 'AWAITING_PERSONA', 'AWAITING_CHECKIN_TIME', 'COMPLETED')),
  assistant_name         TEXT NOT NULL DEFAULT 'Hevn',
  bot_persona            TEXT NOT NULL DEFAULT 'Hevn', -- alias for backwards compatibility
  persona                TEXT NOT NULL DEFAULT 'professional' CHECK (persona IN ('student', 'executive_assistant', 'professional')),
  preferred_checkin_time TEXT NOT NULL DEFAULT '06:00',
  preferred_checkin_hour INTEGER NOT NULL DEFAULT 6 CHECK (preferred_checkin_hour BETWEEN 0 AND 23),
  plan                   TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro')),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (platform, platform_user_id)
);

CREATE TABLE IF NOT EXISTS tasks (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title                    TEXT NOT NULL,
  due_at                   TIMESTAMPTZ NOT NULL,
  priority                 TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high')),
  status                   TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','done','missed')),
  task_type                TEXT NOT NULL DEFAULT 'task' CHECK (task_type IN ('task', 'commitment', 'reminder', 'recurring_checkin')),
  is_system_generated      BOOLEAN NOT NULL DEFAULT false,
  reminder_offset_minutes  INTEGER,
  reminder_sent_at         TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Engine polls this heavily; index keeps the scheduler query cheap.
CREATE INDEX IF NOT EXISTS idx_tasks_due_pending
  ON tasks (due_at)
  WHERE status IN ('pending', 'in_progress') AND reminder_sent_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_user_id ON tasks (user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_type ON tasks (user_id, task_type);


-- Short rolling conversation buffer for context (last N turns per user).
-- Deliberately NOT a full transcript store — capped and prunable, since
-- we don't want to retain full chat history indefinitely (data minimization).
CREATE TABLE IF NOT EXISTS conversation_turns (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conversation_user_time
  ON conversation_turns (user_id, created_at DESC);

-- Webhook deduplication table to ensure idempotency against network retries
CREATE TABLE IF NOT EXISTS processed_updates (
  id          TEXT PRIMARY KEY, -- e.g. 'telegram:123456' or 'whatsapp:wamid.HBgL...'
  platform    TEXT NOT NULL CHECK (platform IN ('telegram', 'whatsapp')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_processed_updates_created_at
  ON processed_updates (created_at);

-- Auto-update updated_at on tasks
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tasks_updated_at ON tasks;
CREATE TRIGGER trg_tasks_updated_at
  BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Row-Level Security: defense in depth so a bug in application code
-- can't leak one user's tasks to another, even via a raw query.
-- The app connects as a role that must set app.current_user_id per request
-- (see src/db/pool.ts). This is a safety net, not the primary access control
-- — the primary control is that TaskService always scopes queries by user_id.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_turns ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS users_isolation ON users;
CREATE POLICY users_isolation ON users
  USING (id = current_setting('app.current_user_id', true)::uuid);

DROP POLICY IF EXISTS tasks_isolation ON tasks;
CREATE POLICY tasks_isolation ON tasks
  USING (user_id = current_setting('app.current_user_id', true)::uuid);

DROP POLICY IF EXISTS conversation_isolation ON conversation_turns;
CREATE POLICY conversation_isolation ON conversation_turns
  USING (user_id = current_setting('app.current_user_id', true)::uuid);

