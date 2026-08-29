import { logger } from "../../utils/logger";
import { getSchedulerPool } from "../../db/pool";
import { ReauthRequiredError } from "./types";
import type {
  CalendarEvent,
} from "./types";
import type { CalendarService, UserScopeFn } from "./CalendarService";
import type { Task, StudySession } from "../../types/domain";

export interface ScheduleConflict {
  externalEventId: string;
  externalEventTitle: string;
  externalStart: string;
  externalEnd: string;
  conflictingType: "task" | "study_session";
  conflictingId: string;
  conflictingTitle: string;
  conflictingStart: string;
  conflictingEnd: string;
  severity: "high" | "medium";
}

export interface CalendarReconciliationResult {
  accountId: string;
  provider: string;
  calendarsProcessed: number;
  syncedEventsCount: number;
  createdCount: number;
  updatedCount: number;
  deletedCount: number;
  conflicts: ScheduleConflict[];
  reauthRequired?: boolean;
}

export class CalendarReconciliationService {
  constructor(
    private calendarService: CalendarService,
    _dbScope?: UserScopeFn
  ) {}

  /**
   * Reconciles external calendar events for an account against internal tasks and study sessions.
   *
   * Source-of-Truth Rules:
   * 1. External calendar is source-of-truth for external events and calendar availability.
   * 2. Hevn is source-of-truth for internal tasks, commitments, and study plans.
   * 3. External modifications or deletions update availability; any overlapping internal study sessions
   *    or commitments are flagged as non-destructive conflicts.
   */
  async reconcileAccount(userId: string, accountId: string): Promise<CalendarReconciliationResult> {
    const startTime = Date.now();
    const result: CalendarReconciliationResult = {
      accountId,
      provider: "unknown",
      calendarsProcessed: 0,
      syncedEventsCount: 0,
      createdCount: 0,
      updatedCount: 0,
      deletedCount: 0,
      conflicts: [],
    };

    try {
      const accounts = await this.calendarService.getAccounts(userId, true);
      const account = accounts.find((a) => a.id === accountId);
      if (!account) {
        throw new Error(`Calendar account not found: ${accountId}`);
      }
      result.provider = account.provider;

      if (account.status !== "active") {
        logger.info({ accountId, status: account.status }, "Skipping reconciliation: account is not active");
        return result;
      }

      const provider = this.calendarService.getProvider(account.provider);
      const calendars = await this.calendarService.getSelectedCalendars(userId);
      const accountCalendars = calendars.filter((c) => c.accountId === accountId);

      result.calendarsProcessed = accountCalendars.length;

      for (const cal of accountCalendars) {
        if (!provider.incrementalSync) continue;

        try {
          const syncResult = await provider.incrementalSync(
            account,
            cal.externalCalendarId,
            cal.syncToken || undefined
          );

          result.syncedEventsCount += syncResult.events.length;

          // Fetch internal commitments and study sessions in sync window for conflict checking
          const { internalTasks, studySessions } = await this.fetchInternalSchedule(userId);

          for (const ev of syncResult.events) {
            if (ev.status === "cancelled") {
              // External event deleted / cancelled
              result.deletedCount += 1;
              await this.handleDeletedExternalEvent(userId, cal.id, ev.id);
            } else {
              result.updatedCount += 1;
              // Check for schedule clashes with internal study sessions and tasks
              const clashes = this.detectConflicts(ev, internalTasks, studySessions);
              result.conflicts.push(...clashes);
            }
          }

          // Update sync token
          if (syncResult.nextSyncToken) {
            await this.updateSyncToken(cal.id, syncResult.nextSyncToken);
          }
        } catch (calErr: unknown) {
          if (calErr instanceof ReauthRequiredError) {
            throw calErr;
          }
          logger.warn({ calErr, calendarId: cal.id }, "Calendar incremental sync failed during reconciliation");
        }
      }

      await this.updateAccountLastSync(accountId);

      this.calendarService.emitMetric({
        eventType: "calendar.sync.success",
        userId,
        provider: account.provider,
        durationMs: Date.now() - startTime,
      });

      return result;
    } catch (err: unknown) {
      if (err instanceof ReauthRequiredError || (err instanceof Error && err.name === "ReauthRequiredError")) {
        result.reauthRequired = true;
        const msg = err instanceof Error ? err.message : "Reauthorization required";
        await this.calendarService.updateAccountStatus(
          userId,
          accountId,
          "reauth_required",
          "token_revoked",
          msg
        ).catch(() => {});
        logger.warn(
          { accountId, provider: err instanceof ReauthRequiredError ? err.provider : "unknown" },
          "Calendar reconciliation requires user re-authentication"
        );
        return result;
      }
      logger.error({ err, accountId, userId }, "Calendar reconciliation failed");
      return result;
    }
  }

