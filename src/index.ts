import "dotenv/config";
import express from "express";
import helmet from "helmet";

import { GemmaClient } from "./core/gemma/GemmaClient";
import { TaskService } from "./core/tasks/TaskService";
import { UserService } from "./core/tasks/UserService";
import { ConversationOrchestrator } from "./orchestrator/ConversationOrchestrator";
import { TelegramAdapter } from "./adapters/telegram/TelegramAdapter";
import { WhatsAppAdapter } from "./adapters/whatsapp/WhatsAppAdapter";
import { registerAdapter } from "./adapters/registry";
import { buildWebhookRouter } from "./api/webhookRouter";
import { webhookRateLimiter } from "./middleware/rateLimiter";
import { InsightsService } from "./core/insights/InsightsService";
import { FollowUpService } from "./core/followup/FollowUpService";
import { AudioIngestionService } from "./core/voice/AudioIngestionService";
import { GeminiTranscriptionProvider } from "./core/voice/GeminiTranscriptionProvider";
import { logger } from "./utils/logger";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

async function main() {
  const gemmaApiKey = requireEnv("GEMMA_API_KEY");
  const gemma = new GemmaClient(
    gemmaApiKey,
    process.env.GEMMA_MODEL ?? "gemma-4-31b-it"
  );

  const taskService = new TaskService();
  const insightsService = new InsightsService();
  const userService = new UserService();
  const followUpService = new FollowUpService();
  const audioIngestionService = new AudioIngestionService(
    new GeminiTranscriptionProvider(gemmaApiKey)
  );

  const botName = process.env.BOT_NAME ?? "Hevn";

  const orchestrator = new ConversationOrchestrator(gemma, taskService, userService, insightsService);

  const telegramAdapter = new TelegramAdapter(
    requireEnv("TELEGRAM_BOT_TOKEN"),
    requireEnv("TELEGRAM_WEBHOOK_SECRET")
  );
  registerAdapter(telegramAdapter);

  const app = express();
  app.use(helmet());
  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  app.get("/health", (_req, res) => res.status(200).json({ status: "ok", bot: botName }));

  app.use(
    "/webhook/telegram",
    webhookRateLimiter,
    buildWebhookRouter(telegramAdapter, orchestrator, userService, followUpService, audioIngestionService)
  );

  if (
    process.env.WHATSAPP_ACCESS_TOKEN &&
    process.env.WHATSAPP_PHONE_NUMBER_ID &&
    process.env.WHATSAPP_APP_SECRET
  ) {
    const whatsappAdapter = new WhatsAppAdapter(
      process.env.WHATSAPP_ACCESS_TOKEN,
      process.env.WHATSAPP_PHONE_NUMBER_ID,
      process.env.WHATSAPP_APP_SECRET,
      process.env.WHATSAPP_VERIFY_TOKEN ?? ""
    );
    registerAdapter(whatsappAdapter);

    app.get("/webhook/whatsapp", (req, res) => {
      const mode = req.query["hub.mode"] as string;
      const token = req.query["hub.verify_token"] as string;
      const challenge = req.query["hub.challenge"] as string;

      if (whatsappAdapter.verifySubscription(mode, token)) {
        res.status(200).send(challenge);
      } else {
        res.sendStatus(403);
      }
    });

    app.use(
      "/webhook/whatsapp",
      webhookRateLimiter,
      buildWebhookRouter(whatsappAdapter, orchestrator, userService, followUpService, audioIngestionService)
    );
  }

  const port = Number(process.env.PORT ?? 3000);
  app.listen(port, () => {
    logger.info(`Academic Secretary (${botName}) listening on port ${port}`);
  });
}

main().catch((err) => {
  logger.error(err, "Fatal startup error");
  process.exit(1);
});
