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
| **DEBT-01** | **PostgreSQL Minute-Polling Scheduler** | **RESOLVED** | Resolved in P2.5 — durable PostgreSQL `SKIP LOCKED` job queue (`JobQueueService`) with leases, singleton locks, stale recovery & dead-letter replay | N/A (Feature Complete) | High-throughput durable job queue with lease-based claiming (`job_queue`), exponential backoff retries, dead-letter recovery, and worker concurrency controls |
| **DEBT-02** | **Voice Message Ingestion** | **RESOLVED** | Resolved in P2.0 — in-memory audio ingestion & transcription pipeline active | N/A (Feature Complete) | Ingests Telegram & WhatsApp voice notes via `AudioIngestionService` and `GeminiTranscriptionProvider` |
| **DEBT-05** | **Outbound Voice Audio Synthesis (TTS)** | **RESOLVED** | Resolved in P2.3 — `AudioSynthesisService`, `AudioSynthesisProvider`, `ResponsePolicyService`, and `ChannelCapabilities` active | N/A (Feature Complete) | Multi-provider TTS abstraction (ElevenLabs / Google Cloud TTS), deterministic response policy, audio caching, and automatic text fallback |
| **DEBT-06** | **TTS Provider Dynamic Multi-Pool Failover & Circuit Breaking** | **RESOLVED** | Resolved in P2.5 — `CircuitBreaker` (`CLOSED -> OPEN -> HALF_OPEN`), multi-provider failover pool, bounded timeouts, health tracking & text fallback | N/A (Feature Complete) | Multi-provider synthesis pool with independent circuit breakers, per-call timeout budgets, provider failover metrics, and graceful degradation |
| **DEBT-07** | **Flashcard Spaced Repetition (SRS) Algorithm** | **P2** | Low — active recall decks generated on-demand with topic mastery bounds | Students requiring spaced intervals (e.g. SuperMemo SM-2 or FSRS scheduling) | Implement SM-2 / FSRS scheduling table (`flashcard_reviews`) to track ease factors and intervals |
| **DEBT-03** | **Webhook Processed Updates Pruning** | **P3** | Negligible storage growth in `processed_updates` | Table size exceeds 1M rows (~6 months of high traffic) | Add automated 7-day TTL cleanup routine to background worker tick |
| **DEBT-04** | **Multi-Turn Conversation Turn Truncation** | **P3** | Context capped at 6 turns; older turns retained in database | DB size growth for highly active users | Add rolling turn archive / partition policy |

---

## Detailed Notes on DEBT-01: PostgreSQL Minute-Polling Scheduler (RESOLVED)

### Resolution Details (P2.5)
- Implemented [`src/core/jobs/JobQueueService.ts`](file:///Users/macbookpro/Documents/web_projects/hevn/src/core/jobs/JobQueueService.ts) backed by table `job_queue` using `SELECT ... FOR UPDATE SKIP LOCKED`.
- Worker nodes claim jobs concurrently without lock contention or duplicate execution.
- Added lease-based locking (`locked_until`, `locked_by`), singleton key constraints (`singleton_key`), idempotency keys (`idempotency_key`), automatic stale lease recovery (`recoverStaleJobs`), exponential retry backoff with jitter, and dead-letter replay (`replayDeadLetterJobs`).
- Verified with unit tests in `__tests__/job-queue-service.test.ts` and integration scenarios in `__tests__/p2-5-e2e-scenarios.test.ts`.

---

## Detailed Notes on DEBT-06: TTS Provider Dynamic Failover & Circuit Breaking (RESOLVED)

### Resolution Details (P2.5)
- Implemented [`src/core/voice/CircuitBreaker.ts`](file:///Users/macbookpro/Documents/web_projects/hevn/src/core/voice/CircuitBreaker.ts) with strict state machine (`CLOSED -> OPEN -> HALF_OPEN`), failure thresholds, cool-down timers, and half-open probe limits.
- Upgraded [`src/core/voice/AudioSynthesisService.ts`](file:///Users/macbookpro/Documents/web_projects/hevn/src/core/voice/AudioSynthesisService.ts) to manage ordered provider failover pools (e.g. ElevenLabs -> Google Cloud TTS -> Fallback).
- Added per-attempt timeout budgets, provider health telemetry metrics (`voice.provider.failover`, `voice.synthesis.failure`), and graceful text fallback.
- Verified with unit tests in `__tests__/voice-failover-circuit-breaker.test.ts` and end-to-end outage tests in `__tests__/p2-5-e2e-scenarios.test.ts`.
