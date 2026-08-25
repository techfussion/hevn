import "dotenv/config";
import cron from "node-cron";

import { TaskService } from "../core/tasks/TaskService";
import { FollowUpService } from "../core/followup/FollowUpService";
import { RecurringTaskService } from "../core/recurring/RecurringTaskService";
import { CalendarService } from "../core/calendar/CalendarService";
import type { CalendarAccount } from "../core/calendar/types";
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

import { AudioSynthesisService } from "../core/voice/AudioSynthesisService";
import { ResponsePolicyService } from "../core/voice/ResponsePolicyService";
import { ElevenLabsSynthesisProvider } from "../core/voice/providers/ElevenLabsSynthesisProvider";
import { GoogleCloudTtsProvider } from "../core/voice/providers/GoogleCloudTtsProvider";
import type { User } from "../types/domain";

initDefaultAdapters();
const taskService = new TaskService();
const followUpService = new FollowUpService();
const recurringService = new RecurringTaskService();

function createAudioSynthesisService(): AudioSynthesisService | undefined {
  if (process.env.ELEVENLABS_API_KEY) {
    return new AudioSynthesisService(
      new ElevenLabsSynthesisProvider({ apiKey: process.env.ELEVENLABS_API_KEY })
    );
  }
  if (process.env.GEMMA_API_KEY) {
    return new AudioSynthesisService(
      new GoogleCloudTtsProvider({ apiKey: process.env.GEMMA_API_KEY })
    );
  }
  return undefined;
}

const audioSynthesisService = createAudioSynthesisService();
const responsePolicyService = new ResponsePolicyService(audioSynthesisService);

