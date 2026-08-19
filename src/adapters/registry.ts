import type { MessagingAdapter } from "./MessagingAdapter";
import { TelegramAdapter } from "./telegram/TelegramAdapter";
import { WhatsAppAdapter } from "./whatsapp/WhatsAppAdapter";
import { logger } from "../utils/logger";

const adapters = new Map<"telegram" | "whatsapp", MessagingAdapter>();

export function registerAdapter(adapter: MessagingAdapter): void {
  adapters.set(adapter.platformName, adapter);
  logger.info({ platform: adapter.platformName }, "Registered messaging adapter");
}

export function getAdapter(platform: "telegram" | "whatsapp"): MessagingAdapter | undefined {
  return adapters.get(platform);
}

export function initDefaultAdapters(): void {
  if (process.env.TELEGRAM_BOT_TOKEN) {
    registerAdapter(
      new TelegramAdapter(
        process.env.TELEGRAM_BOT_TOKEN,
        process.env.TELEGRAM_WEBHOOK_SECRET ?? ""
      )
    );
  }

  if (
    process.env.WHATSAPP_ACCESS_TOKEN &&
    process.env.WHATSAPP_PHONE_NUMBER_ID &&
    process.env.WHATSAPP_APP_SECRET
  ) {
    registerAdapter(
      new WhatsAppAdapter(
        process.env.WHATSAPP_ACCESS_TOKEN,
        process.env.WHATSAPP_PHONE_NUMBER_ID,
        process.env.WHATSAPP_APP_SECRET,
        process.env.WHATSAPP_VERIFY_TOKEN ?? ""
      )
    );
  }
}
