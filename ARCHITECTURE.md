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

---

## 10. External Calendar Integration & Calendar-Aware Secretary (P2.1)

External calendar capability is implemented as an integration layer of Hevn Core, maintaining Hevn's identity as a singular conversational secretary rather than a standalone calendar assistant.

```
Telegram / WhatsApp / Voice
              ↓
     Conversation Core (ConversationOrchestrator)
              ↓
  LLM Tool Invocation (list_calendar_events, check_calendar_availability, create_calendar_event, etc.)
              ↓
      Schema Validation & Authorization Guardrails (Zod + LLM Authority Boundary)
              ↓
       Calendar Service (CalendarService)
              ↓
    ┌───────────────────────────────┬───────────────────────────────┐
    ↓                               ↓                               ↓
Google Calendar Provider        CalDAV Calendar Provider      Availability Engine
(OAuth2, freeBusy, syncToken)   (RFC 4791, iCal RFC 5545)     (Interval Merging)
    ↓                               ↓                               ↓
Google Calendar API v3          Apple iCloud / Nextcloud / CalDAV Database & External Busy Slots
```

### Architectural Principles

1. **Zero Task Pollution & Source-of-Truth Separation**:
   - External calendar events are treated as **contextual schedule data**, NOT auto-created internal tasks.
   - Syncing an external calendar never pollutes the user's task database.
   - **Zero-Auto-Task Guardrail**: When an event or commitment is detected, Hevn can proactively suggest preparation in conversation, but never silently creates tasks.

2. **Availability Calculation Engine**:
   - Computes real-time availability across both external calendar events and internal Hevn commitments/tasks.
   - Normalizes and merges overlapping busy intervals:
     $$\bigcup [S_i, E_i] \to \text{Disjoint Busy Blocks}$$
   - Computes continuous free time slots matching minimum duration requirements within user-specified search windows.

3. **Two-Way Idempotent Sync & Connection Lifecycle**:
   - Explicit commitments (`taskType: 'commitment'`) created in Hevn can be mirrored to the user's primary external calendar via `calendar_event_links`.
   - External event IDs and ETags are tracked to ensure updates and re-syncs are idempotent and do not duplicate calendar entries.
   - **Connection State Machine**: Accounts transition `active` → `reauth_required` upon revoked or expired refresh credentials (e.g. `invalid_grant`). Broken connections are skipped during sync to prevent hammering; users receive friendly conversational prompts with reconnect links.

