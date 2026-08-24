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

---

## 3. Vulnerability Reporting

If you identify any security issue, do not commit sensitive keys or logs to version control. Report findings to the security team or create a private security advisory.

