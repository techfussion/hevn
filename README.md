# Hevn — Academic Secretary Bot
 
Conversational academic secretary bot. Gemma 4 for NLU/conversation + tool calling,
Telegram as the live messaging platform (WhatsApp adapter fully coded, dormant until
credentials are added), Postgres for storage.
 
## Architecture
 
- `src/adapters/` — platform-specific messaging code (Telegram, WhatsApp). Both implement
  `MessagingAdapter.ts` so the rest of the app never touches a platform SDK directly.
- `src/core/gemma/` — Gemma 4 client + tool/function declarations.
- `src/core/persona/` — system prompt / bot personality (name, tone, boundaries, injection resistance).
- `src/core/tasks/` — task and user persistence logic (all parameterized SQL, user-scoped).
- `src/core/insights/` — Tier 2 productivity report, computed from real task data only.
- `src/orchestrator/` — glues Gemma's conversation + tool calls to the task/insights services.
- `src/api/` — Express webhook router with signature verification.
- `src/scheduler/` — two independent cron jobs: reminder delivery (every minute) and
  daily agenda / evening check-in (hourly local-time sweep).
- `src/db/schema.sql` — Postgres schema with Row-Level Security policies.
- `src/db/harden-rls.sql` — optional hardening script to make RLS a real second layer (see caveat below).
- `scripts/` — standalone dev tools (see below), not part of the deployed app.
 
Two long-running processes by design: the webhook server (`npm run dev`) and the
scheduler worker (`npm run worker`). A slow webhook request should never delay a
reminder, and vice versa — that's why they're separate.
 
## Setup (in order)
 
### 1. Install dependencies
```
npm install
```
 
### 2. Database
Create a free Supabase project, then run `src/db/schema.sql` against it (SQL editor,
or `psql "$DATABASE_URL" -f src/db/schema.sql`).
 
**Use the connection pooler, not the direct connection string.** Supabase's direct
`db.<ref>.supabase.co` host is IPv6-only and fails to resolve on many networks. In
Supabase → Project Settings → Database → Connect, copy the **Transaction pooler**
string instead (host like `aws-0-<region>.pooler.supabase.com`, username
`postgres.<project-ref>`).
 
**Known RLS caveat:** the RLS policies in `schema.sql` only take effect if the app
connects as a non-owner role. Connecting as the default `postgres.<ref>` pooler user
bypasses RLS entirely (Postgres exempts table owners by default), so right now data
isolation is enforced at the application-query layer only (every query in
`TaskService.ts` / `UserService.ts` filters by `user_id`), not by RLS. To make RLS a
real second layer, run `src/db/harden-rls.sql` (creates a restricted `app_user` role
and forces RLS even for owner-equivalent access) and point `DATABASE_URL` at that role
instead. Optional for the hackathon, but worth doing if you want to genuinely claim
defense-in-depth in your pitch.
 
### 3. Gemma API key
Google AI Studio → generate an API key. **Never paste a live key into chat with
anyone, including an AI assistant** — if one is ever exposed like that, revoke and
regenerate it immediately.
 
Current valid Gemma 4 model IDs on the Gemini API: `gemma-4-4b-it`, `gemma-4-12b-it`,
`gemma-4-26b-a4b-it`, `gemma-4-31b-it`. Default here is `gemma-4-31b-it` — swap to
`gemma-4-12b-it` in `.env` if responses feel slow during testing.
 
### 4. Telegram bot
Message `@BotFather` on Telegram → `/newbot` → follow prompts → copy the token.
 
### 5. Environment
```
cp .env.example .env
```
Fill in `GEMMA_API_KEY`, `GEMMA_MODEL`, `TELEGRAM_BOT_TOKEN`, `DATABASE_URL` (pooler
string), and set `TELEGRAM_WEBHOOK_SECRET` to any random string of your choosing.
 
### 6. Sanity-check Gemma
```
npm run test:gemma
```
Three checks: task creation triggers a tool call, casual chat doesn't, and the
persona resists a basic prompt-injection attempt. Isolates Gemma/prompt issues from
messaging/webhook issues before you debug the full stack.
 
