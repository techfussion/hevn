# Hevn AI — Agent Guidelines & Developer Instructions

## 1. Operating Principles

1. **The Codebase is Ground Truth**: Always verify code behavior from the active files in `src/`, `scripts/`, and `__tests__/`.
2. **Never Trust Model Arguments**: Always enforce server-side validation using Zod schemas for all tool calls.
3. **Database Scoping**: Always execute user-specific database queries via `withUserScope(userId, fn)` in `src/db/pool.ts` to uphold Row-Level Security.
4. **Channel Agnosticism**: All platform messaging should flow through `MessagingAdapter` and `src/adapters/registry.ts`. Do not import Telegram or WhatsApp SDKs directly into core services.
5. **Observability First**: Use `src/utils/logger.ts` for structured JSON logging. Never use raw `console.log` or `console.error` in production code.

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
```

---

## 3. Directory Layout

* `src/adapters/` — Platform messaging adapters and dynamic registry
* `src/api/` — Express webhooks with signature verification and deduplication
* `src/core/gemma/` — Google GenAI Gemma client and tool declarations
* `src/core/insights/` — 7-day productivity report and suggestion heuristics
* `src/core/persona/` — Persona definitions and dynamic prompt builder
* `src/core/tasks/` — Task and user persistence logic with Zod validation
* `src/db/` — Database pool, transaction wrappers, and schema DDL
* `src/middleware/` — Rate limiting and security middleware
* `src/orchestrator/` — Core conversation loop, multi-round tool calling, and reply extraction
* `src/scheduler/` — Background cron workers for reminders and localized check-ins
* `src/utils/` — Centralized structured logger
* `__tests__/` — Automated unit, integration, and security test suite
