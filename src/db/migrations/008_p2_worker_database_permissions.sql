-- Migration 008: P2.5.1 Background Worker Database Permissions, User Identity & Least-Privilege RLS
-- Safe, fully idempotent, non-destructive, and resilient for Supabase and PostgreSQL deployments.

-- 1. Ensure required extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 2. User Conversational Identity Enhancements
ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS nameless_mode BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower
  ON users (LOWER(username))
  WHERE username IS NOT NULL;

-- 3. Ensure core base tables exist with Row-Level Security explicitly enabled
CREATE TABLE IF NOT EXISTS conversation_turns (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE conversation_turns ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS processed_updates (
  id          TEXT PRIMARY KEY,
  platform    TEXT NOT NULL CHECK (platform IN ('telegram', 'whatsapp')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE processed_updates ENABLE ROW LEVEL SECURITY;

-- Ensure RLS on conversation_turns
DROP POLICY IF EXISTS conversation_turns_isolation ON conversation_turns;
CREATE POLICY conversation_turns_isolation ON conversation_turns
  USING (user_id = current_setting('app.current_user_id', true)::uuid);

-- 4. Ensure scheduler_service role exists idempotently
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'scheduler_service') THEN
    CREATE ROLE scheduler_service WITH LOGIN;
  END IF;
END
$$;

-- 5. Schema & Sequence Privileges
GRANT USAGE ON SCHEMA public TO scheduler_service;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO scheduler_service;

-- Explicitly protect internal scheduler tables from anon client access
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE job_queue FROM anon;
    REVOKE ALL ON TABLE notification_dedup_log FROM anon;
    REVOKE ALL ON TABLE follow_ups FROM anon;
  END IF;
END
$$;

-- 6. Dynamic & Resilient Least-Privilege Table Grants for scheduler_service
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN (
        'job_queue', 'follow_ups', 'tasks', 'recurring_tasks',
        'notification_dedup_log', 'calendar_accounts', 'connected_calendars',
        'calendar_event_links', 'users', 'user_memories', 'projects',
        'courses', 'course_topics', 'assessments', 'study_plans',
        'study_sessions', 'quizzes', 'processed_updates', 'conversation_turns'
      )
  LOOP
    IF r.table_name IN ('job_queue', 'connected_calendars', 'calendar_event_links') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO scheduler_service', r.table_name);
    ELSIF r.table_name IN ('follow_ups', 'tasks', 'notification_dedup_log', 'processed_updates') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE ON TABLE public.%I TO scheduler_service', r.table_name);
    ELSIF r.table_name IN ('recurring_tasks', 'calendar_accounts', 'users') THEN
      EXECUTE format('GRANT SELECT, UPDATE ON TABLE public.%I TO scheduler_service', r.table_name);
    ELSE
      EXECUTE format('GRANT SELECT ON TABLE public.%I TO scheduler_service', r.table_name);
    END IF;
  END LOOP;
END
$$;

-- 7. Dynamic & Resilient Worker Row-Level Security (RLS) Policies
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN (
        'job_queue', 'follow_ups', 'tasks', 'recurring_tasks',
        'notification_dedup_log', 'calendar_accounts', 'connected_calendars',
        'calendar_event_links', 'users', 'user_memories', 'projects',
        'courses', 'course_topics', 'assessments', 'study_plans',
        'study_sessions', 'quizzes', 'conversation_turns', 'processed_updates'
      )
  LOOP
    -- Ensure RLS is active
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.table_name);

    -- Drop existing policy if present and recreate targeted strictly to scheduler_service
    EXECUTE format('DROP POLICY IF EXISTS scheduler_worker_access_%I ON public.%I', r.table_name, r.table_name);
    EXECUTE format('CREATE POLICY scheduler_worker_access_%I ON public.%I FOR ALL TO scheduler_service USING (true) WITH CHECK (true)', r.table_name, r.table_name);
  END LOOP;
END
$$;
