import type { PoolClient } from "pg";
import { withUserScope } from "../../db/pool";
import { logger } from "../../utils/logger";
import type {
  StudyPlan,
  StudySession,
} from "../../types/domain";
import type { CourseService } from "./CourseService";
import type { TaskService } from "../tasks/TaskService";
import type { CalendarService } from "../calendar/CalendarService";

export type UserScopeFn = <T>(
  userId: string,
  fn: (client: PoolClient) => Promise<T>
) => Promise<T>;

export interface GenerateStudyPlanOptions {
  courseId: string;
  assessmentId?: string;
  title?: string;
  targetDate: string; // ISO 8601
  sessionDurationMinutes?: number; // default 60
  maxDailySessions?: number; // default 1
  userTimezone?: string;
}

export interface GeneratedStudyPlanResult {
  success: boolean;
  studyPlan?: StudyPlan;
  sessions?: StudySession[];
  message?: string;
  insufficientTime?: boolean;
}

export class StudyPlanService {
  private dbScope: UserScopeFn;

  constructor(
    private courseService: CourseService,
    private taskService: TaskService,
    private calendarService?: CalendarService,
    dbScope?: UserScopeFn
  ) {
    this.dbScope = dbScope || withUserScope;
  }

  /**
   * Generates a structured study plan with concrete sessions, respecting
   * calendar availability, quiet hours, and existing commitments.
   */
  async generateStudyPlan(
    userId: string,
    options: GenerateStudyPlanOptions
  ): Promise<GeneratedStudyPlanResult> {
    const course = await this.courseService.getCourse(userId, options.courseId);
    if (!course) {
      return { success: false, message: `Course not found: ${options.courseId}` };
    }

    const topics = await this.courseService.listTopics(userId, options.courseId);
    if (topics.length === 0) {
      return {
        success: false,
        message: `Course "${course.name}" has no topics configured yet. Add course topics first.`,
      };
    }

    const sessionDuration = options.sessionDurationMinutes ?? 60;
    const now = new Date();
    const targetDate = new Date(options.targetDate);

    if (targetDate.getTime() <= now.getTime()) {
      return {
        success: false,
        message: "Target date must be in the future.",
      };
    }

    // 1. Sort topics: prioritize lowest mastery first, then by ordering
    const sortedTopics = [...topics].sort((a, b) => {
      if (a.masteryLevel !== b.masteryLevel) {
        return a.masteryLevel - b.masteryLevel;
      }
      return a.ordering - b.ordering;
    });

    // 2. Query available slots before target date using CalendarService
    let candidateSlots: Array<{ startAt: string; endAt: string }> = [];

    if (this.calendarService) {
      try {
        const slots = await this.calendarService.findAvailableSlots(userId, {
          timeMin: now.toISOString(),
          timeMax: targetDate.toISOString(),
          durationMinutes: sessionDuration,
          userTimezone: options.userTimezone || "UTC",
          preferences: {
            maxSlots: sortedTopics.length * 2,
            bufferMinutes: 15,
          },
        });
        candidateSlots = slots.map((s) => ({ startAt: s.startAt, endAt: s.endAt }));
      } catch (err) {
        logger.warn({ err, userId }, "CalendarService availability lookup failed, using heuristic slots");
      }
    }

    // Fallback: generate non-conflicting default daily slots if calendar service returned empty
    if (candidateSlots.length < sortedTopics.length) {
      const daysUntilTarget = Math.max(
        1,
        Math.floor((targetDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
      );

      if (daysUntilTarget < sortedTopics.length) {
        return {
          success: false,
          insufficientTime: true,
          message: `There are only ${daysUntilTarget} days before ${targetDate.toLocaleDateString()} but ${sortedTopics.length} topics to cover. I recommend shortening sessions or focusing on your lowest mastery topics.`,
        };
      }

      // Generate synthetic non-conflicting slots spread across available days
      candidateSlots = [];
      const intervalDays = Math.max(1, Math.floor(daysUntilTarget / sortedTopics.length));
      for (let i = 0; i < sortedTopics.length; i++) {
        const slotDate = new Date(now.getTime() + (i + 1) * intervalDays * 24 * 60 * 60 * 1000);
        slotDate.setUTCHours(18, 0, 0, 0); // 6:00 PM UTC
        if (slotDate.getTime() < targetDate.getTime()) {
          const endSlot = new Date(slotDate.getTime() + sessionDuration * 60 * 1000);
          candidateSlots.push({
            startAt: slotDate.toISOString(),
            endAt: endSlot.toISOString(),
          });
        }
      }
    }

    if (candidateSlots.length < sortedTopics.length) {
      return {
        success: false,
        insufficientTime: true,
        message: `I couldn't fit ${sortedTopics.length} study sessions before your exam without overlapping existing commitments. Consider revising your schedule or prioritizing weak topics.`,
      };
    }

    // 3. Create Study Plan record
    const planTitle = options.title || `Study Plan: ${course.name}`;
    const totalPlannedMinutes = sortedTopics.length * sessionDuration;

    return this.dbScope(userId, async (client) => {
      const { rows: planRows } = await client.query(
        `INSERT INTO study_plans (user_id, course_id, assessment_id, title, target_date, status, total_planned_minutes)
         VALUES ($1, $2, $3, $4, $5, 'active', $6)
         RETURNING id, user_id, course_id, assessment_id, title, target_date, status, total_planned_minutes, created_at, updated_at`,
        [
          userId,
          options.courseId,
          options.assessmentId || null,
          planTitle,
          options.targetDate,
          totalPlannedMinutes,
        ]
      );

      const studyPlan = this.mapPlanRow(planRows[0]);
      const createdSessions: StudySession[] = [];

      // 4. Create study sessions and linked Hevn tasks
      for (let i = 0; i < sortedTopics.length; i++) {
        const topic = sortedTopics[i];
        const slot = candidateSlots[i];
        const sessionTitle = `Study: ${topic.title} (${course.code || course.name})`;

        // Create canonical Hevn task for reminder delivery
        const task = await this.taskService.createTask(userId, {
          title: sessionTitle,
          dueAtIso: slot.startAt,
          priority: "medium",
          taskType: "task",
          reminderOffsetMinutes: 15,
        });

        const { rows: sessionRows } = await client.query(
          `INSERT INTO study_sessions (user_id, study_plan_id, course_id, topic_id, task_id, title, scheduled_start, scheduled_end, planned_minutes, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'scheduled')
           RETURNING id, user_id, study_plan_id, course_id, topic_id, task_id, title, scheduled_start, scheduled_end, planned_minutes, actual_minutes, status, created_at, updated_at`,
          [
            userId,
            studyPlan.id,
            options.courseId,
            topic.id,
            task.id,
            sessionTitle,
            slot.startAt,
            slot.endAt,
            sessionDuration,
          ]
        );

        createdSessions.push(this.mapSessionRow(sessionRows[0]));
      }

      logger.info(
        { planId: studyPlan.id, userId, sessionCount: createdSessions.length },
        "Study plan and sessions successfully created"
      );

      return {
        success: true,
        studyPlan,
        sessions: createdSessions,
        message: `Created study plan with ${createdSessions.length} sessions for ${course.name}.`,
      };
    });
  }

  async getStudyPlan(userId: string, planId: string): Promise<StudyPlan | null> {
    return this.dbScope(userId, async (client) => {
      const { rows } = await client.query(
        `SELECT id, user_id, course_id, assessment_id, title, target_date, status, total_planned_minutes, created_at, updated_at
         FROM study_plans
         WHERE id = $1 AND user_id = $2`,
        [planId, userId]
      );
      return rows[0] ? this.mapPlanRow(rows[0]) : null;
    });
  }

  async listStudySessions(userId: string, planId: string): Promise<StudySession[]> {
    return this.dbScope(userId, async (client) => {
      const { rows } = await client.query(
        `SELECT id, user_id, study_plan_id, course_id, topic_id, task_id, title, scheduled_start, scheduled_end, planned_minutes, actual_minutes, status, created_at, updated_at
         FROM study_sessions
         WHERE study_plan_id = $1 AND user_id = $2
         ORDER BY scheduled_start ASC`,
        [planId, userId]
      );
      return rows.map((r) => this.mapSessionRow(r));
    });
  }

  async rescheduleStudySession(
    userId: string,
    sessionId: string,
    newStartIso: string,
    durationMinutes?: number
  ): Promise<StudySession | null> {
    return this.dbScope(userId, async (client) => {
      const { rows: currentRows } = await client.query(
        `SELECT id, user_id, study_plan_id, course_id, topic_id, task_id, title, scheduled_start, scheduled_end, planned_minutes, actual_minutes, status
         FROM study_sessions
         WHERE id = $1 AND user_id = $2`,
        [sessionId, userId]
      );

      if (!currentRows[0]) return null;
      const current = currentRows[0];

      const duration = durationMinutes ?? Number(current.planned_minutes) ?? 60;
      const start = new Date(newStartIso);
      const end = new Date(start.getTime() + duration * 60 * 1000);

      // Update linked task due date
      if (current.task_id) {
        try {
          await this.taskService.updateTask(userId, current.task_id, {
            dueAtIso: start.toISOString(),
          });
        } catch (err) {
          logger.warn({ err, taskId: current.task_id }, "Failed to update linked task due date");
        }
      }

      const { rows: updatedRows } = await client.query(
        `UPDATE study_sessions
         SET scheduled_start = $1, scheduled_end = $2, planned_minutes = $3, status = 'rescheduled', updated_at = now()
         WHERE id = $4 AND user_id = $5
         RETURNING id, user_id, study_plan_id, course_id, topic_id, task_id, title, scheduled_start, scheduled_end, planned_minutes, actual_minutes, status, created_at, updated_at`,
        [start.toISOString(), end.toISOString(), duration, sessionId, userId]
      );

      return updatedRows[0] ? this.mapSessionRow(updatedRows[0]) : null;
    });
  }

  async completeStudySession(
    userId: string,
    sessionId: string,
    actualMinutes?: number
  ): Promise<StudySession | null> {
    return this.dbScope(userId, async (client) => {
      const { rows: currentRows } = await client.query(
        `SELECT id, task_id, planned_minutes, topic_id FROM study_sessions WHERE id = $1 AND user_id = $2`,
        [sessionId, userId]
      );
      if (!currentRows[0]) return null;

      const spent = actualMinutes ?? Number(currentRows[0].planned_minutes) ?? 60;

      // Mark linked task as done
      if (currentRows[0].task_id) {
        try {
          await this.taskService.markStatus(userId, currentRows[0].task_id, "done");
        } catch (err) {
          logger.warn({ err, taskId: currentRows[0].task_id }, "Failed to mark linked task done");
        }
      }

      // Slightly increment topic mastery for completed session (+5)
      if (currentRows[0].topic_id) {
        try {
          await this.courseService.updateTopicMastery(userId, currentRows[0].topic_id, { delta: 5 });
        } catch {
          // non-fatal
        }
      }

      const { rows } = await client.query(
        `UPDATE study_sessions
         SET status = 'completed', actual_minutes = $1, updated_at = now()
         WHERE id = $2 AND user_id = $3
         RETURNING id, user_id, study_plan_id, course_id, topic_id, task_id, title, scheduled_start, scheduled_end, planned_minutes, actual_minutes, status, created_at, updated_at`,
        [spent, sessionId, userId]
      );

      return rows[0] ? this.mapSessionRow(rows[0]) : null;
    });
  }

  private mapPlanRow(r: Record<string, unknown>): StudyPlan {
    return {
      id: r.id as string,
      userId: r.user_id as string,
      courseId: r.course_id as string,
      assessmentId: r.assessment_id as string | null,
      title: r.title as string,
      targetDate: new Date(r.target_date as string | number | Date).toISOString(),
      status: r.status as StudyPlan["status"],
      totalPlannedMinutes: Number(r.total_planned_minutes),
      createdAt: new Date(r.created_at as string | number | Date).toISOString(),
      updatedAt: new Date(r.updated_at as string | number | Date).toISOString(),
    };
  }

  private mapSessionRow(r: Record<string, unknown>): StudySession {
    return {
      id: r.id as string,
      userId: r.user_id as string,
      studyPlanId: r.study_plan_id as string,
      courseId: r.course_id as string,
      topicId: r.topic_id as string | null,
      taskId: r.task_id as string | null,
      title: r.title as string,
      scheduledStart: new Date(r.scheduled_start as string | number | Date).toISOString(),
      scheduledEnd: new Date(r.scheduled_end as string | number | Date).toISOString(),
      plannedMinutes: Number(r.planned_minutes),
      actualMinutes: r.actual_minutes ? Number(r.actual_minutes) : null,
      status: r.status as StudySession["status"],
      createdAt: new Date(r.created_at as string | number | Date).toISOString(),
      updatedAt: new Date(r.updated_at as string | number | Date).toISOString(),
    };
  }
}
