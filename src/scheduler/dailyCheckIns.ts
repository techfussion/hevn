import cron from "node-cron";
import pino from "pino";

import { TaskService } from "../core/tasks/TaskService";
import { TelegramAdapter } from "../adapters/telegram/TelegramAdapter";
import { getPool } from "../db/pool";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });
const taskService = new TaskService();

const telegramAdapter = new TelegramAdapter(
  process.env.TELEGRAM_BOT_TOKEN ?? "",
  process.env.TELEGRAM_WEBHOOK_SECRET ?? ""
);

const botName = process.env.BOT_NAME ?? "Hevn";

/**
 * IMPORTANT — WhatsApp caveat: these proactive, bot-initiated messages
 * only work as free-form sendMessage on WhatsApp if the user messaged
 * within the last 24h. For a reliable daily agenda on WhatsApp outside
 * that window, this MUST go through a Meta-approved message template
 * (sendTemplate), which requires template approval ahead of time.
 * Telegram has no such restriction — these run as-is.
 *
 * Runs hourly and checks each user's LOCAL time so "8am agenda" fires
 * at 8am in the user's own timezone, not server time.
 */

// const MORNING_HOUR = 8;
const EVENING_HOUR = 20;

async function sendDailyAgenda() {
  const { rows: users } = await getPool().query(
    `SELECT id, platform, platform_user_id, timezone, preferred_checkin_hour FROM users`
  );

  const dueNow = users.filter((u) => {
    const localHour = Number(
      new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: u.timezone }).format(new Date())
    );
    return localHour === u.preferred_checkin_hour;
  });

  for (const user of dueNow) {
    const tasks = await taskService.getUpcomingTasks(user.id, 10);
    const todayTasks = tasks.filter((t) => isSameLocalDay(t.dueAt, user.timezone));

    if (todayTasks.length === 0) continue; // don't message if nothing's due — avoid noise

    const lines = todayTasks
      .map((t) => `• ${t.title} — ${new Date(t.dueAt).toLocaleTimeString()}`)
      .join("\n");

    const text = `Good morning! Here's what ${botName} has on your plate today:\n${lines}`;

    if (user.platform === "telegram") {
      await sendSafely(user.platform_user_id, text);
    }
  }
}

async function sendEveningCheckIn() {
  const users = await getUsersAtLocalHour(EVENING_HOUR);
  for (const user of users) {
    const tasks = await taskService.getUpcomingTasks(user.id, 20);
    const dueTodayOrPast = tasks.filter(
      (t) => new Date(t.dueAt).getTime() <= Date.now() + 1000 * 60 * 60 * 4
    );

    if (dueTodayOrPast.length === 0) continue;

    const text = `Quick check-in — how did today go? You've still got ${dueTodayOrPast.length} task(s) open. Reply "done [task]" or let me know if anything should move to tomorrow.`;

    if (user.platform === "telegram") {
      await sendSafely(user.platform_user_id, text);
    }
  }
}

async function sendSafely(platformUserId: string, text: string) {
  try {
    await telegramAdapter.sendMessage({ userId: platformUserId, text });
  } catch (err) {
    logger.error({ err, platformUserId }, "Failed to send scheduled check-in");
  }
}

async function getUsersAtLocalHour(
  hour: number
): Promise<Array<{ id: string; platform: string; platform_user_id: string; timezone: string }>> {
  // Fetch all users, filter in-app by local hour.
  // for real scale, we'll need to precompute a UTC send-time per user instead.
  const { rows } = await getPool().query(`SELECT id, platform, platform_user_id, timezone FROM users`);
  return rows.filter((u) => {
    const localHour = Number(
      new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: u.timezone }).format(
        new Date()
      )
    );
    return localHour === hour;
  });
}

function isSameLocalDay(isoDate: string, timezone: string): boolean {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }); // en-CA => YYYY-MM-DD
  return fmt.format(new Date(isoDate)) === fmt.format(new Date());
}

// Check hourly rather than exactly at :00 for two fixed times — simpler
// and robust to worker restarts within the hour.
cron.schedule("0 * * * *", () => {
  sendDailyAgenda().catch((err) => logger.error({ err }, "Daily agenda job failed"));
  sendEveningCheckIn().catch((err) => logger.error({ err }, "Evening check-in job failed"));
});

logger.info("Daily check-in scheduler started (hourly local-time sweep)");
