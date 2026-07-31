import "dotenv/config";
import { getPool } from "../src/db/pool";
import { UserService } from "../src/core/tasks/UserService";

/**
 * Seeds a realistic week of task history for demo purposes, so the
 * weekly report / daily agenda have real data to show instead of
 * "nothing yet." This is Tier 2 honesty in action — the insights shown
 * during a demo are computed from these actual rows, not hardcoded copy.
 *
 * Run with: npx tsx scripts/seed-demo-data.ts [telegram_chat_id]
 *
 * If no chat_id is passed, seeds the CLI test user ("cli-tester") so you
 * can see it via `npm run chat` immediately. Pass your real Telegram
 * chat_id to seed data visible in the actual bot conversation.
 */

const userService = new UserService();

function daysAgo(n: number, hour = 18): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(hour, 0, 0, 0);
  return d;
}

function daysFromNow(n: number, hour = 18): Date {
  const d = new Date();
  d.setDate(d.getDate() + n);
  d.setHours(hour, 0, 0, 0);
  return d;
}

async function main() {
  const platformUserId = process.argv[2] ?? "cli-tester";
  const user = await userService.getOrCreate("telegram", platformUserId);

  console.log(`Seeding demo data for user ${user.id} (platform_user_id: ${platformUserId})...`);

  const pool = getPool();

  // Clear existing tasks for a clean seed (demo data only — safe to reset).
  await pool.query(`DELETE FROM tasks WHERE user_id = $1`, [user.id]);

  const seedTasks: Array<{
    title: string;
    dueAt: Date;
    priority: "low" | "medium" | "high";
    status: "pending" | "in_progress" | "done" | "missed";
  }> = [
    { title: "Database Assignment 3", dueAt: daysAgo(6, 14), priority: "high", status: "done" },
    { title: "Read Chapter 4 — Algorithms", dueAt: daysAgo(5, 20), priority: "low", status: "done" },
    { title: "Physics Problem Set", dueAt: daysAgo(4, 17), priority: "medium", status: "done" },
    { title: "Group Project Check-in", dueAt: daysAgo(3, 10), priority: "medium", status: "missed" },
    { title: "AI Lecture Notes Review", dueAt: daysAgo(2, 19), priority: "low", status: "done" },
    { title: "Statistics Quiz Prep", dueAt: daysAgo(1, 21), priority: "high", status: "missed" },
    { title: "Submit Research Proposal", dueAt: daysAgo(0, 16), priority: "high", status: "done" },
    // Upcoming — visible in daily agenda / get_upcoming_tasks
    { title: "Database Assignment 4", dueAt: daysFromNow(0, 20), priority: "high", status: "pending" },
    { title: "AI Lecture", dueAt: daysFromNow(1, 16), priority: "medium", status: "pending" },
    { title: "Physics Midterm", dueAt: daysFromNow(3, 9), priority: "high", status: "pending" },
  ];

  for (const t of seedTasks) {
    await pool.query(
      `INSERT INTO tasks (user_id, title, due_at, priority, status, reminder_offset_minutes)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [user.id, t.title, t.dueAt.toISOString(), t.priority, t.status, t.status === "pending" ? 30 : null]
    );
  }

  console.log(`✅ Seeded ${seedTasks.length} tasks (mix of done/missed/pending across the past week + upcoming).`);
  console.log(`\nTry asking the bot: "How am I doing this week?" or "What's on my plate?"`);
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Seed script failed:", err);
  process.exit(1);
});