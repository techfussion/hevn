# Hevn AI — Security & Threat Modeling Policy

## 1. Security Architecture Overview

Hevn is engineered with defense-in-depth principles across the entire request, LLM, and data persistence lifecycle.

---

## 2. Threat Vector Mitigations

### A. Webhook Signature Spoofing & Replay Attacks
* **Telegram**: Requests must include the `X-Telegram-Bot-Api-Secret-Token` header. Verification uses `crypto.timingSafeEqual` with strict buffer length checks to protect against timing attacks.
* **WhatsApp**: Requests must include the `X-Hub-Signature-256` header. The HMAC-SHA256 digest of the raw payload buffer is computed with the App Secret and verified using `crypto.timingSafeEqual`.
* **Idempotency & Replay Prevention**: Incoming message IDs and update IDs are logged in `processed_updates` with atomic `ON CONFLICT DO NOTHING`. Replayed or duplicated network deliveries are rejected immediately.

### B. Prompt Injection & Jailbreaking
* **Dynamic System Prompt Boundaries**: System prompts are structured with non-negotiable boundaries preventing the model from acting as a general-purpose assistant, modifying prior instructions, revealing internal prompts, or fabricating data.
* **Reasoning Leak Prevention (`extractReply`)**: The `extractReply` parser isolates text behind the `REPLY:` marker. If the marker is missing, heuristic scanning discards potential chain-of-thought leaks ("I should call...", "Thinking:", "Plan:") and falls back to clean, safe messaging.

### C. Server-Side Tool Authorization & Argument Sanitization
* Tool declarations in `tools.ts` are treated purely as schema descriptors, **never as trust boundaries**.
* Every tool execution is validated using Zod schemas (`createTaskSchema`, `breakdownSchema`) before touching PostgreSQL.
* Task IDs are verified as valid UUIDs via regular expressions to prevent malformed or malicious queries.
* SQL queries are 100% parameterized (`$1, $2, ...`) without raw string interpolation.

### D. Multi-Tenant Data Isolation
* All queries run within `withUserScope(userId, clientFn)` which initializes `SET LOCAL app.current_user_id = $1` in a dedicated transaction.
* Row-Level Security (RLS) policies on `users`, `tasks`, and `conversation_turns` prevent cross-tenant data access.

### E. Rate Limiting & Resource Protection
* Express rate limiting (`express-rate-limit`) limits webhook ingestion to 20 requests per minute per IP.
* History retrieval is capped at 6 turns, and conversation history is automatically pruned to the last 50 turns per user to uphold data minimization principles.

### F. Voice Notes & Media Security Boundaries
* **SSRF Prevention**: All media downloads are restricted to verified provider endpoints.
  * Telegram: Downloads only from `api.telegram.org/file/bot<token>/...` with strict directory traversal prevention (`..` checks).
  * WhatsApp: Meta CDN download URLs are validated against a strict hostname whitelist (`.fbsbx.com`, `.fbcdn.net`, `.facebook.com`, `.whatsapp.net`). Arbitrary user-supplied URLs are never fetched.
* **Audio Input Trust Boundary**: Speech transcripts are treated as ordinary untrusted user text. Transcripts containing adversarial prompt injections or override attempts remain trapped within the `<STORED_USER_CONTEXT>` and system prompt non-negotiable boundaries.
* **Audio Size & Duration Limits**: Hardcoded validation limits (max 180s duration, max 20MB size, supported MIME types only) prevent resource exhaustion and denial-of-service.
* **Privacy & Ephemeral Audio Handling**: Audio binaries are processed in-memory as ephemeral buffers, transcribed, and immediately garbage collected. No raw audio files are stored on disk or in the database.

### G. Calendar OAuth Security & Credential Protection (P2.1 & P2.2)
* **Authenticated Encryption at Rest**: OAuth access tokens, refresh tokens, and CalDAV credentials are encrypted using AES-256-GCM (`src/utils/crypto.ts`). Each encryption operation generates a cryptographically secure 12-byte IV and a 16-byte authentication tag (`ivHex:tagHex:cipherHex`). Any ciphertext tampering fails decryption instantly.
* **Signed OAuth State & Expiry**: OAuth connection flows use HMAC-SHA256 signed state parameters (`userId.timestamp.signature`). States older than 10 minutes (600,000 ms) or with invalid signatures are rejected to prevent CSRF and authorization code interception.
* **Secret Redaction & Safe Observability**: Access tokens, refresh tokens, client secrets, and authorization codes are strictly redacted from logs, traces, error messages, and API responses using deep Pino redaction paths and `sanitizeStringForLogging`.
* **Zero-Auto-Task Guardrail**: External calendar events remain contextual reference data and never create tasks silently in the user's database.
* **Connection Lifecycle Isolation**: Broken or revoked credentials immediately transition to `reauth_required`. Broken connections are skipped during background polling, preventing repeated hammering or credential exposure.
* **External Calendar Untrusted Boundary**: Titles, descriptions, and location fields fetched from external calendars are treated as untrusted third-party inputs. The AI system prompt fences external calendar data and instructs the model to disregard injected commands contained within event summaries.
* **Multi-Tenant Calendar Isolation**: Database tables `calendar_accounts`, `connected_calendars`, and `calendar_event_links` enforce PostgreSQL Row-Level Security (`user_id = current_setting('app.current_user_id')`) ensuring absolute tenant isolation.

