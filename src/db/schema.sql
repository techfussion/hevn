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
  followup_preference    TEXT NOT NULL DEFAULT 'active' CHECK (followup_preference IN ('active', 'relaxed', 'off')),
  quiet_hours_start      TEXT, -- e.g. '22:00'
  quiet_hours_end        TEXT, -- e.g. '07:00'
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (platform, platform_user_id)
);

CREATE TABLE IF NOT EXISTS projects (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id);

CREATE TABLE IF NOT EXISTS tasks (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title                    TEXT NOT NULL,
  due_at                   TIMESTAMPTZ NOT NULL,
  priority                 TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high')),
  status                   TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','done','missed')),
  task_type                TEXT NOT NULL DEFAULT 'task' CHECK (task_type IN ('task', 'commitment', 'reminder', 'recurring_checkin')),
  is_system_generated      BOOLEAN NOT NULL DEFAULT false,
  parent_task_id           UUID REFERENCES tasks(id) ON DELETE SET NULL,
  project_id               UUID REFERENCES projects(id) ON DELETE SET NULL,
  reminder_offset_minutes  INTEGER,
  reminder_sent_at         TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tasks_due_pending
  ON tasks (due_at)
  WHERE status IN ('pending', 'in_progress') AND reminder_sent_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_user_id ON tasks (user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_type ON tasks (user_id, task_type);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks (parent_task_id);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks (project_id);

CREATE TABLE IF NOT EXISTS follow_ups (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id          UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  scheduled_at     TIMESTAMPTZ NOT NULL,
  status           TEXT NOT NULL DEFAULT 'SCHEDULED' CHECK (status IN (
    'SCHEDULED', 'DUE', 'DELIVERED', 'WAITING_FOR_RESPONSE',
    'COMPLETED', 'NOT_YET', 'RESCHEDULED', 'SNOOZED', 'CANCELLED'
  )),
  attempt_count    INTEGER NOT NULL DEFAULT 0,
  max_attempts     INTEGER NOT NULL DEFAULT 3,
  last_attempt_at  TIMESTAMPTZ,
  delivered_at     TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ,
  cancelled_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_follow_ups_due
  ON follow_ups (scheduled_at)
  WHERE status IN ('SCHEDULED', 'DUE');

CREATE INDEX IF NOT EXISTS idx_follow_ups_user_status
  ON follow_ups (user_id, status);

CREATE INDEX IF NOT EXISTS idx_follow_ups_task
  ON follow_ups (task_id);

CREATE TABLE IF NOT EXISTS recurring_tasks (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title              TEXT NOT NULL,
  recurrence_pattern TEXT NOT NULL CHECK (recurrence_pattern IN ('daily', 'weekly', 'weekdays', 'custom')),
  days_of_week       INTEGER[],
  time_of_day        TEXT NOT NULL DEFAULT '09:00',
  timezone           TEXT NOT NULL DEFAULT 'UTC',
  priority           TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high')),
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'cancelled')),
  next_run_at        TIMESTAMPTZ NOT NULL,
  last_run_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_recurring_due
  ON recurring_tasks (next_run_at)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_recurring_user ON recurring_tasks (user_id);

CREATE TABLE IF NOT EXISTS user_memories (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category    TEXT NOT NULL DEFAULT 'general' CHECK (category IN ('fact', 'person', 'project', 'preference', 'general')),
  content     TEXT NOT NULL,
  key         TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_memories_user_cat ON user_memories (user_id, category);
CREATE INDEX IF NOT EXISTS idx_memories_user_key ON user_memories (user_id, key);

CREATE TABLE IF NOT EXISTS conversation_turns (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conversation_user_time
  ON conversation_turns (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS processed_updates (
  id          TEXT PRIMARY KEY,
  platform    TEXT NOT NULL CHECK (platform IN ('telegram', 'whatsapp')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_processed_updates_created_at
  ON processed_updates (created_at);

-- Auto-update updated_at on tasks, follow_ups, projects, recurring_tasks, user_memories
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

DROP TRIGGER IF EXISTS trg_follow_ups_updated_at ON follow_ups;
CREATE TRIGGER trg_follow_ups_updated_at
  BEFORE UPDATE ON follow_ups
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_recurring_tasks_updated_at ON recurring_tasks;
CREATE TRIGGER trg_recurring_tasks_updated_at
  BEFORE UPDATE ON recurring_tasks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_projects_updated_at ON projects;
CREATE TRIGGER trg_projects_updated_at
  BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_user_memories_updated_at ON user_memories;
CREATE TRIGGER trg_user_memories_updated_at
  BEFORE UPDATE ON user_memories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Row-Level Security
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE follow_ups ENABLE ROW LEVEL SECURITY;
ALTER TABLE recurring_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_memories ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS users_isolation ON users;
CREATE POLICY users_isolation ON users
  USING (id = current_setting('app.current_user_id', true)::uuid);

DROP POLICY IF EXISTS tasks_isolation ON tasks;
CREATE POLICY tasks_isolation ON tasks
  USING (user_id = current_setting('app.current_user_id', true)::uuid);

DROP POLICY IF EXISTS conversation_isolation ON conversation_turns;
CREATE POLICY conversation_isolation ON conversation_turns
  USING (user_id = current_setting('app.current_user_id', true)::uuid);

DROP POLICY IF EXISTS projects_isolation ON projects;
CREATE POLICY projects_isolation ON projects
  USING (user_id = current_setting('app.current_user_id', true)::uuid);

DROP POLICY IF EXISTS follow_ups_isolation ON follow_ups;
CREATE POLICY follow_ups_isolation ON follow_ups
  USING (user_id = current_setting('app.current_user_id', true)::uuid);

DROP POLICY IF EXISTS recurring_tasks_isolation ON recurring_tasks;
CREATE POLICY recurring_tasks_isolation ON recurring_tasks
  USING (user_id = current_setting('app.current_user_id', true)::uuid);

DROP POLICY IF EXISTS user_memories_isolation ON user_memories;
CREATE POLICY user_memories_isolation ON user_memories
  USING (user_id = current_setting('app.current_user_id', true)::uuid);
