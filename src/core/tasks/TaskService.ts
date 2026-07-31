import { z } from "zod";
import { withUserScope } from "../../db/pool";
import type { Task, TaskPriority, TaskStatus } from "../../types/domain";

/**
 * All task persistence logic. Every method requires userId and every
 * SQL statement is parameterized (never string-concatenated) and run
 * through withUserScope so RLS enforces isolation even if a query here
 * had a bug.
 */

const isoDateTime = z
  .string()
  .refine((val) => !isNaN(Date.parse(val)), { message: "Invalid datetime" })
  .transform((val) => new Date(val).toISOString());

const createTaskSchema = z.object({
  title: z.string().min(1).max(200),
  dueAtIso: isoDateTime,
  priority: z.enum(["low", "medium", "high"]),
  reminderOffsetMinutes: z.number().int().min(0).max(60 * 24 * 14).nullable().optional(),
});

const breakdownSchema = z.object({
  subtasks: z
    .array(
      z.object({
        title: z.string().min(1).max(200),
        dueAtIso: isoDateTime,
        priority: z.enum(["low", "medium", "high"]),
      })
    )
    .min(1)
    .max(15),
});

export class TaskService {
  async createTask(userId: string, input: unknown): Promise<Task> {
    const parsed = createTaskSchema.parse(input); // throws on invalid model output — never trust Gemma's raw args

    return withUserScope(userId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO tasks (user_id, title, due_at, priority, reminder_offset_minutes)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [userId, parsed.title, parsed.dueAtIso, parsed.priority, parsed.reminderOffsetMinutes ?? null]
      );
      return mapRow(rows[0]);
    });
  }

  async updateTask(
    userId: string,
    taskId: string,
    patch: Partial<{
      title: string;
      dueAtIso: string;
      priority: TaskPriority;
      reminderOffsetMinutes: number;
    }>
  ): Promise<Task | null> {
    if (!isUuid(taskId)) return null;

    const fields: string[] = [];
    const values: unknown[] = [];
    let i = 1;

    if (patch.title !== undefined) {
      fields.push(`title = $${i++}`);
      values.push(patch.title.slice(0, 200));
    }
    if (patch.dueAtIso !== undefined) {
      fields.push(`due_at = $${i++}`);
      values.push(patch.dueAtIso);
    }
    if (patch.priority !== undefined) {
      fields.push(`priority = $${i++}`);
      values.push(patch.priority);
    }
    if (patch.reminderOffsetMinutes !== undefined) {
      fields.push(`reminder_offset_minutes = $${i++}`);
      values.push(patch.reminderOffsetMinutes);
    }
    if (fields.length === 0) return this.getTask(userId, taskId);

    values.push(taskId);

    return withUserScope(userId, async (client) => {
      const { rows } = await client.query(
        `UPDATE tasks SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`,
        values
      );
      return rows[0] ? mapRow(rows[0]) : null;
    });
  }

  async markStatus(userId: string, taskId: string, status: TaskStatus): Promise<Task | null> {
    if (!isUuid(taskId)) return null;
    return withUserScope(userId, async (client) => {
      const { rows } = await client.query(
        `UPDATE tasks SET status = $1 WHERE id = $2 RETURNING *`,
        [status, taskId]
      );
      return rows[0] ? mapRow(rows[0]) : null;
    });
  }

  async snoozeTask(userId: string, taskId: string, snoozeMinutes: number): Promise<Task | null> {
    if (!isUuid(taskId)) return null;
    const clampedMinutes = Math.min(Math.max(Math.floor(snoozeMinutes), 1), 60 * 24 * 7); // 1 min .. 7 days

    return withUserScope(userId, async (client) => {
      const { rows } = await client.query(
        `UPDATE tasks
         SET due_at = due_at + ($1 || ' minutes')::interval,
             reminder_sent_at = NULL
         WHERE id = $2
         RETURNING *`,
        [clampedMinutes, taskId]
      );
      return rows[0] ? mapRow(rows[0]) : null;
    });
  }

  async getTask(userId: string, taskId: string): Promise<Task | null> {
    if (!isUuid(taskId)) return null;
    return withUserScope(userId, async (client) => {
      const { rows } = await client.query(`SELECT * FROM tasks WHERE id = $1`, [taskId]);
      return rows[0] ? mapRow(rows[0]) : null;
    });
  }

  async getUpcomingTasks(userId: string, limit = 10): Promise<Task[]> {
    const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 50);
    return withUserScope(userId, async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM tasks
         WHERE status IN ('pending', 'in_progress')
         ORDER BY due_at ASC
         LIMIT $1`,
        [safeLimit]
      );
      return rows.map(mapRow);
    });
  }

  async getDueRemindersBatch(limit = 100): Promise<Task[]> {
    // Scheduler-only query, deliberately not user-scoped since it operates
    // across all users. Runs as a privileged internal job, never exposed
    // to a user-facing endpoint.
    const { getPool } = await import("../../db/pool");
    const { rows } = await getPool().query(
      `SELECT * FROM tasks
       WHERE status IN ('pending', 'in_progress')
         AND reminder_sent_at IS NULL
         AND reminder_offset_minutes IS NOT NULL
         AND due_at - (reminder_offset_minutes || ' minutes')::interval <= now()
       ORDER BY due_at ASC
       LIMIT $1`,
      [limit]
    );
    return rows.map(mapRow);
  }

  async markReminderSent(taskId: string): Promise<void> {
    const { getPool } = await import("../../db/pool");
    await getPool().query(`UPDATE tasks SET reminder_sent_at = now() WHERE id = $1`, [taskId]);
  }

  async createTaskBreakdown(userId: string, input: unknown): Promise<Task[]> {
    const parsed = breakdownSchema.parse(input); // throws on malformed model output

    return withUserScope(userId, async (client) => {
      const created: Task[] = [];
      for (const sub of parsed.subtasks) {
        const { rows } = await client.query(
          `INSERT INTO tasks (user_id, title, due_at, priority)
           VALUES ($1, $2, $3, $4)
           RETURNING *`,
          [userId, sub.title, sub.dueAtIso, sub.priority]
        );
        created.push(mapRow(rows[0]));
      }
      return created;
    });
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function mapRow(row: Record<string, unknown>): Task {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    title: row.title as string,
    dueAt: (row.due_at as Date).toISOString(),
    priority: row.priority as TaskPriority,
    status: row.status as TaskStatus,
    reminderOffsetMinutes: (row.reminder_offset_minutes as number | null) ?? null,
    reminderSentAt: row.reminder_sent_at ? (row.reminder_sent_at as Date).toISOString() : null,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}
