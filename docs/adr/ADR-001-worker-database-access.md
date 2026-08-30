# ADR-001: Background Worker Database Access & Row-Level Security Architecture

## Status
**ACCEPTED & IMPLEMENTED** (P2.5.1)

## Context
In production (Railway connecting to Supabase PostgreSQL), the background scheduler worker runs under the dedicated database user `scheduler_service`. The worker was failing with:
- `permission denied for table job_queue`
- `permission denied for table follow_ups`

Additionally, because Row-Level Security (RLS) is enabled across all HEVN tables enforcing `user_id = current_setting('app.current_user_id', true)::uuid`, cross-user background batch routines (such as `JobQueueService.claimJobs()` using `FOR UPDATE SKIP LOCKED`, `FollowUpService.getDueFollowUpsBatch()`, and `TaskService.getDueRemindersBatch()`) cannot execute under standard single-tenant RLS constraints without explicit policy accommodation.

## Alternatives Evaluated

### Option 1: Grant `BYPASSRLS` or `SUPERUSER` to `scheduler_service`
- **Pros**: Simple to configure.
- **Cons**: Severe violation of least privilege. In Supabase/PostgreSQL, `BYPASSRLS` grants unconditional table visibility across all schemas and undermines auditable database security boundaries.
- **Verdict**: **REJECTED**.

### Option 2: Wrap Operations in `SECURITY DEFINER` Functions
- **Pros**: Encapsulates specific SQL queries into stored procedures running as owner.
- **Cons**: High migration friction for dynamic queries, complicates TypeScript type-safety, and does not align cleanly with node-postgres parameterized ORM/query patterns.
- **Verdict**: **REJECTED as primary mechanism**, though retained as an option for future standalone stored procedures.

### Option 3: Least-Privilege Table Grants + Explicit Worker RLS Policies (Chosen Approach)
- **Pros**:
  1. `scheduler_service` remains a strictly unprivileged role with zero DDL or superuser capabilities.
  2. Only explicitly audited tables receive exact `SELECT`, `INSERT`, `UPDATE` grants.
  3. Table RLS remains **ENABLED** for all tables.
  4. Explicit policies (`CREATE POLICY scheduler_worker_access ON <table> FOR ALL TO scheduler_service USING (true) WITH CHECK (true);`) grant the worker role access while keeping normal user connections strictly isolated by `app.current_user_id`.
  5. Works seamlessly across direct PostgreSQL connections, Supavisor connection poolers, and local development environments.
- **Verdict**: **ACCEPTED**.

## Decision
1. Create migration `008_p2_worker_database_permissions.sql` that grants schema usage and exact table privileges to `scheduler_service`.
2. Add dedicated worker RLS policies targeted specifically to `TO scheduler_service`.
3. Add startup capability self-check in `DatabaseCapabilityChecker` to immediately validate connected role permissions before starting worker polling loops.

## Consequences
- **Positive**: Background workers can reliably claim jobs and process follow-ups without permission errors; tenant isolation for user-facing API routes remains 100% intact.
- **Rollback Strategy**: Drop `008` migration policies and revoke table privileges from `scheduler_service` if permission isolation requires readjustment.
