import "dotenv/config";
import cron from "node-cron";
import pino from "pino";

import { TaskService } from "../core/tasks/TaskService";
import { UserService } from "../core/tasks/UserService";
import { TelegramAdapter } from "../adapters/telegram/TelegramAdapter";
import { getPool } from "../db/pool";
import "./dailyCheckIns"; // registers its own cron schedule on import

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });

/**
 * Polls for due reminders every minute and sends them. Deliberately a
 * separate process from the webhook server (see index.ts) — a slow or
 * crashed webhook handler should never delay reminder delivery, and
 * vice versa.
 *
 * Run with: npm run worker
 */

const taskService = new TaskService();
const userService = new UserService();

const telegramAdapter = new TelegramAdapter(
  process.env.TELEGRAM_BOT_TOKEN ?? "",
  process.env.TELEGRAM_WEBHOOK_SECRET ?? ""
);

async function tick() {
  try {
    const dueTasks = await taskService.getDueRemindersBatch(100);
    if (dueTasks.length === 0) return;

    logger.info(`Processing ${dueTasks.length} due reminder(s)`);

    for (const task of dueTasks) {
      try {
        // Look up the platform identity for this task's user.
        const { rows } = await getPool().query(
          `SELECT platform, platform_user_id FROM users WHERE id = $1`,
          [task.userId]
        );
        const user = rows[0];
        if (!user) continue;

        const dueTime = new Date(task.dueAt).toLocaleString();
        const messageText = `Reminder: "${task.title}" is due at ${dueTime}. Reply "done" once you've handled it, or "snooze 30" to push it back.`;

        if (user.platform === "telegram") {
          await telegramAdapter.sendMessage({
            userId: user.platform_user_id,
            text: messageText,
          });
        }
        // WhatsApp branch: once the adapter is wired up, business-initiated
        // reminders outside the 24h window MUST use sendTemplate with a
        // Meta-approved template, not sendMessage. See MessagingAdapter.ts.

        await taskService.markReminderSent(task.id);
      } catch (err) {
        logger.error({ err, taskId: task.id }, "Failed to send reminder for task");
        // Don't mark as sent — will retry next tick.
      }
    }
  } catch (err) {
    logger.error({ err }, "Reminder tick failed");
  }
}

// Every minute — fine-grained enough for "remind me 10 minutes before"
// without hammering the DB.
cron.schedule("* * * * *", tick);

logger.info("Reminder scheduler worker started (checking every minute)");
