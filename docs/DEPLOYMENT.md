# HEVN AI — Deployment & Database Permissions Guide

## 1. Database Connection Strings

HEVN AI separates application traffic from background worker execution to guarantee strict tenant isolation and reliable queue processing.

| Environment Variable | Role | Purpose | Default / Fallback |
| :--- | :--- | :--- | :--- |
| `DATABASE_URL` | Application Role | User-facing API & Webhook traffic (`withUserScope`) | Required |
| `SCHEDULER_DATABASE_URL` | `scheduler_service` | Queue worker, proactive check-ins, calendar reconciliation | Defaults to `DATABASE_URL` |
| `ADMIN_SECRET_KEY` | Admin Platform | Timing-safe authentication for internal admin API (`/api/admin/*`) | Required |

---

## 2. Supabase / PostgreSQL Permission Setup

### Applying Migrations
Apply migration `008_p2_worker_database_permissions.sql` to configure least-privilege table grants and worker RLS policies for `scheduler_service`:

```bash
# In your deployment pipeline or Supabase SQL Editor:
psql $DATABASE_URL -f src/db/migrations/008_p2_worker_database_permissions.sql
```

### What Migration 008 Configures:
1. Ensures role `scheduler_service` exists idempotently.
2. Grants `USAGE ON SCHEMA public`.
3. Grants explicit table privileges:
   - `job_queue`: `SELECT, INSERT, UPDATE, DELETE`
   - `follow_ups`: `SELECT, INSERT, UPDATE`
   - `tasks`: `SELECT, INSERT, UPDATE`
   - `recurring_tasks`: `SELECT, UPDATE`
   - `notification_dedup_log`: `SELECT, INSERT, UPDATE`
   - `calendar_accounts`: `SELECT, UPDATE`
   - `calendar_event_links`: `SELECT, INSERT, UPDATE, DELETE`
   - `calendar_sync_state`: `SELECT, INSERT, UPDATE`
   - `users`, `user_memories`, `projects`, `courses`, `topics`, `assessments`, `study_sessions`, `quizzes`: `SELECT`
   - `processed_updates`: `SELECT, INSERT`
4. Grants `USAGE, SELECT` on all sequences.
5. Configures explicit worker RLS policies (`CREATE POLICY scheduler_worker_access ON <table> FOR ALL TO scheduler_service USING (true) WITH CHECK (true);`).

---

## 3. Worker Startup Self-Check (`DatabaseCapabilityChecker`)

When the background worker starts (`src/scheduler/worker.ts`), it automatically executes a non-destructive capability verification:
- Checks connected PostgreSQL role (`current_user`, `session_user`).
- Tests `SELECT` query access on `job_queue`, `follow_ups`, `tasks`, `notification_dedup_log`, and `users`.
- If any required permission is missing, the worker immediately logs a fatal diagnostic error referencing `008_p2_worker_database_permissions.sql` and halts gracefully rather than entering an endless polling loop.

---

## 4. Troubleshooting Permission Denied in Production

If the worker logs:
```text
permission denied for table job_queue
```
or
```text
permission denied for table follow_ups
```

### Steps to Resolve:
1. Verify that `SCHEDULER_DATABASE_URL` connects with user `scheduler_service` (e.g. `postgresql://scheduler_service:password@db.supabase.co:5432/postgres`).
2. Run migration `src/db/migrations/008_p2_worker_database_permissions.sql` against the database.
3. Restart the background worker service.
