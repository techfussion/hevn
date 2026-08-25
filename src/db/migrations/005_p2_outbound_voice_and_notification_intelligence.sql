-- Migration 005: P2.3 Outbound Voice & Notification Intelligence
-- Adds user voice preferences, response mode selection, and audio notification settings
-- Safe to execute idempotently on existing databases

-- 1. Extend users table with voice & response mode preferences
ALTER TABLE users ADD COLUMN IF NOT EXISTS response_mode TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE users ADD COLUMN IF NOT EXISTS voice_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS voice_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS voice_language TEXT;

-- 2. Ensure response_mode check constraint is enforced
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_response_mode_check;
ALTER TABLE users ADD CONSTRAINT users_response_mode_check CHECK (response_mode IN ('text', 'voice', 'auto'));
