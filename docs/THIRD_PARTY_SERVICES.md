# HEVN AI — Third-Party Services Registry & Configuration Standard

This document provides a mandatory, comprehensive registry of every external provider, account, API enablement, webhook, OAuth redirect, and credential required for HEVN AI to function in production.

---

## 1. Master Third-Party Services Matrix

| Service | Category | Required? | Account Needed? | App/API Registration? | Credentials Needed | Webhook / Redirect URL | Production Approval? | Billing Required? | Current Status |
| :--- | :--- | :---: | :---: | :---: | :--- | :--- | :---: | :---: | :--- |
| **Google AI Studio (Gemma & Gemini)** | LLM & Voice Ingestion | **Yes** | Yes (Google Account) | Yes (Create API Key in Google AI Studio) | `GEMMA_API_KEY`, `GEMINI_API_KEY` | None | No | Free tier / Pay-as-you-go | **Code Complete — API Key Required** |
| **Telegram Bot API** | Inbound / Outbound Messaging | **Yes** | Yes (Telegram Account) | Yes (`@BotFather` -> `/newbot`) | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` | `POST https://<domain>/webhook/telegram` | No | No (Free) | **Code Complete — Bot Token Configured** |
| **Meta WhatsApp Cloud API** | Inbound / Outbound Messaging | Optional / Primary | Yes (Meta Developer Account) | Yes (Meta Business App + WhatsApp Product) | `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET` | `GET/POST https://<domain>/webhook/whatsapp` | **Yes** (Business Verification) | Pay-as-you-go | **Code Complete — Account Setup Required** |
| **Google Calendar API** | Calendar Sync & Scheduling | Optional / Primary | Yes (Google Cloud Console) | Yes (GCP Project -> Enable Calendar API -> OAuth Client) | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` | `GET https://<domain>/auth/google/callback` | **Yes** (OAuth Verification for public users) | Free tier | **Code Complete — OAuth App Setup Required** |
| **CalDAV Calendar** | Calendar Sync & Scheduling | Optional | User's CalDAV provider (Apple, Nextcloud, Fastmail) | No | User-supplied app password | None | No | Varies by provider | **Code Complete** |
| **ElevenLabs TTS** | Outbound Voice Synthesis | Optional / High-Fidelity | Yes (ElevenLabs Account) | Yes (API Key) | `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` | None | No | Paid subscription | **Code Complete — Optional Provider** |
| **Google Cloud TTS** | Outbound Voice Fallback | Optional / Secondary | Yes (Google Cloud Console) | Yes (Enable Text-to-Speech API -> Create API Key) | `GOOGLE_TTS_API_KEY` | None | No | Pay-as-you-go | **Code Complete — Optional Fallback** |
| **Supabase / PostgreSQL** | Primary Persistent Store | **Yes** | Yes (Supabase / Self-hosted) | Yes (Postgres instance + RLS) | `DATABASE_URL`, `SCHEDULER_DATABASE_URL` | None | No | Free / Paid tier | **Code Complete & Configured** |

---

## 2. Detailed Service Configuration Guides