async function processReminders() {
  const dueTasks = await taskService.getDueRemindersBatch(100);
  if (dueTasks.length === 0) return;

  logger.info({ count: dueTasks.length }, "Processing due reminder(s)");

  for (const task of dueTasks) {
    try {
      const { rows } = await getPool().query(
        `SELECT id, platform, platform_user_id, timezone, quiet_hours_start, quiet_hours_end, response_mode, voice_enabled, voice_name, voice_language FROM users WHERE id = $1`,
        [task.userId]
      );
      const row = rows[0];
      if (!row) continue;

      const user: User = {
        id: row.id,
        platform: row.platform,
        platformUserId: row.platform_user_id,
        displayName: null,
        timezone: row.timezone || "UTC",
        onboarded: true,
        onboardingState: "COMPLETED",
        assistantName: "Hevn",
        botPersona: "Hevn",
        persona: "professional",
        preferredCheckinTime: "06:00",
        preferredCheckinHour: 6,
        plan: "free",
        followupPreference: "active",
        quietHoursStart: row.quiet_hours_start,
        quietHoursEnd: row.quiet_hours_end,
        responseMode: row.response_mode || "auto",
        voiceEnabled: row.voice_enabled !== false,
        voiceName: row.voice_name || null,
        voiceLanguage: row.voice_language || null,
        createdAt: new Date().toISOString(),
      };

      const dueTime = new Date(task.dueAt).toLocaleString();
      const messageText = `Reminder: "${task.title}" is approaching (due at ${dueTime}). Reply "done" once you've handled it, or "snooze 30" to delay.`;

      const adapter = getAdapter(user.platform as "telegram" | "whatsapp");
      if (!adapter) {
        logger.warn({ platform: user.platform, taskId: task.id }, "No adapter registered for platform");
        continue;
      }

      await responsePolicyService.deliverResponse(
        adapter,
        user,
        {
          userId: user.platformUserId,
          text: messageText,
        }
      );

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
        `SELECT u.id, u.platform, u.platform_user_id, u.timezone, u.quiet_hours_start, u.quiet_hours_end, u.followup_preference,
                u.response_mode, u.voice_enabled, u.voice_name, u.voice_language,
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

      const user: User = {
        id: row.id,
        platform: row.platform,
        platformUserId: row.platform_user_id,
        displayName: null,
        timezone: row.timezone || "UTC",
        onboarded: true,
        onboardingState: "COMPLETED",
        assistantName: "Hevn",
        botPersona: "Hevn",
        persona: "professional",
        preferredCheckinTime: "06:00",
        preferredCheckinHour: 6,
        plan: "free",
        followupPreference: row.followup_preference || "active",
        quietHoursStart: row.quiet_hours_start,
        quietHoursEnd: row.quiet_hours_end,
        responseMode: row.response_mode || "auto",
        voiceEnabled: row.voice_enabled !== false,
        voiceName: row.voice_name || null,
        voiceLanguage: row.voice_language || null,
        createdAt: new Date().toISOString(),
      };

      const messageText = `Following up on "${row.title}" — have you managed to get this done? Reply "done", "not yet", or let me know when to check back.`;

      const buttons =
        row.platform === "telegram"
          ? [
              { label: "Done", action: `fu:${followUp.id}:done` },
              { label: "Not Yet", action: `fu:${followUp.id}:not_yet` },
              { label: "+1 Hour", action: `fu:${followUp.id}:snooze_60` },
            ]
          : undefined;

      await responsePolicyService.deliverResponse(
        adapter,
        user,
        {
          userId: row.platform_user_id,
          text: messageText,
          buttons,
        }
      );

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

const calendarService = new CalendarService();

async function processCalendarSync() {
  const startTime = Date.now();
  try {
    const { rows } = await getPool().query(
      `SELECT id, user_id, provider
       FROM calendar_accounts
       WHERE status = 'active'
         AND (last_sync_at IS NULL OR last_sync_at < now() - INTERVAL '15 minutes')
       LIMIT 10`
    );

    for (const acc of rows) {
      try {
        const calendars = await calendarService.getSelectedCalendars(acc.user_id);
        const provider = calendarService.getProvider(acc.provider);
        const accounts = await calendarService.getAccounts(acc.user_id);
        const account = accounts.find((a: CalendarAccount) => a.id === acc.id);

        if (account && provider.incrementalSync) {
          for (const cal of calendars) {
            try {
              const syncResult = await provider.incrementalSync(account, cal.externalCalendarId, cal.syncToken || undefined);
              if (syncResult.nextSyncToken) {
                await getPool().query(
                  `UPDATE connected_calendars
                   SET sync_token = $1, last_sync_at = now(), updated_at = now()
                   WHERE id = $2`,
                  [syncResult.nextSyncToken, cal.id]
                );
              }
            } catch (calErr: unknown) {
              logger.warn({ calErr, calendarId: cal.id }, "Calendar incremental sync failed for calendar");
            }
          }
        }

        await getPool().query(
          `UPDATE calendar_accounts SET last_sync_at = now(), updated_at = now() WHERE id = $1`,
          [acc.id]
        );

        calendarService.emitMetric({
          eventType: "calendar.sync.success",
          userId: acc.user_id,
          provider: acc.provider,
          durationMs: Date.now() - startTime,
        });
      } catch (err: unknown) {
        if (err instanceof Error && err.name === "ReauthRequiredError") {
          await calendarService.updateAccountStatus(
            acc.user_id,
            acc.id,
            "reauth_required",
            "INVALID_GRANT",
            err.message
          );
        }
        logger.warn({ err, accountId: acc.id }, "Background calendar account sync failed");
      }
    }
  } catch (err) {
    logger.warn({ err }, "Periodic calendar sync check failed");
  }
}

async function tick() {
  try {
    await processReminders();
    await processFollowUps();
    await processRecurringTasks();
    await processCalendarSync();
  } catch (err) {
    logger.error({ err }, "Worker tick failed");
  }
}

// Every minute — fine-grained enough for reminders & follow-ups
cron.schedule("* * * * *", tick);

logger.info("Hevn P2 background worker started (reminders, follow-ups, recurring tasks, calendar sync)");


