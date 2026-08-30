-- Migration 008: P2.5.1 Background Worker Database Permissions & Least-Privilege RLS Policies
-- Grants exact required table privileges and targeted RLS policies for scheduler_service.
-- Normal application traffic continues enforcing tenant isolation via app.current_user_id.

-- 1. Ensure scheduler_service role exists idempotently
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'scheduler_service') THEN
    CREATE ROLE scheduler_service WITH LOGIN;
  END IF;
END
$$;

-- 2. Schema Usage
GRANT USAGE ON SCHEMA public TO scheduler_service;

-- 3. Exact Table Privileges (Least Privilege on Canonical Tables)
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE job_queue TO scheduler_service;
GRANT SELECT, INSERT, UPDATE ON TABLE follow_ups TO scheduler_service;
GRANT SELECT, INSERT, UPDATE ON TABLE tasks TO scheduler_service;
GRANT SELECT, UPDATE ON TABLE recurring_tasks TO scheduler_service;
GRANT SELECT, INSERT, UPDATE ON TABLE notification_dedup_log TO scheduler_service;
GRANT SELECT, UPDATE ON TABLE calendar_accounts TO scheduler_service;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE connected_calendars TO scheduler_service;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE calendar_event_links TO scheduler_service;

-- Read-only tables needed for notification evaluation, daily briefings, and study mode
GRANT SELECT ON TABLE users TO scheduler_service;
GRANT SELECT ON TABLE user_memories TO scheduler_service;
GRANT SELECT ON TABLE projects TO scheduler_service;
GRANT SELECT ON TABLE courses TO scheduler_service;
GRANT SELECT ON TABLE course_topics TO scheduler_service;
GRANT SELECT ON TABLE assessments TO scheduler_service;
GRANT SELECT ON TABLE study_plans TO scheduler_service;
GRANT SELECT ON TABLE study_sessions TO scheduler_service;
GRANT SELECT ON TABLE quizzes TO scheduler_service;
GRANT SELECT, INSERT ON TABLE processed_updates TO scheduler_service;
GRANT SELECT ON TABLE conversation_turns TO scheduler_service;

-- Sequence permissions for auto-generated IDs where applicable
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO scheduler_service;

-- 4. Worker Row-Level Security (RLS) Policies
-- These policies apply strictly TO scheduler_service, allowing the background scheduler
-- to perform cross-user job claiming, follow-ups, and calendar sync without disabling RLS.

-- Job Queue
DROP POLICY IF EXISTS scheduler_worker_access_job_queue ON job_queue;
CREATE POLICY scheduler_worker_access_job_queue ON job_queue
  FOR ALL TO scheduler_service USING (true) WITH CHECK (true);

-- Follow-Ups
DROP POLICY IF EXISTS scheduler_worker_access_follow_ups ON follow_ups;
CREATE POLICY scheduler_worker_access_follow_ups ON follow_ups
  FOR ALL TO scheduler_service USING (true) WITH CHECK (true);

-- Tasks
DROP POLICY IF EXISTS scheduler_worker_access_tasks ON tasks;
CREATE POLICY scheduler_worker_access_tasks ON tasks
  FOR ALL TO scheduler_service USING (true) WITH CHECK (true);

-- Recurring Tasks
DROP POLICY IF EXISTS scheduler_worker_access_recurring ON recurring_tasks;
CREATE POLICY scheduler_worker_access_recurring ON recurring_tasks
  FOR ALL TO scheduler_service USING (true) WITH CHECK (true);

-- Notification Deduplication Log
DROP POLICY IF EXISTS scheduler_worker_access_dedup ON notification_dedup_log;
CREATE POLICY scheduler_worker_access_dedup ON notification_dedup_log
  FOR ALL TO scheduler_service USING (true) WITH CHECK (true);

-- Calendar Integration
DROP POLICY IF EXISTS scheduler_worker_access_cal_accounts ON calendar_accounts;
CREATE POLICY scheduler_worker_access_cal_accounts ON calendar_accounts
  FOR ALL TO scheduler_service USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS scheduler_worker_access_conn_cals ON connected_calendars;
CREATE POLICY scheduler_worker_access_conn_cals ON connected_calendars
  FOR ALL TO scheduler_service USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS scheduler_worker_access_cal_events ON calendar_event_links;
CREATE POLICY scheduler_worker_access_cal_events ON calendar_event_links
  FOR ALL TO scheduler_service USING (true) WITH CHECK (true);

-- Read-only briefing, domain, and study mode tables for worker
DROP POLICY IF EXISTS scheduler_worker_access_users ON users;
CREATE POLICY scheduler_worker_access_users ON users
  FOR SELECT TO scheduler_service USING (true);

DROP POLICY IF EXISTS scheduler_worker_access_memories ON user_memories;
CREATE POLICY scheduler_worker_access_memories ON user_memories
  FOR SELECT TO scheduler_service USING (true);

DROP POLICY IF EXISTS scheduler_worker_access_projects ON projects;
CREATE POLICY scheduler_worker_access_projects ON projects
  FOR SELECT TO scheduler_service USING (true);

DROP POLICY IF EXISTS scheduler_worker_access_courses ON courses;
CREATE POLICY scheduler_worker_access_courses ON courses
  FOR SELECT TO scheduler_service USING (true);

DROP POLICY IF EXISTS scheduler_worker_access_course_topics ON course_topics;
CREATE POLICY scheduler_worker_access_course_topics ON course_topics
  FOR SELECT TO scheduler_service USING (true);

DROP POLICY IF EXISTS scheduler_worker_access_assessments ON assessments;
CREATE POLICY scheduler_worker_access_assessments ON assessments
  FOR SELECT TO scheduler_service USING (true);

DROP POLICY IF EXISTS scheduler_worker_access_study_plans ON study_plans;
CREATE POLICY scheduler_worker_access_study_plans ON study_plans
  FOR SELECT TO scheduler_service USING (true);

DROP POLICY IF EXISTS scheduler_worker_access_study_sessions ON study_sessions;
CREATE POLICY scheduler_worker_access_study_sessions ON study_sessions
  FOR SELECT TO scheduler_service USING (true);

DROP POLICY IF EXISTS scheduler_worker_access_quizzes ON quizzes;
CREATE POLICY scheduler_worker_access_quizzes ON quizzes
  FOR SELECT TO scheduler_service USING (true);
