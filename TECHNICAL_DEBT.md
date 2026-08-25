# Hevn AI — Technical Debt Register

This register documents known architectural and technical debt across the Hevn codebase, including classification, impact, deferral rationale, triggering conditions for remediation, and proposed target solutions.

---

## Technical Debt Classification Schema

- **P0**: Critical defect / security vulnerability. Must be resolved immediately.
- **P1**: High-priority architectural debt. Should be resolved before starting the next major feature area.
- **P2**: Valid, acceptable technical debt. Can safely remain while the product evolves at current scale.
- **P3**: Minor cleanup / cosmetic refactoring.

---

## Technical Debt Register

| ID | Title | Priority | Current Impact | Trigger for Action | Proposed Future Solution |
| :--- | :--- | :---: | :--- | :--- | :--- |
| **DEBT-01** | **PostgreSQL Minute-Polling Scheduler** | **P2** | Low at current scale (<2ms query latency with partial indexes) | High-volume index/lock contention or active users scaling beyond >100k | Migrate to distributed job queue (e.g., `pg-boss` or `Temporal`) with lease-based locks and idempotent execution |
| **DEBT-02** | **Voice Message Ingestion** | **RESOLVED** | Resolved in P2.0 — in-memory audio ingestion & transcription pipeline active | N/A (Feature Complete) | Ingests Telegram & WhatsApp voice notes via `AudioIngestionService` and `GeminiTranscriptionProvider` |
| **DEBT-05** | **Outbound Voice Audio Synthesis (TTS)** | **RESOLVED** | Resolved in P2.3 — `AudioSynthesisService`, `AudioSynthesisProvider`, `ResponsePolicyService`, and `ChannelCapabilities` active | N/A (Feature Complete) | Multi-provider TTS abstraction (ElevenLabs / Google Cloud TTS), deterministic response policy, audio caching, and automatic text fallback |
| **DEBT-06** | **TTS Provider Dynamic Multi-Pool Failover** | **P2** | Low — single active provider with automatic text fallback | Frequent provider quota exhaustion or multi-region outages | Implement automated dynamic multi-provider round-robin and circuit breaking across provider pools |
| **DEBT-07** | **Flashcard Spaced Repetition (SRS) Algorithm** | **P2** | Low — active recall decks generated on-demand with topic mastery bounds | Students requiring spaced intervals (e.g. SuperMemo SM-2 or FSRS scheduling) | Implement SM-2 / FSRS scheduling table (`flashcard_reviews`) to track ease factors and intervals |
| **DEBT-03** | **Webhook Processed Updates Pruning** | **P3** | Negligible storage growth in `processed_updates` | Table size exceeds 1M rows (~6 months of high traffic) | Add automated 7-day TTL cleanup routine to background worker tick |
| **DEBT-04** | **Multi-Turn Conversation Turn Truncation** | **P3** | Context capped at 6 turns; older turns retained in database | DB size growth for highly active users | Add rolling turn archive / partition policy |

---

## Detailed Notes on DEBT-01: PostgreSQL Minute-Polling Scheduler

### Current Architecture
- The background worker ([`src/scheduler/worker.ts`](file:///Users/macbookpro/Documents/web_projects/hevn/src/scheduler/worker.ts)) executes every minute via `node-cron`.
- Every minute it performs 3 indexed batch queries:
  1. `getDueRemindersBatch(100)`: searches `tasks` where `due_at - reminder_offset <= now() AND reminder_sent_at IS NULL`.
  2. `getDueFollowUpsBatch(100)`: searches `follow_ups` where `scheduled_at <= now() AND status IN ('SCHEDULED', 'DUE')`.
  3. `getDueRecurringTasksBatch(50)`: searches `recurring_tasks` where `next_run_at <= now() AND status = 'active'`.

### Why It Is Acceptable Now
- Query execution takes <2ms due to partial B-tree indexes (`idx_followups_scheduled_due`, `idx_tasks_reminders_pending`, `idx_recurring_next_run`).
- Zero extra external infrastructure dependencies (e.g., Redis, RabbitMQ, or Temporal clusters), minimizing operational and deployment overhead for MVP and initial growth.
- Batch fetching and transactional status updates prevent double delivery.

### Migration Triggers
- Active user count exceeds **100,000** concurrent users.
- Database CPU contention on scheduler polling exceeds 5% of total capacity.
- Requirement for sub-second precision reminder dispatch.

### Target Migration Path
- Adopt `pg-boss` (Postgres SKIP LOCKED queue) or `Temporal` workflow orchestration.
- Preserve existing domain contracts in `FollowUpService`, `TaskService`, and `RecurringTaskService`.
