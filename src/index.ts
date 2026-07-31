import "dotenv/config";
import express from "express";
import helmet from "helmet";
import pino from "pino";

import { GemmaClient } from "./core/gemma/GemmaClient";
import { TaskService } from "./core/tasks/TaskService";
import { UserService } from "./core/tasks/UserService";
import { ConversationOrchestrator } from "./orchestrator/ConversationOrchestrator";
import { TelegramAdapter } from "./adapters/telegram/TelegramAdapter";
import { buildWebhookRouter } from "./api/webhookRouter";
import { webhookRateLimiter } from "./middleware/rateLimiter";
import { InsightsService } from "./core/insights/InsightsService";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

async function main() {
  const gemma = new GemmaClient(
    requireEnv("GEMMA_API_KEY"),
    process.env.GEMMA_MODEL ?? "gemma-4-27b-it"
  );

  const taskService = new TaskService();
  const insightsService = new InsightsService();
  const userService = new UserService();
  const botName = process.env.BOT_NAME ?? "Hevn";

  const orchestrator = new ConversationOrchestrator(gemma, taskService, userService, insightsService);

  const telegramAdapter = new TelegramAdapter(
    requireEnv("TELEGRAM_BOT_TOKEN"),
    requireEnv("TELEGRAM_WEBHOOK_SECRET")
  );

  const app = express();
  app.use(helmet());
  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  app.get("/health", (_req, res) => res.status(200).json({ status: "ok" }));

  app.use(
    "/webhook/telegram",
    webhookRateLimiter,
    buildWebhookRouter(telegramAdapter, orchestrator, userService)
  );

  // WhatsApp router mounts the same way once WHATSAPP_* env vars are set:
  //
  // const whatsappAdapter = new WhatsAppAdapter(
  //   requireEnv("WHATSAPP_ACCESS_TOKEN"),
  //   requireEnv("WHATSAPP_PHONE_NUMBER_ID"),
  //   requireEnv("WHATSAPP_APP_SECRET"),
  //   requireEnv("WHATSAPP_VERIFY_TOKEN")
  // );
  // app.get("/webhook/whatsapp", (req, res) => { ... verifySubscription handshake ... });
  // app.use("/webhook/whatsapp", webhookRateLimiter, buildWebhookRouter(whatsappAdapter, orchestrator, userService));

  const port = Number(process.env.PORT ?? 3000);
  app.listen(port, () => {
    logger.info(`Academic PA (${botName}) listening on port ${port}`);
  });
}

main().catch((err) => {
  logger.error(err, "Fatal startup error");
  process.exit(1);
});
