# HEVN AI — Database Access & Security Architecture

## 1. Executive Summary & Access Tier Model

HEVN AI enforces a multi-tier database access architecture to ensure complete multi-tenant data isolation while allowing trusted server-side background infrastructure to perform cross-user job scheduling, notifications, and calendar reconciliation.

```text
Application User Request
        ↓
withUserScope(userId)
        ↓
SET LOCAL app.current_user_id = '<userId>'
        ↓
PostgreSQL Row-Level Security (RLS)
        ↓
Tenant-Isolated Data Access

Background Scheduler / Worker
        ↓
scheduler_service (Dedicated Role)
        ↓
Explicit Least-Privilege Table Grants & Worker RLS Policies
        ↓
Controlled System-Level Cross-Tenant Scheduling (SKIP LOCKED, Follow-ups, Dedup)

Database Migrations & Administrative Operations
        ↓
postgres / service_role (Admin Role)
        ↓
DDL & Schema Management
```

---

## 2. Access Tiers

### Tier A: Normal Application / User Access
- **PostgreSQL Role**: Standard application connection role (`DATABASE_URL`).
- **Connection Scope**: Every single user request must be wrapped inside `withUserScope(userId, async (client) => { ... })`.
- **Tenant Isolation**: Executes `BEGIN; SELECT set_config('app.current_user_id', $1, true); ... COMMIT;`.
- **Row-Level Security**: All tables (`tasks`, `follow_ups`, `user_memories`, `projects`, `courses`, etc.) enforce:
  ```sql
  CREATE POLICY <table_name>_isolation ON <table_name>
    USING (user_id = current_setting('app.current_user_id', true)::uuid);
  ```
- **Guarantees**: Even if an application query has a bug or omitted where clause, PostgreSQL strictly rejects cross-tenant data leaks.

---

### Tier B: Background Worker Access (`scheduler_service`)
- **PostgreSQL Role**: `scheduler_service` (configured via `SCHEDULER_DATABASE_URL` in Railway / server environments).
- **Scope**: Used **exclusively** by trusted background processes (`src/scheduler/worker.ts` and `src/scheduler/dailyCheckIns.ts`).
- **Controlled Capabilities**:
  1. Claiming pending jobs from `job_queue` using `FOR UPDATE SKIP LOCKED`.
  2. Updating job completion, failure, and retry states.
  3. Recovering stale leases after worker restarts.
  4. Querying scheduled/due follow-ups and advancing attempt counters.
  5. Querying due reminders for tasks with approaching deadlines.
  6. Querying due recurring task schedules and advancing occurrences.
  7. Claiming atomic notification deduplication keys in `notification_dedup_log`.
  8. Reconciling external calendar accounts and saving sync tokens.
  9. Gathering morning and evening briefing agendas.
- **Security Safeguards**:
  - **No `SUPERUSER`**: `scheduler_service` is an unprivileged PostgreSQL role.
  - **No DDL / Schema Modification**: Cannot `CREATE`, `ALTER`, or `DROP` tables.
  - **No Blind Grants**: Only explicitly audited tables receive necessary permissions (`SELECT`, `INSERT`, `UPDATE`).
  - **Worker RLS Policies**: Explicitly scoped `TO scheduler_service` so the worker can access rows across tenants without disabling RLS on any table.

---

### Tier C: Migration & Administration
- **PostgreSQL Role**: `postgres` / `service_role` (used only during deployment migrations via `src/db/migrations/`).
- **Scope**: Schema DDL, table creations, trigger setup, and index optimization.

---

## 3. Worker Database Dependency Matrix

| Worker Operation | Service | Tables Touched | Required Privileges |
| :--- | :--- | :--- | :--- |
| **Claim Pending Jobs** | `JobQueueService` | `job_queue` | `SELECT`, `UPDATE` (`FOR UPDATE SKIP LOCKED`) |
| **Enqueue Background Job** | `JobQueueService` | `job_queue` | `INSERT`, `SELECT` |
| **Complete / Fail Job** | `JobQueueService` | `job_queue` | `UPDATE` |
| **Recover Stale Leases** | `JobQueueService` | `job_queue` | `SELECT`, `UPDATE` |
| **Replay Dead-Letter Jobs** | `JobQueueService` | `job_queue` | `SELECT`, `UPDATE` |
| **Query Due Follow-Ups** | `FollowUpService` | `follow_ups`, `tasks` | `SELECT` |
| **Mark Follow-Up Delivered** | `FollowUpService` | `follow_ups` | `UPDATE` |
| **Cancel Follow-Up Response**| `FollowUpService` | `follow_ups`, `tasks` | `UPDATE` |
| **Query Due Reminders** | `TaskService` | `tasks` | `SELECT` |
| **Mark Reminder Sent** | `TaskService` | `tasks` | `UPDATE` |
| **Create Recurring Task Item**| `TaskService` | `tasks` | `INSERT` |
| **Query Due Recurring Tasks** | `RecurringTaskService` | `recurring_tasks` | `SELECT` |
| **Advance Recurring Task** | `RecurringTaskService` | `recurring_tasks` | `UPDATE` |
| **Notification Dedup Claim** | `NotificationDeduplicationService` | `notification_dedup_log` | `SELECT`, `INSERT` |
| **Record Notification Outcome**| `NotificationDeduplicationService` | `notification_dedup_log` | `UPDATE` |
| **Rate Limit / Gap Check** | `NotificationDeduplicationService` | `notification_dedup_log` | `SELECT` |
| **Calendar Sync Account Sweep**| `CalendarReconciliationService` | `calendar_accounts` | `SELECT` |
| **Calendar Event Sync** | `CalendarReconciliationService` | `calendar_event_links`, `calendar_sync_state` | `SELECT`, `INSERT`, `UPDATE`, `DELETE` |
| **User Settings & Channels** | `NotificationPolicyService` / Worker | `users` | `SELECT` |
| **Daily Briefing Synthesis** | `BriefingService` | `tasks`, `follow_ups`, `calendar_accounts`, `courses`, `study_sessions`, `projects`, `user_memories` | `SELECT` |
| **Webhook Idempotency** | Webhook Handlers | `processed_updates` | `SELECT`, `INSERT` |

---

## 4. RLS Architecture for Worker Operations

To reconcile cross-tenant scheduler queries with PostgreSQL Row-Level Security:
- Table RLS remains **ENABLED** on all 19 database tables.
- For each table accessed by `scheduler_service`, a dedicated policy is established:
  ```sql
  CREATE POLICY scheduler_worker_access ON <table>
    FOR ALL
    TO scheduler_service
    USING (true)
    WITH CHECK (true);
  ```
- Normal application traffic connecting as other database roles continues to evaluate only the user-scoped policies (`USING (user_id = current_setting('app.current_user_id', true)::uuid)`).
