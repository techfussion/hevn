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
  response_mode          TEXT NOT NULL DEFAULT 'auto' CHECK (response_mode IN ('text', 'voice', 'auto')),
  voice_enabled          BOOLEAN NOT NULL DEFAULT true,
  voice_name             TEXT,
  voice_language         TEXT,
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
-- Calendar Integration
CREATE TABLE IF NOT EXISTS calendar_accounts (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider                TEXT NOT NULL CHECK (provider IN ('google', 'caldav')),
  account_email           TEXT,
  encrypted_access_token  TEXT,
  encrypted_refresh_token TEXT,
  token_expires_at        TIMESTAMPTZ,
  auth_metadata           JSONB DEFAULT '{}'::jsonb,
  status                  TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'reauth_required', 'error', 'disconnected')),
  error_code              TEXT,
  error_message           TEXT,
  last_sync_at            TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider, account_email)
);

CREATE INDEX IF NOT EXISTS idx_calendar_accounts_user_id ON calendar_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_calendar_accounts_status ON calendar_accounts(status);

CREATE TABLE IF NOT EXISTS connected_calendars (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id            UUID NOT NULL REFERENCES calendar_accounts(id) ON DELETE CASCADE,
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  external_calendar_id  TEXT NOT NULL,
  name                  TEXT NOT NULL,
  color                 TEXT,
  is_primary            BOOLEAN NOT NULL DEFAULT false,
  is_selected_for_sync  BOOLEAN NOT NULL DEFAULT true,
  access_role           TEXT NOT NULL DEFAULT 'owner' CHECK (access_role IN ('owner', 'writer', 'reader')),
  sync_token            TEXT,
  last_sync_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, external_calendar_id)
);

CREATE INDEX IF NOT EXISTS idx_connected_calendars_user ON connected_calendars(user_id);
CREATE INDEX IF NOT EXISTS idx_connected_calendars_account ON connected_calendars(account_id);
CREATE INDEX IF NOT EXISTS idx_connected_calendars_sync ON connected_calendars(user_id, is_selected_for_sync);

CREATE TABLE IF NOT EXISTS calendar_event_links (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  calendar_id           UUID NOT NULL REFERENCES connected_calendars(id) ON DELETE CASCADE,
  task_id               UUID REFERENCES tasks(id) ON DELETE SET NULL,
  external_event_id     TEXT NOT NULL,
  external_event_etag   TEXT,
  sync_status           TEXT NOT NULL DEFAULT 'synced' CHECK (sync_status IN ('synced', 'pending_push', 'pending_pull', 'conflict', 'deleted')),
  last_synced_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (calendar_id, external_event_id)
);

CREATE INDEX IF NOT EXISTS idx_calendar_event_links_user ON calendar_event_links(user_id);
CREATE INDEX IF NOT EXISTS idx_calendar_event_links_task ON calendar_event_links(task_id);
CREATE INDEX IF NOT EXISTS idx_calendar_event_links_external ON calendar_event_links(calendar_id, external_event_id);

-- Auto-update updated_at on tasks, follow_ups, projects, recurring_tasks, user_memories, calendar_accounts, connected_calendars, calendar_event_links
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

DROP TRIGGER IF EXISTS trg_calendar_accounts_updated_at ON calendar_accounts;
CREATE TRIGGER trg_calendar_accounts_updated_at
  BEFORE UPDATE ON calendar_accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_connected_calendars_updated_at ON connected_calendars;
CREATE TRIGGER trg_connected_calendars_updated_at
  BEFORE UPDATE ON connected_calendars
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_calendar_event_links_updated_at ON calendar_event_links;
CREATE TRIGGER trg_calendar_event_links_updated_at
  BEFORE UPDATE ON calendar_event_links
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Row-Level Security
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE follow_ups ENABLE ROW LEVEL SECURITY;
ALTER TABLE recurring_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE connected_calendars ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_event_links ENABLE ROW LEVEL SECURITY;

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

DROP POLICY IF EXISTS calendar_accounts_isolation ON calendar_accounts;
CREATE POLICY calendar_accounts_isolation ON calendar_accounts
  USING (user_id = current_setting('app.current_user_id', true)::uuid);

DROP POLICY IF EXISTS connected_calendars_isolation ON connected_calendars;
CREATE POLICY connected_calendars_isolation ON connected_calendars
  USING (user_id = current_setting('app.current_user_id', true)::uuid);

DROP POLICY IF EXISTS calendar_event_links_isolation ON calendar_event_links;
CREATE POLICY calendar_event_links_isolation ON calendar_event_links
  USING (user_id = current_setting('app.current_user_id', true)::uuid);

