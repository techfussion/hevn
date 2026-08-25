-- Migration 004: P2.2 Calendar Hardening & OAuth Lifecycle
-- Updates calendar_accounts status check constraint to include 'reauth_required'
-- Adds operational error diagnostic columns

ALTER TABLE calendar_accounts
  DROP CONSTRAINT IF EXISTS calendar_accounts_status_check;

ALTER TABLE calendar_accounts
  ADD CONSTRAINT calendar_accounts_status_check
  CHECK (status IN ('active', 'revoked', 'reauth_required', 'error', 'disconnected'));

ALTER TABLE calendar_accounts
  ADD COLUMN IF NOT EXISTS error_code TEXT,
  ADD COLUMN IF NOT EXISTS error_message TEXT;
