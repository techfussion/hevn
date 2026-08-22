import { z } from "zod";
import { withUserScope, getSchedulerPool } from "../../db/pool";
import type { RecurringTask, RecurrencePattern, TaskPriority, RecurringTaskStatus } from "../../types/domain";

const timeOfDayRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;

const createRecurringSchema = z.object({
  title: z.string().min(1).max(200),
  recurrencePattern: z.enum(["daily", "weekly", "weekdays", "custom"]).default("daily"),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).nullable().optional(),
  timeOfDay: z.string().regex(timeOfDayRegex).default("09:00"),
  timezone: z.string().default("UTC"),
  priority: z.enum(["low", "medium", "high"]).default("medium"),
});

export class RecurringTaskService {
  /**
   * Creates a new recurring task schedule with the next occurrence computed in the user's timezone.
   */
  async createRecurringTask(userId: string, input: unknown): Promise<RecurringTask> {
    const parsed = createRecurringSchema.parse(input);

    const nextRun = computeNextOccurrence(
      parsed.recurrencePattern,
      parsed.timeOfDay,
      parsed.daysOfWeek ?? null,
      parsed.timezone,
      new Date()
    );

    return withUserScope(userId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO recurring_tasks (
           user_id, title, recurrence_pattern, days_of_week, time_of_day,
           timezone, priority, status, next_run_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8)
         RETURNING *`,
        [
          userId,
          parsed.title,
          parsed.recurrencePattern,
          parsed.daysOfWeek ?? null,
          parsed.timeOfDay,
          parsed.timezone,
          parsed.priority,
          nextRun.toISOString(),
        ]
      );
      return mapRecurringRow(rows[0]);
    });
  }

  async listRecurringTasks(userId: string): Promise<RecurringTask[]> {
    return withUserScope(userId, async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM recurring_tasks WHERE user_id = $1 AND status != 'cancelled' ORDER BY created_at ASC`,
        [userId]
      );
      return rows.map(mapRecurringRow);
    });
  }

  async cancelRecurringTask(userId: string, id: string): Promise<boolean> {
    if (!isUuid(id)) return false;
    return withUserScope(userId, async (client) => {
      const { rowCount } = await client.query(
        `UPDATE recurring_tasks SET status = 'cancelled', updated_at = now() WHERE id = $1 AND user_id = $2`,
        [id, userId]
      );
      return (rowCount ?? 0) > 0;
    });
  }

  async getDueRecurringTasksBatch(limit = 100): Promise<RecurringTask[]> {
    const pool = getSchedulerPool();
    const { rows } = await pool.query(
      `SELECT * FROM recurring_tasks
       WHERE status = 'active' AND next_run_at <= now()
       ORDER BY next_run_at ASC
       LIMIT $1`,
      [limit]
    );
    return rows.map(mapRecurringRow);
  }

  async advanceOccurrence(recurring: RecurringTask): Promise<RecurringTask | null> {
    const nextRun = computeNextOccurrence(
      recurring.recurrencePattern,
      recurring.timeOfDay,
      recurring.daysOfWeek,
      recurring.timezone,
      new Date()
    );

    const pool = getSchedulerPool();
    const { rows } = await pool.query(
      `UPDATE recurring_tasks
       SET last_run_at = now(),
           next_run_at = $1,
           updated_at = now()
       WHERE id = $2
       RETURNING *`,
      [nextRun.toISOString(), recurring.id]
    );

    return rows[0] ? mapRecurringRow(rows[0]) : null;
  }
}

/**
 * Computes the next occurrence timestamp in ISO format taking timezone and recurrence rules into account.
 */
export function computeNextOccurrence(
  pattern: RecurrencePattern,
  timeOfDay: string,
  daysOfWeek: number[] | null,
  timezone: string,
  afterDate: Date = new Date()
): Date {
  const [hourStr, minStr] = timeOfDay.split(":");
  const targetHour = parseInt(hourStr || "9", 10);
  const targetMin = parseInt(minStr || "0", 10);

  // Use Intl to step through calendar days in the target timezone
  const tz = timezone || "UTC";

  // Check up to 14 days ahead
  for (let dayOffset = 0; dayOffset <= 14; dayOffset++) {
    const candidateUtc = new Date(afterDate.getTime() + dayOffset * 24 * 60 * 60 * 1000);
    const candidateDateStr = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(candidateUtc); // YYYY-MM-DD

    // Construct local target datetime string
    const localTargetStr = `${candidateDateStr}T${String(targetHour).padStart(2, "0")}:${String(targetMin).padStart(2, "0")}:00`;
    
    // Parse in target timezone
    const targetUtc = parseInTimezone(localTargetStr, tz);

    if (targetUtc.getTime() <= afterDate.getTime()) {
      continue; // in the past relative to afterDate
    }

    // Check pattern matching
    const dayOfWeekInTz = getDayOfWeekInTz(targetUtc, tz);

    if (pattern === "daily") {
      return targetUtc;
    }

    if (pattern === "weekdays") {
      // Mon=1, Tue=2, Wed=3, Thu=4, Fri=5
      if (dayOfWeekInTz >= 1 && dayOfWeekInTz <= 5) {
        return targetUtc;
      }
    }

    if (pattern === "weekly") {
      const allowedDays = daysOfWeek && daysOfWeek.length > 0 ? daysOfWeek : [1]; // default Monday
      if (allowedDays.includes(dayOfWeekInTz)) {
        return targetUtc;
      }
    }

    if (pattern === "custom") {
      return targetUtc;
    }
  }

  // Fallback: 24 hours later
  return new Date(afterDate.getTime() + 24 * 60 * 60 * 1000);
}

function parseInTimezone(isoLocalStr: string, timezone: string): Date {
  // Approximate with standard date construction and offset adjustment
  const localDate = new Date(`${isoLocalStr}Z`);
  const tzOffset = getTimezoneOffset(timezone, localDate);
  return new Date(localDate.getTime() + tzOffset);
}

function getTimezoneOffset(timezone: string, date: Date): number {
  const utcDate = new Date(date.toLocaleString("en-US", { timeZone: "UTC" }));
  const tzDate = new Date(date.toLocaleString("en-US", { timeZone: timezone || "UTC" }));
  return utcDate.getTime() - tzDate.getTime();
}

function getDayOfWeekInTz(date: Date, timezone: string): number {
  const shortWeekday = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: timezone }).format(date);
  switch (shortWeekday) {
    case "Sun": return 0;
    case "Mon": return 1;
    case "Tue": return 2;
    case "Wed": return 3;
    case "Thu": return 4;
    case "Fri": return 5;
    case "Sat": return 6;
    default: return 1;
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function mapRecurringRow(row: Record<string, unknown>): RecurringTask {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    title: row.title as string,
    recurrencePattern: row.recurrence_pattern as RecurrencePattern,
    daysOfWeek: (row.days_of_week as number[] | null) ?? null,
    timeOfDay: (row.time_of_day as string) || "09:00",
    timezone: (row.timezone as string) || "UTC",
    priority: (row.priority as TaskPriority) || "medium",
    status: (row.status as RecurringTaskStatus) || "active",
    nextRunAt: (row.next_run_at as Date).toISOString(),
    lastRunAt: row.last_run_at ? (row.last_run_at as Date).toISOString() : null,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}