  private detectConflicts(
    ev: CalendarEvent,
    tasks: Task[],
    studySessions: StudySession[]
  ): ScheduleConflict[] {
    const conflicts: ScheduleConflict[] = [];
    const raw = ev as unknown as Record<string, unknown>;
    const startStr = ev.startAt || (raw.startTime as string);
    const endStr = ev.endAt || (raw.endTime as string);
    const evSummary = ev.title || (raw.summary as string) || "Busy";
    const evStart = new Date(startStr).getTime();
    const evEnd = new Date(endStr).getTime();

    // 1. Check study sessions overlapping with external event
    for (const session of studySessions) {
      if (session.status === "completed" || session.status === "skipped") continue;
      const sStart = new Date(session.scheduledStart).getTime();
      const sEnd = new Date(session.scheduledEnd).getTime();

      const overlaps = Math.max(evStart, sStart) < Math.min(evEnd, sEnd);
      if (overlaps) {
        conflicts.push({
          externalEventId: ev.id,
          externalEventTitle: evSummary,
          externalStart: startStr,
          externalEnd: endStr,
          conflictingType: "study_session",
          conflictingId: session.id,
          conflictingTitle: session.title,
          conflictingStart: session.scheduledStart,
          conflictingEnd: session.scheduledEnd,
          severity: "high",
        });
      }
    }

    // 2. Check commitment deadlines inside external event duration
    for (const task of tasks) {
      if (task.status === "done" || task.taskType !== "commitment") continue;
      const taskDue = new Date(task.dueAt).getTime();
      if (taskDue >= evStart && taskDue <= evEnd) {
        conflicts.push({
          externalEventId: ev.id,
          externalEventTitle: evSummary,
          externalStart: startStr,
          externalEnd: endStr,
          conflictingType: "task",
          conflictingId: task.id,
          conflictingTitle: task.title,
          conflictingStart: task.dueAt,
          conflictingEnd: task.dueAt,
          severity: "medium",
        });
      }
    }

    return conflicts;
  }

  private async fetchInternalSchedule(userId: string): Promise<{ internalTasks: Task[]; studySessions: StudySession[] }> {
    try {
      const { rows: taskRows } = await getSchedulerPool().query(
        `SELECT id, user_id, title, due_at, status, task_type, priority
         FROM tasks
         WHERE user_id = $1 AND due_at >= now() - interval '1 day' AND due_at <= now() + interval '30 days'
           AND status IN ('pending', 'in_progress')`,
        [userId]
      );

      const { rows: sessionRows } = await getSchedulerPool().query(
        `SELECT id, user_id, study_plan_id, course_id, topic_id, task_id, title,
                scheduled_start, scheduled_end, planned_minutes, actual_minutes, status, created_at, updated_at
         FROM study_sessions
         WHERE user_id = $1 AND scheduled_start >= now() - interval '1 day' AND scheduled_start <= now() + interval '30 days'
           AND status IN ('scheduled', 'rescheduled')`,
        [userId]
      );

      return {
        internalTasks: taskRows.map((r) => ({
          id: r.id,
          userId: r.user_id,
          title: r.title,
          dueAt: new Date(r.due_at).toISOString(),
          status: r.status,
          taskType: r.task_type,
          priority: r.priority,
          isSystemGenerated: false,
          reminderSentAt: null,
          parentTaskId: null,
          projectId: null,
          reminderOffsetMinutes: null,
          recurrenceRule: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })),
        studySessions: sessionRows.map((r) => ({
          id: r.id,
          userId: r.user_id,
          studyPlanId: r.study_plan_id,
          courseId: r.course_id,
          topicId: r.topic_id,
          taskId: r.task_id,
          title: r.title,
          scheduledStart: new Date(r.scheduled_start).toISOString(),
          scheduledEnd: new Date(r.scheduled_end).toISOString(),
          plannedMinutes: r.planned_minutes,
          actualMinutes: r.actual_minutes,
          status: r.status,
          createdAt: new Date(r.created_at).toISOString(),
          updatedAt: new Date(r.updated_at).toISOString(),
        })),
      };
    } catch {
      return { internalTasks: [], studySessions: [] };
    }
  }

  private async handleDeletedExternalEvent(userId: string, calendarId: string, externalEventId: string): Promise<void> {
    try {
      await getSchedulerPool().query(
        `UPDATE calendar_event_links
         SET sync_status = 'deleted_remotely', updated_at = now()
         WHERE calendar_id = $1 AND external_event_id = $2 AND user_id = $3`,
        [calendarId, externalEventId, userId]
      );
    } catch (err) {
      logger.warn({ err, calendarId, externalEventId }, "Failed to update deleted calendar event link");
    }
  }

  private async updateSyncToken(calendarId: string, syncToken: string): Promise<void> {
    try {
      await getSchedulerPool().query(
        `UPDATE connected_calendars
         SET sync_token = $1, last_sync_at = now(), updated_at = now()
         WHERE id = $2`,
        [syncToken, calendarId]
      );
    } catch (err) {
      logger.warn({ err, calendarId }, "Failed to update calendar sync token");
    }
  }

  private async updateAccountLastSync(accountId: string): Promise<void> {
    try {
      await getSchedulerPool().query(
        `UPDATE calendar_accounts
         SET last_sync_at = now(), updated_at = now()
         WHERE id = $1`,
        [accountId]
      );
    } catch (err) {
      logger.warn({ err, accountId }, "Failed to update account last sync timestamp");
    }
  }
}
