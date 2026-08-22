-- Migration 002: Hevn P1 Follow-Through Engine, Recurring Workflows, Structured Memory, and Projects
-- Safe to execute idempotently on existing databases

-- 1. Projects
CREATE TABLE IF NOT EXISTS projects (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id);

-- 2. Extend tasks table
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS parent_task_id UUID REFERENCES tasks(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);

-- 3. Follow-Ups table
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

-- 4. Recurring Tasks table
CREATE TABLE IF NOT EXISTS recurring_tasks (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title              TEXT NOT NULL,
  recurrence_pattern TEXT NOT NULL CHECK (recurrence_pattern IN ('daily', 'weekly', 'weekdays', 'custom')),
  days_of_week       INTEGER[], -- e.g. [1] for Mon, [1,2,3,4,5] for weekdays
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

-- 5. Structured User Memory
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

-- 6. User Preferences enhancements
ALTER TABLE users ADD COLUMN IF NOT EXISTS followup_preference TEXT NOT NULL DEFAULT 'active' CHECK (followup_preference IN ('active', 'relaxed', 'off'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS quiet_hours_start TEXT; -- e.g. '22:00'
ALTER TABLE users ADD COLUMN IF NOT EXISTS quiet_hours_end TEXT;   -- e.g. '07:00'

-- 7. Row Level Security for new tables
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE follow_ups ENABLE ROW LEVEL SECURITY;
ALTER TABLE recurring_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_memories ENABLE ROW LEVEL SECURITY;

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
