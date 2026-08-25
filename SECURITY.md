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

---

## 3. Vulnerability Reporting

If you identify any security issue, do not commit sensitive keys or logs to version control. Report findings to the security team or create a private security advisory.



