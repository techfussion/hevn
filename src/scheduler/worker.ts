import "dotenv/config";
import cron from "node-cron";

import { TaskService } from "../core/tasks/TaskService";
import { FollowUpService } from "../core/followup/FollowUpService";
import { RecurringTaskService } from "../core/recurring/RecurringTaskService";
import { getAdapter, initDefaultAdapters } from "../adapters/registry";
import { getPool } from "../db/pool";
import { logger } from "../utils/logger";
import "./dailyCheckIns"; // registers daily morning/evening check-in schedules on import

/**
 * Hevn Background Worker.
 * Polls every minute for:
 * 1. Due reminders (pre-deadline heads-up)
 * 2. Due follow-ups (post-deadline completion check, respecting quiet hours)
 * 3. Due recurring task schedules (daily/weekly/weekdays recurrence advancement)
 *
 * Run with: npm run worker
 */

initDefaultAdapters();
const taskService = new TaskService();
const followUpService = new FollowUpService();
const recurringService = new RecurringTaskService();

async function processReminders() {
  const dueTasks = await taskService.getDueRemindersBatch(100);
  if (dueTasks.length === 0) return;

  logger.info({ count: dueTasks.length }, "Processing due reminder(s)");

  for (const task of dueTasks) {
    try {
      const { rows } = await getPool().query(
        `SELECT platform, platform_user_id, timezone, quiet_hours_start, quiet_hours_end FROM users WHERE id = $1`,
        [task.userId]
      );
      const user = rows[0];
      if (!user) continue;

      const dueTime = new Date(task.dueAt).toLocaleString();
      const messageText = `Reminder: "${task.title}" is approaching (due at ${dueTime}). Reply "done" once you've handled it, or "snooze 30" to delay.`;

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
}

async function processFollowUps() {
  const dueFollowUps = await followUpService.getDueFollowUpsBatch(100);
  if (dueFollowUps.length === 0) return;

  logger.info({ count: dueFollowUps.length }, "Processing due follow-up(s)");

  for (const followUp of dueFollowUps) {
    try {
      const { rows } = await getPool().query(
        `SELECT u.platform, u.platform_user_id, u.timezone, u.quiet_hours_start, u.quiet_hours_end, u.followup_preference,
                t.title, t.status as task_status
         FROM users u
         JOIN tasks t ON t.id = $1
         WHERE u.id = $2`,
        [followUp.taskId, followUp.userId]
      );
      const row = rows[0];
      if (!row || row.task_status === "done" || row.followup_preference === "off") {
        await followUpService.handleFollowUpResponse(followUp.userId, followUp.id, "cancelled");
        continue;
      }

      // Check quiet hours
      const now = new Date();
      const inQuietHours = followUpService.isWithinQuietHours(
        now,
        row.timezone || "UTC",
        row.quiet_hours_start,
        row.quiet_hours_end
      );

      if (inQuietHours && row.quiet_hours_end) {
        // Shift follow-up to end of quiet hours rather than disturbing user
        const resumeTime = followUpService.calculateQuietHoursEnd(
          now,
          row.timezone || "UTC",
          row.quiet_hours_end
        );
        await followUpService.handleFollowUpResponse(
          followUp.userId,
          followUp.id,
          "reschedule",
          resumeTime.toISOString()
        );
        logger.info({ followUpId: followUp.id, resumeTime }, "Deferred follow-up during quiet hours");
        continue;
      }

      const adapter = getAdapter(row.platform as "telegram" | "whatsapp");
      if (!adapter) {
        logger.warn({ platform: row.platform, followUpId: followUp.id }, "No adapter registered for platform");
        continue;
      }

      const messageText = `Following up on "${row.title}" — have you managed to get this done? Reply "done", "not yet", or let me know when to check back.`;

      await adapter.sendMessage({
        userId: row.platform_user_id,
        text: messageText,
      });

      await followUpService.markDelivered(followUp.id);
    } catch (err) {
      logger.error({ err, followUpId: followUp.id }, "Failed to process follow-up");
    }
  }
}

async function processRecurringTasks() {
  const dueRecurring = await recurringService.getDueRecurringTasksBatch(50);
  if (dueRecurring.length === 0) return;

  logger.info({ count: dueRecurring.length }, "Processing due recurring task(s)");

  for (const item of dueRecurring) {
    try {
      // Create a fresh task instance for this occurrence
      await taskService.createTask(item.userId, {
        title: item.title,
        dueAtIso: item.nextRunAt,
        priority: item.priority,
        taskType: "task",
        isSystemGenerated: true,
        reminderOffsetMinutes: 30,
      });

      // Advance schedule to next occurrence
      await recurringService.advanceOccurrence(item);
    } catch (err) {
      logger.error({ err, recurringId: item.id }, "Failed to process recurring task occurrence");
    }
  }
}

async function tick() {
  try {
    await processReminders();
    await processFollowUps();
    await processRecurringTasks();
  } catch (err) {
    logger.error({ err }, "Worker tick failed");
  }
}

// Every minute — fine-grained enough for reminders & follow-ups
cron.schedule("* * * * *", tick);

logger.info("Hevn P1 background worker started (reminders, follow-ups, recurring tasks)");
