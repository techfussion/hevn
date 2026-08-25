-- Migration 003: P2.1 External Calendar Integration
-- Adds calendar_accounts, connected_calendars, and calendar_event_links with Row-Level Security

CREATE TABLE IF NOT EXISTS calendar_accounts (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider                TEXT NOT NULL CHECK (provider IN ('google', 'caldav')),
  account_email           TEXT,
  encrypted_access_token  TEXT,
  encrypted_refresh_token TEXT,
  token_expires_at        TIMESTAMPTZ,
  auth_metadata           JSONB DEFAULT '{}'::jsonb,
  status                  TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'error', 'disconnected')),
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

-- Auto-update triggers
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
ALTER TABLE calendar_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE connected_calendars ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_event_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS calendar_accounts_isolation ON calendar_accounts;
CREATE POLICY calendar_accounts_isolation ON calendar_accounts
  USING (user_id = current_setting('app.current_user_id', true)::uuid);

DROP POLICY IF EXISTS connected_calendars_isolation ON connected_calendars;
CREATE POLICY connected_calendars_isolation ON connected_calendars
  USING (user_id = current_setting('app.current_user_id', true)::uuid);

DROP POLICY IF EXISTS calendar_event_links_isolation ON calendar_event_links;
CREATE POLICY calendar_event_links_isolation ON calendar_event_links
  USING (user_id = current_setting('app.current_user_id', true)::uuid);
