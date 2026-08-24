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
* **Task / Preparation**: e.g., "Prepare financial slides", "Study chapter 4" (linked via `parent_task_id`).
* **Reminder**: Pre-deadline heads-up notification offset before due date.
* **Follow-Up**: Post-deadline accountability inquiry ("Have you managed to get this done?").
* **Recurring Task**: Generalized timezone-aware schedule (daily, weekdays, weekly, custom).

---

## 5. Follow-Up Engine & State Machine

The `FollowUpService` manages post-deadline follow-up cycles with anti-nagging constraints (max 3 attempts):

$$\text{SCHEDULED} \longrightarrow \text{DUE} \longrightarrow \text{DELIVERED} \longrightarrow \text{WAITING\_FOR\_RESPONSE}$$
$$\text{Response} \implies \begin{cases} \text{"Done"} & \to \text{COMPLETED} \quad (\text{marks task done, cancels pending follow-ups}) \\ \text{"Not yet"} & \to \text{NOT\_YET} \\ \text{"Tomorrow"} & \to \text{RESCHEDULED} \\ \text{"Snooze 60"} & \to \text{SNOOZED} \\ \text{"Cancel"} & \to \text{CANCELLED} \end{cases}$$

### Multi-Follow-Up Disambiguation
If multiple follow-ups are awaiting response and the user provides a bare affirmative/negative response (*"Done"*, *"Yes"*, *"Not yet"*):
- Hevn checks candidate task titles.
- If unambiguous / single candidate $\to$ executes immediately.
- If ambiguous $\to$ asks for clarification (*"Which one did you mean — [Task A] or [Task B]?"*).

---

## 6. Channel-Native Interaction & Telegram Callbacks

- **Decoupled Architecture**: `OutboundMessage` carries abstract `buttons?: ActionButton[]`.
- **Telegram Adapter**: Maps buttons into `reply_markup.inline_keyboard` (`fu:<id>:done`, `fu:<id>:not_yet`, `fu:<id>:snooze_60`).
- **Webhook Gateway**:
  1. Verifies secret token signature (`timingSafeEqual`).
  2. Deduplicates by callback ID (`tryAcquireUpdate`).
  3. Validates user ownership in `FollowUpService`.
  4. Answers callback query (`answerCallbackQuery`) to clear UI spinner.
  5. Idempotent: duplicate button clicks do not duplicate state mutations or notifications.

---

## 7. Project Intelligence & Rollups

The `ProjectService` groups tasks and commitments under projects (`project_id`).
- Deterministic application-level status rollup calculations:
  - `totalTasks`, `completedTasks`, `pendingTasks`, `overdueTasks`, `upcomingTasks`, `commitmentsCount`, `completionPercentage`.
- Conversational tool `get_project_summary` returns structured rollups for LLM rendering.

---

## 8. Follow-Through Analytics & Metrics

Calculated deterministically in `InsightsService`:
- **Completion Rate**: $\frac{\text{Completed Eligible Tasks}}{\text{Total Due Tasks}} \times 100$
- **Follow-Through Rate**: $\frac{\text{Follow-Ups Completed}}{\text{Follow-Ups Delivered}} \times 100$
- **Commitments Completed / Created**: Tracked explicitly.
- **Conversational Summary**: Natural prose generation without exposing raw metric variable names.

---

## 9. Voice Notes & Multimodal Ingestion Architecture

Voice is treated strictly as an **input modality**, not a separate assistant or bot.

```
Telegram Voice / WhatsApp Audio
              ↓
        Channel Adapter (parseIncomingWebhook)
              ↓
    Deduplication (processed_updates)
              ↓
       Audio Ingestion Service (Limits & Validation)
              ↓
  Provider-Authenticated Download (downloadAudio — SSRF Protected)
              ↓
       Transcription Service (Gemini multimodal / GoogleGenAI)
              ↓
       Normalized User Text (incoming.text)
              ↓
    Existing Conversation Core (ConversationOrchestrator)
              ↓
    Intent / Tools / TaskService / FollowUpService / MemoryService
              ↓
       Standard Response Pipeline (sendMessage)
```

### Key Principles
1. **Zero Duplicate Logic**: Transcribed speech enters `orchestrator.handleMessage` as normalized user text. Tasks, commitments, follow-ups, memories, projects, and multi-turn contexts function identically for voice and text.
2. **SSRF Prevention**: Downloads use provider-authenticated retrieval exclusively (`api.telegram.org` / `graph.facebook.com` with CDN domain whitelist). Arbitrary user-supplied URLs are never fetched.
3. **Strict Validation Limits**:
   - Max duration: 180 seconds (3 minutes)
   - Max file size: 20 MB
   - Supported MIME types: `audio/ogg`, `audio/oga`, `audio/opus`, `audio/mp3`, `audio/mpeg`, `audio/wav`, `audio/m4a`, `audio/aac`, `audio/mp4`, `audio/webm`
   - Timeout: 15,000 ms
4. **Privacy & Ephemeral Buffering**: Audio buffers are processed purely in-memory and immediately garbage collected upon transcription. No voice audio is stored on disk or in the database.


