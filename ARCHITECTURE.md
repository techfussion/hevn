# Hevn AI — System Architecture & Design Specification

## 1. System Overview

**Hevn** is a conversational AI Secretary designed to manage commitments, tasks, schedules, deadlines, multi-step goal breakdowns, and personalized daily productivity check-ins over messaging platforms (Telegram and WhatsApp).

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
|   - User Onboarding State Check:                                                   |
|       * Incomplete -> OnboardingService (Deterministic State Machine)              |
|       * Completed  -> Gemma AI Secretary Conversation Loop                         |
|   - Rolling Context Buffer (last 6 turns, pruned at 50)                            |
|   - Dynamic System Prompt (injected with user time, timezone, persona, role)       |
|   - Gemma 4 Foundation Model (@google/genai SDK with exponential backoff retries)  |
|   - Multi-Round Function Calling Loop (max 3 rounds)                               |
|   - Chain-of-Thought / Reasoning Sanitization (extractReply parser)                |
+------------------------------------------+-----------------------------------------+
                                           | Scoped Execution
                                           v
+------------------------------------------------------------------------------------+
|                                Core Domain Services                                |
|   - OnboardingService (Deterministic Conversational State Machine)                 |
|   - UserService (Onboarding, Timezones, Persona, Assistant Name, Checkin Time)     |
|   - TaskService (Commitments, Tasks, Status Transitions, Snooze Math, Breakdowns)  |
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
+------------------------------------------+-----------------------------------------+
                                           ^
                                           | Poll / Sweep
+------------------------------------------------------------------------------------+
|                               Background Schedulers                                |
|   - Per-minute Reminder Worker (getDueRemindersBatch -> Dynamic Adapter Dispatch)  |
|   - Hourly Localized Sweep (Morning Agenda at preferred check-in & 8pm Review)     |
+------------------------------------------+-----------------------------------------+
```

---

## 2. Conversational Onboarding Architecture

Onboarding happens completely conversationally inside WhatsApp and Telegram without requiring any external dashboard or account creation form.

### Onboarding State Transitions:
1. **`WELCOME`**: Initial greeting. Bot presents itself as the AI Secretary and asks what to call the user.
2. **`AWAITING_NAME`**: User provides their name (`display_name`). Bot acknowledges and offers the 4 canonical assistant names.
3. **`AWAITING_ASSISTANT_NAME`**: User selects assistant name (`Mumin`, `Khadijah`, `Scott`, or `Claire`). Bot confirms and presents the 3 user persona roles.
4. **`AWAITING_PERSONA`**: User selects their role (`student`, `executive_assistant`, `professional`) or asks for an explanation. If explanation is requested, concise summaries are presented while maintaining the state.
5. **`AWAITING_CHECKIN_TIME`**: Bot offers morning Daily Check-in (default 6:00 AM) and parses natural language times (e.g. "8am", "7:30", "6am is fine").
6. **`COMPLETED`**: State transitions to `COMPLETED`, `onboarded = true`, creates the Free Plan's system-generated recurring Daily Check-in task, and immediately opens the normal AI Secretary conversation.

### Resumability & Idempotency:
* All state transitions are persisted in PostgreSQL (`onboarding_state` on `users`).
* If a user pauses mid-flow, returning to the chat immediately resumes from their current step.

---

## 3. Predefined Personas & Assistant Names

### Assistant Names (User Personalization):
* **Mumin**
* **Khadijah**
* **Scott**
* **Claire**

### User Personas (Role Context):
* **Student**: Academic commitments, assignment deadlines, exams, study schedules.
* **Executive Assistant**: Managing meetings, follow-ups, documents, deadlines for self and executive/team.
* **Professional**: Client deliverables, project milestones, deadlines, day-to-day commitments.

---

## 4. Commitments vs Tasks vs Reminders

The core domain model distinguishes:
* **Commitment / Event**: e.g., "Board meeting on Friday at 2 PM", "Physics exam on Thursday".
* **Task / Preparation**: e.g., "Prepare financial slides", "Study chapter 4".
* **Reminder**: Scheduled notification offset before due date.
* **Recurring Check-in**: System-generated recurring automation for free users.