### 7. Iterate locally without Telegram
```
npm run chat
```
Terminal chat loop hitting the real orchestrator (Gemma + Postgres), no webhook or
ngrok required. Fastest loop for testing prompts, task creation, breakdown, and the
weekly report.
 
Seed realistic demo data first so the weekly report / agenda have something to show:
```
npm run seed
```
Seeds the CLI test user by default. Pass a real Telegram chat ID to seed against your
live bot instead: `npm run seed -- <telegram_chat_id>`.
 
### 8. Go live on Telegram
```
npm run webhook:setup
```
Starts ngrok and registers the webhook automatically (requires `ngrok` + `jq`
installed and ngrok authenticated). Leave it running, then in a second terminal:
```
npm run dev
```
Message your bot for real. Note: free-tier ngrok issues a new URL each restart — rerun
`webhook:setup` any time you restart the tunnel.
 
### 9. Reminders + daily check-ins
```
npm run worker
```
Separate process, runs independently of the webhook server.
 
## npm scripts reference
 
| Script | Purpose |
|---|---|
| `npm run dev` | Webhook server (Telegram/WhatsApp inbound messages) |
| `npm run worker` | Reminder polling + daily agenda/check-in cron jobs |
| `npm run chat` | Local terminal chat loop, no messaging platform needed |
| `npm run test:gemma` | Smoke test for Gemma tool-calling + persona behavior |
| `npm run seed` | Populate realistic demo task history |
| `npm run webhook:setup` | ngrok + Telegram `setWebhook` in one command |
| `npm run build` / `npm run typecheck` | Compile / type-check only |
 
## What's built
 
**Working (Tier 1):**
- Conversational task creation via Gemma function calling — free-form chat and task
  actions coexist; not every message needs a tool call
- Reminder scheduling + delivery (per-minute polling worker)
- Snooze / mark-done via natural conversation
- Daily agenda + evening check-in (hourly local-time sweep per user)
- Webhook signature verification, rate limiting, parameterized queries, RLS (see caveat above)
 
**Working (Tier 2 — real heuristics, no fabricated data):**
- Weekly productivity report (`get_weekly_report` tool) — completion rate, missed
  tasks, best day (only reported with ≥3 data points to avoid overclaiming), suggestions
- Assignment/study breakdown (`create_task_breakdown` tool) — Gemma decomposes
  multi-week goals into staggered subtasks, inserted transactionally
 
**Scaffolded, not yet enabled:**
- WhatsApp adapter (`src/adapters/whatsapp/WhatsAppAdapter.ts`) — fully implemented,
  needs Meta credentials in `.env` and two lines uncommented in `src/index.ts`.
  Remember: WhatsApp only allows free-form messages within a 24h session window;
  proactive reminders/check-ins outside that window need a Meta-approved template
  (`sendTemplate`), which takes time to get approved — plan ahead if demoing on WhatsApp.
 
**Not built (by design):**
- Burnout detection, adaptive reminder timing — need real behavioral data over weeks,
  which won't exist for a bot this young. Positioned as roadmap, not faked for demo.
 
## Security notes
 
- Every webhook request is signature-verified before any payload is touched
  (Telegram secret token / WhatsApp `X-Hub-Signature-256` HMAC).
- All queries are parameterized — no string-concatenated SQL anywhere.
- All Gemma tool-call arguments are re-validated server-side (zod schemas in
  `TaskService.ts`) before touching the database — model output is never trusted as
  pre-sanitized.
- System prompt (`systemPrompt.ts`) explicitly instructs Gemma to ignore in-message
  attempts to override its role or reveal its instructions.
- `pool.on('error', ...)` handler in `db/pool.ts` prevents idle-connection network
  blips from crashing the process — without it, a dropped DB connection takes down
  the whole app.
- `.env` is git-ignored. Never commit or paste real keys/tokens anywhere, including
  into chat with an AI assistant.
 