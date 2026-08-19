import cron from "node-cron";

import { TaskService } from "../core/tasks/TaskService";
import { getAdapter, initDefaultAdapters } from "../adapters/registry";
import { getPool } from "../db/pool";
import { logger } from "../utils/logger";

initDefaultAdapters();
const taskService = new TaskService();
const botName = process.env.BOT_NAME ?? "Hevn";

/**
 * Proactive, localized daily agenda and evening check-ins.
 * Runs hourly and checks each user's LOCAL time so "8am agenda" fires
 * at 8am in the user's own timezone, not server time.
 */

const EVENING_HOUR = 20;

async function sendDailyAgenda() {
  const { rows: users } = await getPool().query(
    `SELECT id, platform, platform_user_id, timezone, preferred_checkin_hour FROM users`
  );

  const dueNow = users.filter((u) => {
    const localHour = Number(
      new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: u.timezone }).format(new Date())
    );
    return localHour === (u.preferred_checkin_hour ?? 8);
  });

  for (const user of dueNow) {
    const tasks = await taskService.getUpcomingTasks(user.id, 10);
    const todayTasks = tasks.filter((t) => isSameLocalDay(t.dueAt, user.timezone));

    if (todayTasks.length === 0) continue; // don't message if nothing's due — avoid noise

    const lines = todayTasks
      .map((t) => `• ${t.title} — ${new Date(t.dueAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`)
      .join("\n");

    const text = `Good morning! Here's what ${botName} has on your plate today:\n${lines}`;
    await sendSafely(user.platform as "telegram" | "whatsapp", user.platform_user_id, text);
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
    await sendSafely(user.platform as "telegram" | "whatsapp", user.platform_user_id, text);
  }
}

async function sendSafely(platform: "telegram" | "whatsapp", platformUserId: string, text: string) {
  try {
    const adapter = getAdapter(platform);
    if (!adapter) {
      logger.warn({ platform, platformUserId }, "No adapter registered for scheduled check-in");
      return;
    }
    await adapter.sendMessage({ userId: platformUserId, text });
  } catch (err) {
    logger.error({ err, platform, platformUserId }, "Failed to send scheduled check-in");
  }
}

async function getUsersAtLocalHour(
  hour: number
): Promise<Array<{ id: string; platform: string; platform_user_id: string; timezone: string }>> {
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