-- ========================================================
-- Advanced Student Study Mode (P2.4)
-- ========================================================

-- Courses Table
CREATE TABLE IF NOT EXISTS courses (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  code         TEXT,
  description  TEXT,
  instructor   TEXT,
  institution  TEXT,
  semester     TEXT,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'archived')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_courses_user ON courses(user_id);
CREATE INDEX IF NOT EXISTS idx_courses_user_status ON courses(user_id, status);

-- Course Topics Table
CREATE TABLE IF NOT EXISTS course_topics (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id                UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  user_id                  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title                    TEXT NOT NULL,
  description              TEXT,
  ordering                 INTEGER NOT NULL DEFAULT 1,
  estimated_study_minutes  INTEGER NOT NULL DEFAULT 60,
  mastery_level            INTEGER NOT NULL DEFAULT 0 CHECK (mastery_level BETWEEN 0 AND 100),
  status                   TEXT NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started', 'in_progress', 'mastered')),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_course_topics_course ON course_topics(course_id);
CREATE INDEX IF NOT EXISTS idx_course_topics_user ON course_topics(user_id);
CREATE INDEX IF NOT EXISTS idx_course_topics_ordering ON course_topics(course_id, ordering);

-- Assessments Table
CREATE TABLE IF NOT EXISTS assessments (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id          UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title              TEXT NOT NULL,
  assessment_type    TEXT NOT NULL DEFAULT 'exam' CHECK (assessment_type IN ('exam', 'midterm', 'final', 'quiz', 'assignment', 'project')),
  due_at             TIMESTAMPTZ NOT NULL,
  weight_percentage  NUMERIC,
  linked_task_id     UUID REFERENCES tasks(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_assessments_course ON assessments(course_id);
CREATE INDEX IF NOT EXISTS idx_assessments_user_due ON assessments(user_id, due_at);

-- Study Plans Table
CREATE TABLE IF NOT EXISTS study_plans (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id             UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  assessment_id         UUID REFERENCES assessments(id) ON DELETE SET NULL,
  title                 TEXT NOT NULL,
  target_date           TIMESTAMPTZ NOT NULL,
  status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'archived')),
  total_planned_minutes INTEGER NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_study_plans_user ON study_plans(user_id);
CREATE INDEX IF NOT EXISTS idx_study_plans_course ON study_plans(course_id);

-- Study Sessions Table
CREATE TABLE IF NOT EXISTS study_sessions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  study_plan_id    UUID NOT NULL REFERENCES study_plans(id) ON DELETE CASCADE,
  course_id        UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  topic_id         UUID REFERENCES course_topics(id) ON DELETE SET NULL,
  task_id          UUID REFERENCES tasks(id) ON DELETE CASCADE,
  title            TEXT NOT NULL,
  scheduled_start  TIMESTAMPTZ NOT NULL,
  scheduled_end    TIMESTAMPTZ NOT NULL,
  planned_minutes  INTEGER NOT NULL DEFAULT 60,
  actual_minutes   INTEGER,
  status           TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'skipped', 'rescheduled')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_study_sessions_user_start ON study_sessions(user_id, scheduled_start);
CREATE INDEX IF NOT EXISTS idx_study_sessions_plan ON study_sessions(study_plan_id);
CREATE INDEX IF NOT EXISTS idx_study_sessions_topic ON study_sessions(topic_id);

-- Quizzes Table
CREATE TABLE IF NOT EXISTS quizzes (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id              UUID REFERENCES courses(id) ON DELETE CASCADE,
  topic_id               UUID REFERENCES course_topics(id) ON DELETE SET NULL,
  title                  TEXT NOT NULL,
  difficulty             TEXT NOT NULL DEFAULT 'medium' CHECK (difficulty IN ('easy', 'medium', 'hard')),
  questions              JSONB NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'CREATED' CHECK (status IN ('CREATED', 'ACTIVE', 'ANSWERING', 'COMPLETED', 'REVIEWED')),
  current_question_index INTEGER NOT NULL DEFAULT 0,
  score                  INTEGER NOT NULL DEFAULT 0,
  total_questions        INTEGER NOT NULL DEFAULT 0,
  answers                JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_quizzes_user_status ON quizzes(user_id, status);

-- Triggers
DROP TRIGGER IF EXISTS trg_courses_updated_at ON courses;
CREATE TRIGGER trg_courses_updated_at
  BEFORE UPDATE ON courses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_course_topics_updated_at ON course_topics;
CREATE TRIGGER trg_course_topics_updated_at
  BEFORE UPDATE ON course_topics
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_assessments_updated_at ON assessments;
CREATE TRIGGER trg_assessments_updated_at
  BEFORE UPDATE ON assessments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_study_plans_updated_at ON study_plans;
CREATE TRIGGER trg_study_plans_updated_at
  BEFORE UPDATE ON study_plans
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_study_sessions_updated_at ON study_sessions;
CREATE TRIGGER trg_study_sessions_updated_at
  BEFORE UPDATE ON study_sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_quizzes_updated_at ON quizzes;
CREATE TRIGGER trg_quizzes_updated_at
  BEFORE UPDATE ON quizzes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Study RLS Policies
ALTER TABLE courses ENABLE ROW LEVEL SECURITY;
ALTER TABLE course_topics ENABLE ROW LEVEL SECURITY;
ALTER TABLE assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE study_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE study_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE quizzes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS courses_isolation ON courses;
CREATE POLICY courses_isolation ON courses
  USING (user_id = current_setting('app.current_user_id', true)::uuid);

DROP POLICY IF EXISTS course_topics_isolation ON course_topics;
CREATE POLICY course_topics_isolation ON course_topics
  USING (user_id = current_setting('app.current_user_id', true)::uuid);

DROP POLICY IF EXISTS assessments_isolation ON assessments;
CREATE POLICY assessments_isolation ON assessments
  USING (user_id = current_setting('app.current_user_id', true)::uuid);

DROP POLICY IF EXISTS study_plans_isolation ON study_plans;
CREATE POLICY study_plans_isolation ON study_plans
  USING (user_id = current_setting('app.current_user_id', true)::uuid);

DROP POLICY IF EXISTS study_sessions_isolation ON study_sessions;
CREATE POLICY study_sessions_isolation ON study_sessions
  USING (user_id = current_setting('app.current_user_id', true)::uuid);

DROP POLICY IF EXISTS quizzes_isolation ON quizzes;
CREATE POLICY quizzes_isolation ON quizzes
  USING (user_id = current_setting('app.current_user_id', true)::uuid);

-- ============================================================
-- P2.5: Durable Job Queue & Notification Deduplication
-- ============================================================

CREATE TABLE IF NOT EXISTS job_queue (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_name       TEXT NOT NULL DEFAULT 'default',
  job_type         TEXT NOT NULL,
  user_id          UUID REFERENCES users(id) ON DELETE CASCADE,
  payload          JSONB NOT NULL DEFAULT '{}'::jsonb,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'completed', 'failed', 'cancelled')),
  idempotency_key  TEXT,
  singleton_key    TEXT,
  priority         INTEGER NOT NULL DEFAULT 0,
  attempts         INTEGER NOT NULL DEFAULT 0,
  max_attempts     INTEGER NOT NULL DEFAULT 5,
  run_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_until     TIMESTAMPTZ,
  locked_by        TEXT,
  last_error       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_job_queue_fetch
  ON job_queue (queue_name, run_at, priority DESC)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_job_queue_locked
  ON job_queue (locked_until)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_job_queue_user_status
  ON job_queue (user_id, status);

CREATE UNIQUE INDEX IF NOT EXISTS idx_job_queue_idempotency
  ON job_queue (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_job_queue_singleton
  ON job_queue (queue_name, singleton_key)
  WHERE status IN ('pending', 'active') AND singleton_key IS NOT NULL;

CREATE TRIGGER trg_job_queue_updated_at
  BEFORE UPDATE ON job_queue
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Atomic Notification Deduplication Log
CREATE TABLE IF NOT EXISTS notification_dedup_log (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dedup_key        TEXT NOT NULL,
  channel          TEXT NOT NULL,
  category         TEXT NOT NULL DEFAULT 'general',
  status           TEXT NOT NULL DEFAULT 'delivered' CHECK (status IN ('pending', 'delivered', 'suppressed', 'batched', 'deferred')),
  payload_summary  TEXT,
  delivered_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, dedup_key)
);

CREATE INDEX IF NOT EXISTS idx_notif_dedup_user_date
  ON notification_dedup_log (user_id, delivered_at DESC);

-- P2.5 RLS Policies
ALTER TABLE job_queue ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS job_queue_tenant_isolation ON job_queue;
CREATE POLICY job_queue_tenant_isolation ON job_queue
  FOR ALL
  USING (
    user_id IS NULL OR user_id = current_setting('app.current_user_id', true)::uuid
  );

ALTER TABLE notification_dedup_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notif_dedup_tenant_isolation ON notification_dedup_log;
CREATE POLICY notif_dedup_tenant_isolation ON notification_dedup_log
  FOR ALL
  USING (
    user_id = current_setting('app.current_user_id', true)::uuid
  );