### H. Outbound Voice Audio Synthesis & Delivery Security (P2.3)
* **Secret Redaction & API Key Protection**: ElevenLabs API keys, Google Cloud API keys, and platform access tokens are strictly redacted using deep Pino redaction paths and `sanitizeStringForLogging`. Provider credentials never appear in telemetry, error payloads, or logs.
* **Ephemeral In-Memory Processing & Data Minimization**: Synthesized audio buffers are held purely in volatile memory for delivery and immediately released for garbage collection. Audio binaries are never written to permanent disk storage or stored in PostgreSQL.
* **Prompt Injection & Memory Non-Interference**: Stored memories, task titles, or external calendar event summaries cannot modify the voice provider, API keys, voice configuration, or channel security parameters.
* **Denial-of-Service & Resource Exhaustion Defense**:
  * Strict text synthesis caps (max 1500 characters hard limit; max 500 characters for auto-voice).
  * Request timeout protection (10 seconds via AbortController).
  * Bounded exponential backoff with full jitter (max 2 retries).
* **SSRF & Callback Prevention**: All provider communication is restricted to verified provider endpoints (`api.elevenlabs.io`, `texttospeech.googleapis.com`). Arbitrary user-supplied URLs or endpoints are never contacted.
* **Deterministic Fail-Safe Fallback**: Any failure in the synthesis or delivery pipeline automatically falls back to standard text messaging without exposing provider stack traces or internal infrastructure details to the end user.

### I. Syllabus Ingestion & Study Mode Security Boundaries (P2.4)
* **Prompt Injection Defense & Fencing**:
  * Syllabus text is enclosed in strict `<SYLLABUS_CONTENT>` isolation boundaries in model prompts.
  * System instructions explicitly forbid syllabus text from overriding instructions, reconfiguring persona/voice, elevating privileges, or creating unapproved tasks/courses.
* **Denial-of-Service & File Size Limits**:
  * Syllabus uploads enforce strict pre-ingestion validation: maximum file size of 10MB (`10 * 1024 * 1024` bytes) and maximum page count of 20 pages.
  * Files exceeding limits are rejected immediately before touching LLM processing.
* **Multi-Tenant Study Mode Isolation**:
  * Database tables `courses`, `course_topics`, `assessments`, `study_plans`, `study_sessions`, and `quizzes` enforce PostgreSQL Row-Level Security (`user_id = current_setting('app.current_user_id')`).
* **Quiz Integrity & Anti-Cheating Isolation**:
  * Quiz generation creates questions with explanations and answers stored securely in the PostgreSQL database.
  * Only the active question and options are delivered to the user; future questions and correct answer keys are never sent in conversation responses prior to submission and evaluation.
  * Topic mastery calculation is deterministic and bounded strictly between 0 and 100 at the application service layer.

### J. Background Worker Database Access & Role Isolation (P2.5.1)
* **Least-Privilege Role Isolation**: Background workers connect under the dedicated PostgreSQL role `scheduler_service`. The role is unprivileged, has zero superuser or DDL permissions, and cannot create or alter tables.
* **Targeted Worker RLS Policies**: Table Row-Level Security remains active on all 19 database tables. Controlled policies (`CREATE POLICY scheduler_worker_access ON <table> FOR ALL TO scheduler_service USING (true) WITH CHECK (true);`) grant the worker access strictly for cross-user queue operations, follow-up processing, and calendar reconciliation, while user-facing API routes continue enforcing strict per-tenant isolation (`user_id = current_setting('app.current_user_id')`).
* **Startup Capability Verification**: The worker runs `DatabaseCapabilityChecker` before entering polling loops, halting cleanly if permissions or migrations are missing to prevent infinite crashing error loops.

### K. User Conversational Identity & Privacy Safeguards (P2.5.1)
* **Anti-Government-Name Principle**: Full legal/government names are never automatically exposed or repeatedly spoken in casual chat or proactive notifications.
* **Conversational Name Fallback**: HEVN strictly enforces the priority `nameless_mode` -> `preferred_name` -> `display_name` (first name only) -> `username` -> `first_name` (from `full_name`).
* **Username Normalization & Validation**: Usernames are validated server-side (3-30 chars, alphanumeric + underscores, case-insensitive index on `LOWER(username)`). Usernames do not replace internal UUID user identifiers.
* **Nameless Mode Enforcement**: When a user specifies not to use their name, `nameless_mode` prevents any name insertion across all scheduled and on-demand assistant interactions.

---

## 3. Vulnerability Reporting

If you identify any security issue, do not commit sensitive keys or logs to version control. Report findings to the security team or create a private security advisory.