4. **HTTP Resilience & Rate Limit Backoff**:
   - All external calendar provider calls utilize `fetchWithRetry` ([`src/utils/http.ts`](file:///Users/macbookpro/Documents/web_projects/hevn/src/utils/http.ts)).
   - Implements bounded exponential backoff with full jitter for transient 5xx errors and network drops.
   - Parses HTTP 429 `Retry-After` headers (supporting integer seconds and RFC 7231 HTTP dates).
   - Fast-fails non-retryable 4xx client errors (400, 401, 403, 404).
   - Enforces `AbortController` timeout protection (default 10s).

5. **Conflict-Aware Scheduling Foundation (`findAvailableSlots`)**:
   - Computes continuous free time windows matching requested `durationMinutes`.
   - Supports configurable buffer padding before and after meetings (`preferences.bufferMinutes`).
   - Respects user quiet hours across midnight boundaries (e.g., 22:00 to 07:00).
   - Bounded by maximum requested slots (`preferences.maxSlots`).

6. **Timezone Normalization & Recurrence**:
   - All-day events are normalized to exact UTC midnight-to-midnight spans in the user's local timezone using timezone offset inverse transformation (`normalizeAllDayBounds`).
   - Recurring events are expanded into single instances (`singleEvents: true`), preserving parent `recurringEventId` and recurrence exceptions (`RECURRENCE-ID`). Cancelled instances are excluded from availability.

7. **Security, Observability & Redaction**:
   - OAuth tokens (`access_token`, `refresh_token`) and CalDAV credentials are encrypted at rest using **AES-256-GCM** with unique 96-bit initialization vectors and authentication tags (`iv:tag:ciphertext`).
   - OAuth authorization states are signed with HMAC-SHA256 and enforce a strict 10-minute expiry window.
   - Deep Pino redaction and `sanitizeStringForLogging` guarantee zero token secrets appear in logs, error payloads, or traces.
   - Emits structured telemetry metrics (`calendar.sync.success`, `calendar.oauth.reauth_required`, `calendar.sync.failure`).

---

## 11. Outbound Audio & Multimodal Response Architecture (P2.3)

P2.3 completes the multimodal secretary loop with outbound audio capabilities, notification intelligence, and production-grade resilience.

```
Incoming Message (Text or Voice)
              ↓
   Channel Adapter (Telegram / WhatsApp)
              ↓
  Input Normalization & Inbound Transcribe
              ↓
   Conversation Orchestrator (Canonical Business Logic)
              ↓
    Core Domain Services (TaskService, FollowUpService, CalendarService, etc.)
              ↓
    Generated Secretary Reply Text
              ↓
    Response Policy Engine (ResponsePolicyService)
    ├── User Preference Check (response_mode: text | voice | auto)
    ├── Channel Capabilities Check (capabilities.audioOutput)
    └── Length & Modality Evaluation (maxAutoVoiceLength / maxTextLength)
              ↓
┌───────────────────────────────┴───────────────────────────────┐
↓                                                               ↓
Audio Synthesis (AudioSynthesisService)                 Direct Text Delivery
├── In-Memory LRU Cache Lookup (SHA-256)                        ↓
├── Provider Adapter (ElevenLabs / Google TTS)          adapter.sendMessage(text)
├── Timeout & HTTP Retry Protection (fetchWithRetry)
└── Outbound Audio Payload (OutboundAudio)
              ↓
  Channel Delivery (sendAudio / sendVoice)
  ├── Telegram: multipart sendVoice with inline buttons
  ├── WhatsApp: media upload & audio dispatch
  └── On Failure: Automatic Graceful Fallback → adapter.sendMessage
```

### Architectural Principles

1. **Zero Assistant Duplication**:
   - Voice is strictly an I/O modality of the existing secretary.
   - All domain services (tasks, reminders, commitments, follow-ups, memory, projects, and calendar) remain the canonical source of truth.

2. **Deterministic Response Policy (`ResponsePolicyService`)**:
   - The LLM is never responsible for deciding whether the infrastructure can send audio. That decision belongs 100% to application code.
   - Evaluates:
     - `user.response_mode === 'text'`: always delivers text.
     - `user.response_mode === 'voice'`: attempts audio, automatically falling back to text on failure.
     - `user.response_mode === 'auto'`: produces voice only when incoming message was voice and text length $\le 500$ characters.
     - Channel capabilities: never attempts audio on channels without `audioOutput: true`.

3. **Provider Abstraction (`AudioSynthesisProvider`)**:
   - The domain depends only on the `AudioSynthesisProvider` contract, decoupled from ElevenLabs or Google Cloud TTS.
   - Uses `fetchWithRetry` for exponential backoff, jitter, and timeout protection.

4. **In-Memory Caching & Cost Protection**:
   - LRU / TTL cache keyed by SHA-256 hash of text + voice settings prevents duplicate provider synthesis requests.
   - Strict character length limits (500 chars for auto voice, 1500 chars hard limit).

5. **Voice Follow-Ups with Inline Interactive Buttons**:
   - `FollowUpService` state machine is preserved. Follow-ups can be presented as audio notes with inline callback buttons (`[Done] [Not Yet] [+1 Hour]`) on Telegram.

6. **Structured Telemetry & Deterministic Metrics (`VoiceMetricsService`)**:
   - Emits structured events: `voice.synthesis.started`, `voice.synthesis.success`, `voice.synthesis.failure`, `voice.delivery.success`, `voice.delivery.failure`, `voice.delivery.fallback_text`.
   - Tracks metrics: `voiceSynthesisRequests`, `voiceSynthesisSuccesses`, `voiceSynthesisFailures`, `voiceDeliverySuccesses`, `voiceDeliveryFailures`, `voiceTextFallbacks`, `averageSynthesisLatency`, `synthesisTimeoutCount`.
   - Zero sensitive tokens or raw audio logged.

---

## 12. Advanced Student Study Mode Architecture (P2.4)

P2.4 introduces the first-class academic study subsystem directly integrated into Hevn's secretary orchestrator without duplicating conversational state, tasks, or calendars.

```
Student Inbound Message (Text / Voice / Syllabus Document)
                        ↓
            Conversation Orchestrator
                        ↓
┌───────────────────────┴───────────────────────┐
↓                                               ↓
Academic Syllabus Ingestion & Parsing      Active Study Tools Execution
├── <SYLLABUS_CONTENT> Fencing Boundary         ├── CourseService (Courses, Topics, Assessments)
├── PDF & Text Size / Page Limiting             ├── StudyPlanService (Calendar-aware session slots)
└── Structured Course / Topic / Exam Extraction ├── QuizService (Multi-Turn State Machine)
                                                ├── FlashcardService (High-Yield Active Recall)
                                                └── StudyRecommendationService & InsightsService
                                                        ↓
                                         Canonical Hevn Core Entities
                                         ├── Tasks (Due dates, 15m/24h reminder offsets)
                                         ├── CalendarAvailability (findAvailableSlots)
                                         └── PostgreSQL Database (RLS per tenant)
```

### Core Architecture Components

1. **Zero Architecture Duplication**:
   - Study Mode is NOT a separate chatbot or second conversation engine.
   - Study sessions and assessment milestones create canonical Hevn `tasks` with `taskType: 'commitment'` or `taskType: 'task'` and standard reminder offsets (1440m for exams, 15m for study sessions).
   - Time slot discovery uses existing `CalendarService.findAvailableSlots()`.

2. **Syllabus Ingestion Security (`SyllabusIngestionService`)**:
   - Fences syllabus content inside `<SYLLABUS_CONTENT>` tags in LLM prompts.
   - Enforces strict input validation: 10MB maximum file size, 20 maximum page count.
   - Gracefully handles unstructured text and PDF buffers into structured course models.

3. **Deterministic Multi-Turn Quiz State Machine (`QuizService`)**:
   - PostgreSQL-backed state lifecycle: `CREATED -> ACTIVE -> ANSWERING -> COMPLETED -> REVIEWED`.
   - Questions and explanations are generated and stored securely in the database.
   - Sequentially serves active questions one at a time, evaluates user responses, explains rationales, and adjusts topic mastery levels (0–100 bounded).

4. **Calendar-Aware Study Planner (`StudyPlanService`)**:
   - Distributes course topic study workloads across available calendar gaps prior to target exam dates.
   - Provides clear explanations when available calendar time is insufficient.
   - Automatically provisions reminder-enabled tasks and supports dynamic session rescheduling.

5. **Active Recall Flashcards (`FlashcardService`)**:
   - Generates structured, high-yield flashcard decks tailored to topic concepts.
   - Implements `formatDeckForChat` for clean mobile conversational presentation with fallback safety.

6. **Academic Insights & Adaptive Recommendations (`InsightsService` & `StudyRecommendationService`)**:
   - Evaluates study session adherence rate, quiz accuracy %, and weakest/strongest topics adhering to the null/empty-data philosophy.
   - Generates prioritized topic recommendations weighted by upcoming assessment urgency and mastery deficit.