### 1. Google AI Studio & Gemini API
- **Purpose**: Powers Gemma 4 conversational reasoning, tool calling, and multimodal voice note transcription via Gemini (`gemini-2.0-flash`).
- **Setup Steps**:
  1. Navigate to [Google AI Studio](https://aistudio.google.com/).
  2. Click **Get API Key** and create a key in a Google Cloud project.
  3. Set `GEMMA_API_KEY` (and optionally `GEMINI_API_KEY`) in your environment.
- **Verification**: Run `npm run test:gemma` or `npm test __tests__/voice-audio-validation.test.ts`.

---

### 2. Telegram Bot API
- **Purpose**: Primary conversational interface for text, audio voice notes, and interactive follow-up inline buttons.
- **Setup Steps**:
  1. In Telegram, open a chat with `@BotFather`.
  2. Send `/newbot` and follow prompts to name your bot and choose a username.
  3. Copy the HTTP API token into `TELEGRAM_BOT_TOKEN`.
  4. Generate a random 32-character string for `TELEGRAM_WEBHOOK_SECRET`.
  5. Register the webhook:
     ```bash
     curl -F "url=https://<your-public-domain>/webhook/telegram" \
          -F "secret_token=<TELEGRAM_WEBHOOK_SECRET>" \
          "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook"
     ```
- **Verification**: Send a text or voice message to the bot in Telegram.

---

### 3. Meta WhatsApp Cloud API
- **Purpose**: Enterprise WhatsApp messaging interface for text, voice notes, and template notifications.
- **Setup Steps**:
  1. Open [Meta Developers Portal](https://developers.facebook.com/) and create a Business App.
  2. Add the **WhatsApp** product.
  3. Under **API Setup**, retrieve your Test Phone Number ID and Temporary Access Token (generate a System User Permanent Token in Meta Business Manager for production).
  4. Under **Configuration**, enter Webhook URL `https://<your-public-domain>/webhook/whatsapp` and set your `WHATSAPP_VERIFY_TOKEN`.
  5. Subscribe to the `messages` webhook field.
  6. Copy the **App Secret** from App Settings -> Basic into `WHATSAPP_APP_SECRET`.
- **Verification**: Send a test message or voice note to the configured WhatsApp phone number.

---

### 4. Google Calendar (OAuth 2.0)
- **Purpose**: Bi-directional calendar synchronization, free-slot discovery, conflict-aware study plan scheduling, and commitment reminders.
- **Setup Steps**:
  1. In [Google Cloud Console](https://console.cloud.google.com/), select or create a project.
  2. Navigate to **APIs & Services** -> **Library** -> Enable **Google Calendar API**.
  3. Configure the **OAuth Consent Screen**:
     - User Type: External.
     - App Name: `Hevn AI`.
     - Scopes: `https://www.googleapis.com/auth/calendar.events`, `https://www.googleapis.com/auth/calendar.readonly`.
  4. Navigate to **Credentials** -> **Create Credentials** -> **OAuth Client ID**:
     - Application Type: **Web Application**.
     - Authorized redirect URIs: `https://<your-backend-domain>/auth/google/callback` (and `http://localhost:3000/auth/google/callback` for local development).
  5. Copy Client ID and Client Secret into `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
- **Verification**: In chat, prompt the secretary: *"Connect my Google calendar"*. Click the generated secure link.

---

### 5. Outbound Voice Synthesis (ElevenLabs & Google Cloud TTS)
- **Purpose**: Multimodal voice Secretary responses (outbound voice notes).
- **ElevenLabs Setup**:
  1. Create an account on [ElevenLabs](https://elevenlabs.io/).
  2. Copy API Key from Profile -> API Keys into `ELEVENLABS_API_KEY`.
  3. Pick a voice ID (e.g. `21m00Tcm4TlvDq8ikWAM` for Rachel) into `ELEVENLABS_VOICE_ID`.
- **Google Cloud TTS Setup**:
  1. In GCP Console, enable **Cloud Text-to-Speech API**.
  2. Create an API Key with restrictions limited to Text-to-Speech API and copy into `GOOGLE_TTS_API_KEY`.
- **Verification**: Run `npm test __tests__/voice-failover-circuit-breaker.test.ts`.

---

## 3. Production Readiness Checklist

- [ ] `GEMMA_API_KEY` set and verified with Google AI Studio.
- [ ] `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET` registered via `setWebhook`.
- [ ] `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, and `WHATSAPP_APP_SECRET` configured (if using WhatsApp).
- [ ] `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI` configured with authorized callback URL in Google Cloud Console.
- [ ] `DATABASE_URL` and `SCHEDULER_DATABASE_URL` configured pointing to PostgreSQL with migration `007` applied.
- [ ] `ENCRYPTION_KEY` set with 32-character high-entropy secret.
- [ ] `ADMIN_API_KEY` set with secure 32+ character passphrase.
