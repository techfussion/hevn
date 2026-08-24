# Hevn AI — Agent Guidelines & Developer Instructions

## 1. Operating Principles

1. **The Codebase is Ground Truth**: Always verify code behavior from the active files in `src/`, `scripts/`, and `__tests__/`.
2. **Never Trust Model Arguments**: Always enforce server-side validation using Zod schemas for all tool calls.
3. **Database Scoping**: Always execute user-specific database queries via `withUserScope(userId, fn)` in `src/db/pool.ts` to uphold Row-Level Security.
4. **Channel Agnosticism**: All platform messaging should flow through `MessagingAdapter` and `src/adapters/registry.ts`. Do not import Telegram or WhatsApp SDKs directly into core services.
5. **Observability First**: Use `src/utils/logger.ts` for structured JSON logging. Never use raw `console.log` or `console.error` in production code.
6. **Voice as Input Modality**: Voice notes are an input modality, not a separate assistant. Incoming voice notes are downloaded via provider-authenticated APIs, transcribed into normalized user text via `AudioIngestionService`, and passed directly into `ConversationOrchestrator.handleMessage`. Do not duplicate business logic for voice.

---

## 2. Testing & Quality Standards

Before committing changes, ensure the following quality gates pass:

```bash
# 1. Linting (0 errors, 0 warnings)
npm run lint

# 2. TypeScript Compilation (0 errors)
npm run typecheck

# 3. Unit & Integration Test Suite (100% pass)
npm test

# 4. Production Build (0 errors)
npm run build
```

---

## 3. Directory Layout

* `src/adapters/` — Platform messaging adapters (Telegram, WhatsApp) and dynamic registry
* `src/api/` — Express webhooks with signature verification, deduplication, and audio routing
* `src/core/gemma/` — Google GenAI Gemma client and tool declarations
* `src/core/followup/` — Follow-up engine, status progression, and quiet hours calculations
* `src/core/insights/` — 7-day productivity metrics, follow-through analytics, and prose generation
* `src/core/memory/` — Structured user memories and relational facts
* `src/core/persona/` — Persona definitions and dynamic prompt builder
* `src/core/projects/` — Lightweight project containers and deterministic rollups
* `src/core/recurring/` — Generalized recurring tasks engine and schedule calculations
* `src/core/tasks/` — Task and user persistence logic with Zod validation
* `src/core/voice/` — Audio ingestion service, limits validation, and Gemini multimodal transcription
* `src/db/` — Database pool, transaction wrappers, and schema DDL
* `src/middleware/` — Rate limiting and security middleware
* `src/orchestrator/` — Core conversation loop, multi-round tool calling, and reply extraction
* `src/scheduler/` — Background cron workers for reminders, follow-ups, and localized check-ins
* `src/utils/` — Centralized structured logger
* `__tests__/` — Automated unit, integration, and security test suite

