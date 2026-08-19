# Hevn AI — System Architecture & Design Specification

## 1. System Overview

**Hevn** is a conversational AI Academic Secretary designed to manage tasks, schedules, deadlines, multi-step goal breakdowns, and personalized daily/weekly productivity check-ins over messaging platforms (Telegram and WhatsApp).

The system operates on an **Understand → Organize → Remember → Act → Follow Up → Complete** loop rather than simple message-in / message-out LLM prompting.

```
+------------------------------------------------------------------------------------+
|                                    User Layer                                      |
|                       (Telegram / WhatsApp Mobile & Web)                           |
+------------------------------------------+-----------------------------------------+
                                           | HTTPS Webhook
                                           v
+------------------------------------------------------------------------------------+
|                                Messaging Gateway                                   |
|   - Express 4.19 / Helmet / Rate Limiting (20 req/min)                             |
|   - Timing-Safe Webhook Signature & HMAC Verification                              |
|   - Atomic Webhook Deduplication (processed_updates table)                         |
|   - Normalized MessagingAdapter Interface (TelegramAdapter / WhatsAppAdapter)      |
+------------------------------------------+-----------------------------------------+
                                           | Normalized Message & Trace Context
                                           v
+------------------------------------------------------------------------------------+
|                            Conversation Orchestrator                               |
|   - Rolling Context Buffer (last 6 turns, pruned at 50)                            |
|   - Dynamic System Prompt (injected with student time, timezone, persona, status)  |
|   - Gemma 4 Foundation Model (@google/genai SDK with exponential backoff retries)  |
|   - Multi-Round Function Calling Loop (max 3 rounds)                               |
|   - Chain-of-Thought / Reasoning Sanitization (extractReply parser)                |
+------------------------------------------+-----------------------------------------+
                                           | Scoped Execution
                                           v
+------------------------------------------------------------------------------------+
|                                Core Domain Services                                |
|   - UserService (Onboarding, Timezones, Persona, Check-in Hour preferences)        |
|   - TaskService (Parameterized CRUD, Status Transitions, Snooze Math, Breakdowns)  |
|   - InsightsService (7-Day Rolling Analytics, Best Day Heuristic >= 3 data points) |
|   - Zod Validation Schemas (Strict runtime defense against malformed model args)   |
+------------------------------------------+-----------------------------------------+
                                           | withUserScope(userId, tx)
                                           v
+------------------------------------------------------------------------------------+
|                                PostgreSQL Database                                 |
|   - Multi-Tenant Row-Level Security (users, tasks, conversation_turns)             |
|   - Partial Indexes on Active Pending Due Dates & Webhook Processed IDs            |
|   - Auto-updating Timestamp Triggers                                               |
+------------------------------------------------------------------------------------+
                                           ^
                                           | Poll / Sweep
+------------------------------------------+-----------------------------------------+
|                               Background Schedulers                                |
|   - Per-minute Reminder Worker (getDueRemindersBatch -> Dynamic Adapter Dispatch)  |
|   - Hourly Localized Sweep (Morning Agenda at preferred_checkin_hour & 8pm Review) |
+------------------------------------------------------------------------------------+
```

---

## 2. Key Architectural Invariants

1. **Defense-in-Depth User Isolation**:
   - Every user-facing database interaction executes within `withUserScope(userId, clientFn)`, setting `app.current_user_id = userId` inside a transaction.
   - Database tables (`users`, `tasks`, `conversation_turns`) enforce PostgreSQL Row-Level Security (RLS) policies based on `app.current_user_id`.

2. **Idempotent Webhook Processing**:
   - Webhooks extract a unique `updateId` (Telegram `update_id` / WhatsApp `message.id`) and atomically attempt `INSERT INTO processed_updates (id, platform) VALUES (...) ON CONFLICT DO NOTHING`.
   - If the update has already been processed or is currently in flight, duplicate processing is skipped.

3. **Tool Safety & Zero Raw Model Trust**:
   - Gemma function calling schemas define model intentions, but all inputs are strictly validated server-side through Zod schemas in `TaskService`.
   - Task IDs are validated as UUIDs; date-time strings are validated against strict ISO 8601 parsers.

4. **Multi-Channel Decoupling via Adapter Registry**:
   - Schedulers and webhook handlers interact solely with `MessagingAdapter`. Platform-specific network calls, typing indicators, and retries are encapsulated in `src/adapters/`.

---

## 3. Data Model & Schema Details

```sql
-- users: user identities and personalized settings
CREATE TABLE users (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform               TEXT NOT NULL CHECK (platform IN ('telegram', 'whatsapp')),
  platform_user_id       TEXT NOT NULL,
  display_name           TEXT,
  timezone               TEXT NOT NULL DEFAULT 'UTC',
  onboarded              BOOLEAN NOT NULL DEFAULT false,
  bot_persona            TEXT NOT NULL DEFAULT 'Hevn',
  preferred_checkin_hour INTEGER NOT NULL DEFAULT 8 CHECK (preferred_checkin_hour BETWEEN 0 AND 23),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (platform, platform_user_id)
);

-- tasks: academic tasks, assignments, deadlines, events
CREATE TABLE tasks (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title                    TEXT NOT NULL,
  due_at                   TIMESTAMPTZ NOT NULL,
  priority                 TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high')),
  status                   TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','done','missed')),
  reminder_offset_minutes  INTEGER,
  reminder_sent_at         TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- conversation_turns: rolling conversation history (capped at 50 turns)
CREATE TABLE conversation_turns (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- processed_updates: webhook idempotency & replay protection
CREATE TABLE processed_updates (
  id          TEXT PRIMARY KEY,
  platform    TEXT NOT NULL CHECK (platform IN ('telegram', 'whatsapp')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```
