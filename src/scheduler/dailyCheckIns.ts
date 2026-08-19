import cron from "node-cron";

import { TaskService } from "../core/tasks/TaskService";
import { getAdapter, initDefaultAdapters } from "../adapters/registry";
import { getPool } from "../db/pool";
import { logger } from "../utils/logger";

initDefaultAdapters();
const taskService = new TaskService();

/**
 * Proactive, localized daily check-ins.
 * Runs hourly and checks each user's LOCAL time so "6am/8am check-in" fires
 * at that hour in the user's own timezone.
 */

const EVENING_HOUR = 20;

async function sendDailyAgenda() {
  const { rows: users } = await getPool().query(
    `SELECT id, platform, platform_user_id, display_name, assistant_name, bot_persona, timezone, preferred_checkin_hour, onboarded, onboarding_state FROM users`
  );

  const dueNow = users.filter((u) => {
    if (!u.onboarded && u.onboarding_state !== "COMPLETED") return false;
    const localHour = Number(
      new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: u.timezone || "UTC" }).format(new Date())
    );
    return localHour === (u.preferred_checkin_hour ?? 6);
  });

  for (const user of dueNow) {
    const tasks = await taskService.getUpcomingTasks(user.id, 10);
    const todayTasks = tasks.filter((t) => isSameLocalDay(t.dueAt, user.timezone || "UTC"));

    const name = user.display_name ? ` ${user.display_name}` : "";
    let text = "";

    if (todayTasks.length > 0) {
      const lines = todayTasks
        .map((t) => `• ${t.title} — ${new Date(t.dueAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`)
        .join("\n");
      text = `Good morning${name}! What are we getting done today?\n\nHere's what is currently on your plate:\n${lines}`;
    } else {
      text = `Good morning${name}! What are we getting done today? Tell me what's on your mind and I'll keep track of it.`;
    }

    await sendSafely(user.platform as "telegram" | "whatsapp", user.platform_user_id, text);
  }
}

async function sendEveningCheckIn() {
  const users = await getUsersAtLocalHour(EVENING_HOUR);
  for (const user of users) {
    if (!user.onboarded && user.onboarding_state !== "COMPLETED") continue;
    const tasks = await taskService.getUpcomingTasks(user.id, 20);
    const dueTodayOrPast = tasks.filter(
      (t) => new Date(t.dueAt).getTime() <= Date.now() + 1000 * 60 * 60 * 4
    );

    if (dueTodayOrPast.length === 0) continue;

    const text = `Quick check-in — how did today go? You've still got ${dueTodayOrPast.length} item(s) open. Reply "done [item]" or let me know if anything should move to tomorrow.`;
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
): Promise<Array<{ id: string; platform: string; platform_user_id: string; timezone: string; onboarded: boolean; onboarding_state: string }>> {
  const { rows } = await getPool().query(`SELECT id, platform, platform_user_id, timezone, onboarded, onboarding_state FROM users`);
  return rows.filter((u) => {
    const localHour = Number(
      new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: u.timezone || "UTC" }).format(
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

// Check hourly
cron.schedule("0 * * * *", () => {
  sendDailyAgenda().catch((err) => logger.error({ err }, "Daily agenda job failed"));
  sendEveningCheckIn().catch((err) => logger.error({ err }, "Evening check-in job failed"));
});

logger.info("Daily check-in scheduler started (hourly local-time sweep)");
