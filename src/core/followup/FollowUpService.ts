import { z } from "zod";
import { withUserScope, getSchedulerPool } from "../../db/pool";
import type { FollowUp, FollowUpStatus, FollowUpIntent, Task } from "../../types/domain";
import { logger } from "../../utils/logger";

const isoDateTime = z
  .string()
  .refine((val) => !isNaN(Date.parse(val)), { message: "Invalid datetime" })
  .transform((val) => new Date(val).toISOString());

export class FollowUpService {
  /**
   * Schedule a new follow-up for a task.
   */
  async scheduleFollowUp(
    userId: string,
    taskId: string,
    scheduledAtIso: string,
    maxAttempts = 3
  ): Promise<FollowUp> {
    const validScheduledAt = isoDateTime.parse(scheduledAtIso);
    const validMaxAttempts = Math.min(Math.max(maxAttempts, 1), 10);

    return withUserScope(userId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO follow_ups (user_id, task_id, scheduled_at, status, max_attempts)
         VALUES ($1, $2, $3, 'SCHEDULED', $4)
         RETURNING *`,
        [userId, taskId, validScheduledAt, validMaxAttempts]
      );
      return mapFollowUpRow(rows[0]);
    });
  }

  /**
   * Fetches batch of follow-ups that are scheduled and due for delivery.
   * Called by background scheduler worker.
   */
  async getDueFollowUpsBatch(limit = 100): Promise<FollowUp[]> {
    const pool = getSchedulerPool();
    const { rows } = await pool.query(
      `SELECT f.* FROM follow_ups f
       JOIN tasks t ON f.task_id = t.id
       WHERE f.status IN ('SCHEDULED', 'DUE')
         AND f.scheduled_at <= now()
         AND t.status IN ('pending', 'in_progress')
         AND f.attempt_count < f.max_attempts
       ORDER BY f.scheduled_at ASC
       LIMIT $1`,
      [limit]
    );
    return rows.map(mapFollowUpRow);
  }

  /**
   * Marks a follow-up as delivered and advances state to WAITING_FOR_RESPONSE.
   * Increments attempt count and updates last_attempt_at.
   */
  async markDelivered(followUpId: string): Promise<FollowUp | null> {
    if (!isUuid(followUpId)) return null;
    const pool = getSchedulerPool();

    const { rows } = await pool.query(
      `UPDATE follow_ups
       SET status = 'WAITING_FOR_RESPONSE',
           attempt_count = attempt_count + 1,
           last_attempt_at = now(),
           delivered_at = COALESCE(delivered_at, now())
       WHERE id = $1
       RETURNING *`,
      [followUpId]
    );
    return rows[0] ? mapFollowUpRow(rows[0]) : null;
  }

  /**
   * Handles user response intent to an active or pending follow-up.
   */
  async handleFollowUpResponse(
    userId: string,
    followUpId: string,
    intent: FollowUpIntent,
    newScheduledAtIso?: string,
    snoozeMinutes?: number
  ): Promise<{ success: boolean; followUp: FollowUp | null; message: string }> {
    if (!isUuid(followUpId)) {
      return { success: false, followUp: null, message: "Invalid follow-up ID" };
    }

    return withUserScope(userId, async (client) => {
      const { rows: currentRows } = await client.query(
        `SELECT * FROM follow_ups WHERE id = $1 AND user_id = $2`,
        [followUpId, userId]
      );
      if (!currentRows[0]) {
        return { success: false, followUp: null, message: "Follow-up not found" };
      }

      const current = mapFollowUpRow(currentRows[0]);

      switch (intent) {
        case "completed": {
          const { rows } = await client.query(
            `UPDATE follow_ups
             SET status = 'COMPLETED', completed_at = now()
             WHERE id = $1 RETURNING *`,
            [followUpId]
          );
          // Mark associated task as done
          await client.query(
            `UPDATE tasks SET status = 'done', updated_at = now() WHERE id = $1`,
            [current.taskId]
          );
          // Cancel any other pending follow-ups for this task
          await client.query(
            `UPDATE follow_ups
             SET status = 'CANCELLED', cancelled_at = now()
             WHERE task_id = $1 AND id != $2 AND status IN ('SCHEDULED', 'DUE', 'WAITING_FOR_RESPONSE')`,
            [current.taskId, followUpId]
          );
          return { success: true, followUp: mapFollowUpRow(rows[0]), message: "Task and follow-up marked completed" };
        }

        case "not_yet": {
          const { rows } = await client.query(
            `UPDATE follow_ups
             SET status = 'NOT_YET'
             WHERE id = $1 RETURNING *`,
            [followUpId]
          );
          return { success: true, followUp: mapFollowUpRow(rows[0]), message: "Follow-up recorded as not yet completed" };
        }

        case "reschedule": {
          if (!newScheduledAtIso) {
            return { success: false, followUp: current, message: "New scheduled time is required to reschedule" };
          }
          const validNextTime = isoDateTime.parse(newScheduledAtIso);
          const { rows } = await client.query(
            `UPDATE follow_ups
             SET status = 'SCHEDULED',
                 scheduled_at = $1,
                 attempt_count = 0
             WHERE id = $2 RETURNING *`,
            [validNextTime, followUpId]
          );
          return { success: true, followUp: mapFollowUpRow(rows[0]), message: "Follow-up rescheduled" };
        }

        case "snooze": {
          const mins = Math.min(Math.max(Math.floor(snoozeMinutes ?? 60), 5), 60 * 24 * 7);
          const { rows } = await client.query(
            `UPDATE follow_ups
             SET status = 'SCHEDULED',
                 scheduled_at = now() + ($1 || ' minutes')::interval
             WHERE id = $2 RETURNING *`,
            [mins, followUpId]
          );
          return { success: true, followUp: mapFollowUpRow(rows[0]), message: `Follow-up snoozed for ${mins} minutes` };
        }

        case "cancelled": {
          const { rows } = await client.query(
            `UPDATE follow_ups
             SET status = 'CANCELLED', cancelled_at = now()
             WHERE id = $1 RETURNING *`,
            [followUpId]
          );
          return { success: true, followUp: mapFollowUpRow(rows[0]), message: "Follow-up cancelled" };
        }

        default:
          return { success: false, followUp: current, message: "Unsupported follow-up intent" };
      }
    });
  }

  /**
   * Retrieves the most recent active follow-up waiting for a response or scheduled.
   */
  async getLatestPendingFollowUp(userId: string): Promise<FollowUp | null> {
    return withUserScope(userId, async (client) => {
      const { rows } = await client.query(
        `SELECT f.* FROM follow_ups f
         JOIN tasks t ON f.task_id = t.id
         WHERE f.user_id = $1
           AND f.status IN ('WAITING_FOR_RESPONSE', 'NOT_YET', 'DUE', 'SCHEDULED')
           AND t.status IN ('pending', 'in_progress')
         ORDER BY (f.status = 'WAITING_FOR_RESPONSE') DESC, f.updated_at DESC
         LIMIT 1`,
        [userId]
      );
      return rows[0] ? mapFollowUpRow(rows[0]) : null;
    });
  }

  /**
   * Retrieves all active candidate follow-ups currently awaiting user response or due.
   */
  async getActiveCandidateFollowUps(userId: string): Promise<Array<{ followUp: FollowUp; task: Task }>> {
    return withUserScope(userId, async (client) => {
      const { rows } = await client.query(
        `SELECT f.*,
                t.title as t_title,
                t.due_at as t_due_at,
                t.priority as t_priority,
                t.status as t_status,
                t.task_type as t_task_type,
                t.is_system_generated as t_is_system_generated,
                t.parent_task_id as t_parent_task_id,
                t.project_id as t_project_id,
                t.reminder_offset_minutes as t_reminder_offset_minutes,
                t.reminder_sent_at as t_reminder_sent_at,
                t.created_at as t_created_at,
                t.updated_at as t_updated_at
         FROM follow_ups f
         JOIN tasks t ON f.task_id = t.id
         WHERE f.user_id = $1
           AND f.status IN ('WAITING_FOR_RESPONSE', 'NOT_YET', 'DUE')
           AND t.status IN ('pending', 'in_progress')
         ORDER BY (f.status = 'WAITING_FOR_RESPONSE') DESC, f.updated_at DESC
         LIMIT 10`,
        [userId]
      );

      return rows.map((r) => ({
        followUp: mapFollowUpRow(r),
        task: {
          id: r.task_id as string,
          userId: r.user_id as string,
          title: r.t_title as string,
          dueAt: (r.t_due_at as Date).toISOString(),
          priority: r.t_priority as Task["priority"],
          status: r.t_status as Task["status"],
          taskType: r.t_task_type as Task["taskType"],
          isSystemGenerated: Boolean(r.t_is_system_generated),
          parentTaskId: (r.t_parent_task_id as string | null) ?? null,
          projectId: (r.t_project_id as string | null) ?? null,
          reminderOffsetMinutes: (r.t_reminder_offset_minutes as number | null) ?? null,
          reminderSentAt: r.t_reminder_sent_at ? (r.t_reminder_sent_at as Date).toISOString() : null,
          createdAt: (r.t_created_at as Date).toISOString(),
          updatedAt: (r.t_updated_at as Date).toISOString(),
        },
      }));
    });
  }

  /**
   * Cancels all pending follow-ups for a task (e.g. when task is marked done or deleted).
   */
  async cancelFollowUpsForTask(userId: string, taskId: string): Promise<void> {
    if (!isUuid(taskId)) return;
    await withUserScope(userId, async (client) => {
      await client.query(
        `UPDATE follow_ups
         SET status = 'CANCELLED', cancelled_at = now()
         WHERE user_id = $1 AND task_id = $2 AND status IN ('SCHEDULED', 'DUE', 'WAITING_FOR_RESPONSE', 'NOT_YET')`,
        [userId, taskId]
      );
    });
  }

  /**
   * Evaluates if a given time falls within the user's quiet hours in their local timezone.
   */
  isWithinQuietHours(
    date: Date,
    timezone: string,
    startStr: string | null,
    endStr: string | null
  ): boolean {
    if (!startStr || !endStr) return false;

    try {
      const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone || "UTC",
        hour: "numeric",
        minute: "numeric",
        hour12: false,
      });

      const parts = formatter.formatToParts(date);
      const hour = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
      const minute = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
      const currentMinuteOfDay = hour * 60 + minute;

      const [startH, startM] = startStr.split(":").map(Number);
      const [endH, endM] = endStr.split(":").map(Number);
      const startMinuteOfDay = (startH ?? 22) * 60 + (startM ?? 0);
      const endMinuteOfDay = (endH ?? 7) * 60 + (endM ?? 0);

      if (startMinuteOfDay > endMinuteOfDay) {
        // Overnight quiet hours (e.g. 22:00 to 07:00)
        return currentMinuteOfDay >= startMinuteOfDay || currentMinuteOfDay < endMinuteOfDay;
      } else {
        // Same-day quiet hours (e.g. 13:00 to 14:00)
        return currentMinuteOfDay >= startMinuteOfDay && currentMinuteOfDay < endMinuteOfDay;
      }
    } catch (err) {
      logger.error({ err, timezone }, "Error evaluating quiet hours, defaulting to false");
      return false;
    }
  }

  /**
   * Computes the next time after quiet hours end.
   */
  calculateQuietHoursEnd(
    date: Date,
    timezone: string,
    endStr: string
  ): Date {
    try {
      const [endH, endM] = endStr.split(":").map(Number);
      const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezone || "UTC" }); // YYYY-MM-DD
      const localDateStr = formatter.format(date);

      // Construct morning time in UTC
      const localMorning = new Date(`${localDateStr}T${String(endH).padStart(2, "0")}:${String(endM).padStart(2, "0")}:00`);
      if (localMorning.getTime() <= date.getTime()) {
        localMorning.setDate(localMorning.getDate() + 1);
      }
      return localMorning;
    } catch {
      return new Date(date.getTime() + 60 * 60 * 1000); // 1 hour fallback
    }
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function mapFollowUpRow(row: Record<string, unknown>): FollowUp {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    taskId: row.task_id as string,
    scheduledAt: (row.scheduled_at as Date).toISOString(),
    status: row.status as FollowUpStatus,
    attemptCount: Number(row.attempt_count ?? 0),
    maxAttempts: Number(row.max_attempts ?? 3),
    lastAttemptAt: row.last_attempt_at ? (row.last_attempt_at as Date).toISOString() : null,
    deliveredAt: row.delivered_at ? (row.delivered_at as Date).toISOString() : null,
    completedAt: row.completed_at ? (row.completed_at as Date).toISOString() : null,
    cancelledAt: row.cancelled_at ? (row.cancelled_at as Date).toISOString() : null,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}
