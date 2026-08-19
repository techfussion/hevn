-- Migration 001: Add conversational onboarding state machine, assistant names, personas, check-in times, and task types
-- Safe to execute idempotently on existing databases

ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_state TEXT NOT NULL DEFAULT 'WELCOME';
ALTER TABLE users ADD COLUMN IF NOT EXISTS assistant_name TEXT NOT NULL DEFAULT 'Hevn';
ALTER TABLE users ADD COLUMN IF NOT EXISTS persona TEXT NOT NULL DEFAULT 'professional';
ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_checkin_time TEXT NOT NULL DEFAULT '06:00';
ALTER TABLE users ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'free';

-- Backfill onboarding_state for existing onboarded users
UPDATE users SET onboarding_state = 'COMPLETED' WHERE onboarded = true AND onboarding_state != 'COMPLETED';

-- Tasks enhancements
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS task_type TEXT NOT NULL DEFAULT 'task';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS is_system_generated BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_tasks_type ON tasks (user_id, task_type);
