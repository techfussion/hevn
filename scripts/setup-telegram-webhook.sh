#!/usr/bin/env bash
set -euo pipefail

if [ ! -f .env ]; then
  echo "❌ .env not found. Copy .env.example to .env and fill it in first."
  exit 1
fi

# Kill any stale ngrok sessions from previous interrupted runs before
# starting a new one.
pkill -f "ngrok http" 2>/dev/null || true
sleep 1

# Properly parse .env as shell syntax (handles quoted values correctly.
while IFS= read -r line || [ -n "$line" ]; do
  # skip blank lines and comments
  [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue

  if [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then
    export "$line"
  else
    echo "⚠️  Skipping malformed .env line (not KEY=VALUE format): $line"
  fi
done < .env

if [ -z "${TELEGRAM_BOT_TOKEN:-}" ] || [ -z "${TELEGRAM_WEBHOOK_SECRET:-}" ]; then
  echo "❌ TELEGRAM_BOT_TOKEN or TELEGRAM_WEBHOOK_SECRET missing from .env"
  exit 1
fi

PORT="${PORT:-3000}"

echo "Starting ngrok on port $PORT..."
ngrok http "$PORT" --log=stdout > /tmp/ngrok.log &
NGROK_PID=$!

# Ensure ngrok is actually killed on exit/Ctrl+C, so it never leaves a
# zombie session counted against your account limit again.
trap 'kill $NGROK_PID 2>/dev/null || true' EXIT

sleep 3

PUBLIC_URL=$(curl -s http://127.0.0.1:4040/api/tunnels | node -e "process.stdin.on('data', d => console.log(JSON.parse(d).tunnels[0].public_url))")

if [ -z "$PUBLIC_URL" ] || [ "$PUBLIC_URL" == "null" ]; then
  echo "❌ Couldn't retrieve ngrok public URL. Is ngrok running/authenticated? Check /tmp/ngrok.log"
  kill "$NGROK_PID" 2>/dev/null || true
  exit 1
fi

echo "✅ Tunnel live at: $PUBLIC_URL"
echo "Registering Telegram webhook..."

RESPONSE=$(curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{\"url\": \"${PUBLIC_URL}/webhook/telegram\", \"secret_token\": \"${TELEGRAM_WEBHOOK_SECRET}\"}")

echo "$RESPONSE"

OK=$(echo "$RESPONSE" | node -e "process.stdin.on('data', d => console.log(JSON.parse(d).ok))")
if [ "$OK" != "true" ]; then
  echo "❌ setWebhook failed — see response above."
  kill "$NGROK_PID" 2>/dev/null || true
  exit 1
fi

echo ""
echo "✅ Webhook registered. Now run 'npm run dev' in another terminal, then message your bot on Telegram."
echo "   (ngrok is running in the background, PID $NGROK_PID — 'kill $NGROK_PID' when done)"
echo "   ngrok logs: tail -f /tmp/ngrok.log"

wait "$NGROK_PID"