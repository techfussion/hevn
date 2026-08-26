-- Migration 007: P2.5 Production Reliability, Notification Intelligence & Job Queue
-- Adds job_queue table for durable SKIP LOCKED job processing and notification_dedup_log table for atomic deduplication

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

-- Triggers for auto-updating updated_at
CREATE OR REPLACE FUNCTION update_job_queue_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_job_queue_updated_at ON job_queue;
CREATE TRIGGER trg_job_queue_updated_at
  BEFORE UPDATE ON job_queue
  FOR EACH ROW
  EXECUTE FUNCTION update_job_queue_updated_at();

-- Row Level Security (RLS)
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
