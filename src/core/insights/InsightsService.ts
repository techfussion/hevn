import { withUserScope } from "../../db/pool";
 
/**
 * Productivity insights — computed entirely from task rows.
 */
 
export interface WeeklyReport {
  tasksCreated: number;
  tasksCompleted: number;
  tasksMissed: number;
  completionRate: number | null; // null if no tasks were due yet — avoid a misleading 0%
  bestDay: string | null; // day-of-week with highest completion rate, if enough data
  suggestions: string[];
}
 
export class InsightsService {
  async getWeeklyReport(userId: string, timezone: string): Promise<WeeklyReport> {
    return withUserScope(userId, async (client) => {
      const { rows: created } = await client.query(
        `SELECT id FROM tasks WHERE user_id = $1 AND created_at >= now() - interval '7 days'`,
        [userId]
      );
 
      const { rows: dueThisWeek } = await client.query(
        `SELECT status, due_at, updated_at
         FROM tasks
         WHERE user_id = $1
           AND due_at >= now() - interval '7 days'
           AND due_at <= now()`,
        [userId]
      );
 
      const completed = dueThisWeek.filter((t) => t.status === "done");
      const missed = dueThisWeek.filter((t) => t.status === "missed" || (t.status === "pending" && new Date(t.due_at) < new Date()));
 
      const completionRate =
        dueThisWeek.length > 0 ? Math.round((completed.length / dueThisWeek.length) * 100) : null;
 
      const bestDay = computeBestDay(completed, timezone);
      const suggestions = buildSuggestions(completionRate, missed.length, dueThisWeek.length);
 
      return {
        tasksCreated: created.length,
        tasksCompleted: completed.length,
        tasksMissed: missed.length,
        completionRate,
        bestDay,
        suggestions,
      };
    });
  }
}
 
function computeBestDay(
  completedTasks: Array<{ due_at: Date }>,
  timezone: string
): string | null {
  // Need at least a few completed tasks before "best day" means anything —
  // otherwise one lucky Tuesday looks like a trend. This threshold is a
  // judgment call, not a statistically rigorous one; it exists to avoid
  // overclaiming insight from too little data.
  if (completedTasks.length < 3) return null;
 
  const counts = new Map<string, number>();
  for (const t of completedTasks) {
    const day = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: timezone }).format(
      new Date(t.due_at)
    );
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
 
  let best: string | null = null;
  let bestCount = 0;
  for (const [day, count] of counts) {
    if (count > bestCount) {
      best = day;
      bestCount = count;
    }
  }
  return best;
}
 
function buildSuggestions(
  completionRate: number | null,
  missedCount: number,
  totalDue: number
): string[] {
  const suggestions: string[] = [];
 
  if (totalDue === 0) {
    suggestions.push("No tasks due yet this week — nothing to report on. Add a few and check back!");
    return suggestions;
  }
 
  if (completionRate !== null && completionRate < 50) {
    suggestions.push(
      "Completion rate is under half this week — consider breaking larger tasks into smaller ones."
    );
  }
  if (missedCount >= 3) {
    suggestions.push(
      `You've missed ${missedCount} tasks this week — want to review what's realistic for next week?`
    );
  }
  if (completionRate !== null && completionRate >= 80) {
    suggestions.push("Strong completion rate this week — keep it up.");
  }
 
  return suggestions;
}