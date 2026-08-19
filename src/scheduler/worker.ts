import "dotenv/config";
import cron from "node-cron";

import { TaskService } from "../core/tasks/TaskService";
import { getAdapter, initDefaultAdapters } from "../adapters/registry";
import { getPool } from "../db/pool";
import { logger } from "../utils/logger";
import "./dailyCheckIns"; // registers its own cron schedule on import

/**
 * Polls for due reminders every minute and sends them. Deliberately a
 * separate process from the webhook server (see index.ts) — a slow or
 * crashed webhook handler should never delay reminder delivery, and
 * vice versa.
 *
 * Run with: npm run worker
 */

initDefaultAdapters();
const taskService = new TaskService();

async function tick() {
  try {
    const dueTasks = await taskService.getDueRemindersBatch(100);
    if (dueTasks.length === 0) return;

    logger.info({ count: dueTasks.length }, `Processing due reminder(s)`);

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

        const adapter = getAdapter(user.platform as "telegram" | "whatsapp");
        if (!adapter) {
          logger.warn({ platform: user.platform, taskId: task.id }, "No adapter registered for platform");
          continue;
        }

        await adapter.sendMessage({
          userId: user.platform_user_id,
          text: messageText,
        });

        await taskService.markReminderSent(task.id);
      } catch (err) {
        const isPermanentFailure =
          err instanceof Error && /failed \((4\d\d)\)/i.test(err.message);

        if (isPermanentFailure) {
          logger.error({ err, taskId: task.id }, "Permanent failure sending reminder — giving up, not retrying");
          await taskService.markReminderSent(task.id);
        } else {
          logger.error({ err, taskId: task.id }, "Transient failure sending reminder — will retry next tick");
        }
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

