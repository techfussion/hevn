import type { PoolClient } from "pg";
import { withUserScope } from "../../db/pool";
import { logger } from "../../utils/logger";
import { RiskEngineService } from "./RiskEngineService";
import type { TaskService } from "../tasks/TaskService";
import type { FollowUpService } from "../followup/FollowUpService";
import type { CalendarService } from "../calendar/CalendarService";
import type { CourseService } from "../study/CourseService";
import type { InsightsService } from "../insights/InsightsService";
import type {
  SecretaryBriefing,
  AgendaTimelineItem,
  Task,
  StudySession,
  Assessment,
  CourseTopic,
  CalendarEvent,
} from "../../types/domain";

export type UserScopeFn = <T>(
  userId: string,
  fn: (client: PoolClient) => Promise<T>
) => Promise<T>;

export class BriefingService {
  private riskEngine: RiskEngineService;
  private dbScope: UserScopeFn;

  constructor(
    private taskService: TaskService,
    _followUpService?: FollowUpService,
    private calendarService?: CalendarService,
    private courseService?: CourseService,
    private insightsService?: InsightsService,
    riskEngine?: RiskEngineService,
    dbScope?: UserScopeFn
  ) {
    this.riskEngine = riskEngine || new RiskEngineService();
    this.dbScope = dbScope || withUserScope;
  }

  /**
   * Synthesizes an intelligent, cross-domain daily briefing across tasks, commitments,
   * external calendar schedules, follow-ups, study sessions, exams, projects, and risks.
   */
  async generateDailyBriefing(
    userId: string,
    targetDateIso?: string,
    timezone: string = "UTC"
  ): Promise<SecretaryBriefing> {
    return this.getDailyBriefing(userId, targetDateIso, timezone);
  }

  async getDailyBriefing(
    userId: string,
    targetDateIso?: string,
    timezone: string = "UTC"
  ): Promise<SecretaryBriefing> {
    const now = new Date();
    const dateStr = targetDateIso || now.toISOString().split("T")[0];

    const dayStart = new Date(`${dateStr}T00:00:00.000Z`);
    const dayEnd = new Date(`${dateStr}T23:59:59.999Z`);

    // 1. Fetch Tasks & Commitments
    const tasksDue: Task[] = [];
    const commitmentsDue: Task[] = [];
    const overdueTasks: Task[] = [];

    try {
      const allTasks = await this.taskService.listTasks(userId);
      for (const t of allTasks) {
        if (t.status === "done") continue;
        const dueTime = new Date(t.dueAt).getTime();

        if (dueTime < dayStart.getTime()) {
          overdueTasks.push(t);
        } else if (dueTime >= dayStart.getTime() && dueTime <= dayEnd.getTime()) {
          if (t.taskType === "commitment") {
            commitmentsDue.push(t);
          } else {
            tasksDue.push(t);
          }
        }
      }
    } catch (err) {
      logger.warn({ err, userId }, "Failed to fetch tasks for daily briefing");
    }

    // 2. Fetch External Calendar Events
    let calendarEvents: CalendarEvent[] = [];
    if (this.calendarService) {
      try {
        calendarEvents = await this.calendarService.listUpcomingEvents(
          userId,
          dayStart.toISOString(),
          dayEnd.toISOString()
        );
      } catch (err) {
        logger.warn({ err, userId }, "Failed to fetch calendar events for daily briefing");
      }
    }

    // 3. Fetch Study Sessions, Assessments & Topics
    let studySessions: StudySession[] = [];
    const upcomingAssessments: Assessment[] = [];
    const topics: CourseTopic[] = [];

    if (this.courseService) {
      try {
        const courses = await this.courseService.listCourses(userId, "active");
        for (const course of courses) {
          const courseTopics = await this.courseService.listTopics(userId, course.id);
          topics.push(...courseTopics);

          const courseAssessments = await this.courseService.listAssessments(userId, course.id);
          for (const a of courseAssessments) {
            const aDue = new Date(a.dueAt).getTime();
            if (aDue >= now.getTime() && aDue <= now.getTime() + 14 * 24 * 3600 * 1000) {
              upcomingAssessments.push(a);
            }
          }
        }
      } catch (err) {
        logger.warn({ err, userId }, "Failed to fetch course data for daily briefing");
      }
    }

    // Fetch study sessions for target day
    try {
      studySessions = await this.dbScope(userId, async (client) => {
        const { rows } = await client.query(
          `SELECT id, user_id, study_plan_id, course_id, topic_id, task_id, title,
                  scheduled_start, scheduled_end, planned_minutes, actual_minutes, status, created_at, updated_at
           FROM study_sessions
           WHERE user_id = $1
             AND scheduled_start >= $2 AND scheduled_start <= $3
           ORDER BY scheduled_start ASC`,
          [userId, dayStart.toISOString(), dayEnd.toISOString()]
        );

        return rows.map((r) => ({
          id: r.id as string,
          userId: r.user_id as string,
          studyPlanId: r.study_plan_id as string,
          courseId: r.course_id as string,
          topicId: r.topic_id as string | null,
          taskId: r.task_id as string | null,
          title: r.title as string,
          scheduledStart: new Date(r.scheduled_start as string).toISOString(),
          scheduledEnd: new Date(r.scheduled_end as string).toISOString(),
          plannedMinutes: Number(r.planned_minutes),
          actualMinutes: r.actual_minutes ? Number(r.actual_minutes) : null,
          status: r.status,
          createdAt: new Date(r.created_at as string).toISOString(),
          updatedAt: new Date(r.updated_at as string).toISOString(),
        }));
      });
    } catch (err) {
      logger.warn({ err, userId }, "Failed to fetch study sessions for daily briefing");
    }

    // 4. Fetch Pending Follow-Ups
    let pendingFollowUps: Array<{ id: string; taskTitle: string; scheduledAt: string; attemptCount: number }> = [];
    try {
      pendingFollowUps = await this.dbScope(userId, async (client) => {
        const { rows } = await client.query(
          `SELECT f.id, f.scheduled_at, f.attempt_count, t.title as task_title
           FROM follow_ups f
           JOIN tasks t ON t.id = f.task_id
           WHERE f.user_id = $1
             AND f.status IN ('SCHEDULED', 'DUE', 'WAITING_FOR_RESPONSE')
             AND f.scheduled_at <= $2
           ORDER BY f.scheduled_at ASC`,
          [userId, dayEnd.toISOString()]
        );
        return rows.map((r) => ({
          id: r.id as string,
          taskTitle: r.task_title as string,
          scheduledAt: new Date(r.scheduled_at as string).toISOString(),
          attemptCount: Number(r.attempt_count) || 0,
        }));
      });
    } catch (err) {
      logger.warn({ err, userId }, "Failed to fetch follow-ups for daily briefing");
    }

    // 5. Fetch Active Projects
    let activeProjects: Array<{ id: string; name: string; openTaskCount: number }> = [];
    try {
      activeProjects = await this.dbScope(userId, async (client) => {
        const { rows } = await client.query(
          `SELECT p.id, p.name, COUNT(t.id) FILTER (WHERE t.status IN ('pending', 'in_progress')) as open_task_count
           FROM projects p
           LEFT JOIN tasks t ON t.project_id = p.id
           WHERE p.user_id = $1
           GROUP BY p.id, p.name
           ORDER BY p.name ASC`,
          [userId]
        );
        return rows.map((r) => ({
          id: r.id as string,
          name: r.name as string,
          openTaskCount: Number(r.open_task_count) || 0,
        }));
      });
    } catch (err) {
      logger.warn({ err, userId }, "Failed to fetch projects for daily briefing");
    }

    // 6. Weekly Momentum Insights
    let weeklyMomentum = {
      completionRate: null as number | null,
      followThroughRate: null as number | null,
      summary: "Tracking your weekly follow-through and focus.",
    };

    if (this.insightsService) {
      try {
        const weekly = await this.insightsService.getWeeklyReport(userId, timezone);
        weeklyMomentum = {
          completionRate: weekly.completionRate,
          followThroughRate: weekly.followThroughRate,
          summary: weekly.conversationalSummary,
        };
      } catch (err) {
        logger.warn({ err, userId }, "Failed to fetch insights for daily briefing");
      }
    }

    // 7. Evaluate Schedule Risks
    const allCombinedTasks = [...tasksDue, ...commitmentsDue, ...overdueTasks];
    const riskAssessment = this.riskEngine.assessScheduleRisks(
      {
        date: dateStr,
        timezone,
        tasks: allCombinedTasks,
        studySessions,
        assessments: upcomingAssessments,
        topics,
        calendarEvents,
      },
      now
    );

    // 8. Build Chronological Agenda
    const agenda: AgendaTimelineItem[] = [];

    for (const ev of calendarEvents) {
      const raw = ev as unknown as Record<string, unknown>;
      agenda.push({
        time: ev.startAt || (raw.startTime as string),
        endTime: ev.endAt || (raw.endTime as string),
        title: ev.title || (raw.summary as string) || "Calendar Event",
        type: "calendar_event",
        sourceId: ev.id,
      });
    }

    for (const session of studySessions) {
      agenda.push({
        time: session.scheduledStart,
        endTime: session.scheduledEnd,
        title: `Study Session: ${session.title}`,
        type: "study_session",
        sourceId: session.id,
      });
    }

    for (const c of commitmentsDue) {
      agenda.push({
        time: c.dueAt,
        title: `Commitment Due: ${c.title}`,
        type: "task_deadline",
        sourceId: c.id,
      });
    }

    // Sort agenda items by start time
    agenda.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());

    // 9. Build Conversational Secretary Summary
    const briefing: SecretaryBriefing = {
      date: dateStr,
      timezone,
      agenda,
      commitmentsDue,
      tasksDue,
      overdueTasks,
      pendingFollowUps,
      studySessions,
      upcomingAssessments,
      activeProjects,
      riskAssessment,
      weeklyMomentum,
      conversationalSummary: "",
    };

    briefing.conversationalSummary = this.formatBriefingForChat(briefing);
    return briefing;
  }

  /**
   * Formats a structured SecretaryBriefing into an elegant conversational markdown message.
   */
  formatBriefingForChat(briefing: SecretaryBriefing): string {
    const lines: string[] = [
      `☀️ **Good day! Here is your Secretary Briefing for ${new Date(briefing.date + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}:**`,
      "",
    ];

    // Risks / Alerts
    if (briefing.riskAssessment.risks.length > 0) {
      lines.push("⚠️ **Key Alerts & Attention Points:**");
      for (const r of briefing.riskAssessment.risks.slice(0, 3)) {
        lines.push(`• **${r.title}**: ${r.description}`);
      }
      lines.push("");
    }

    // Today's Agenda Timeline
    if (briefing.agenda.length > 0) {
      lines.push("📅 **Today's Timeline:**");
      for (const item of briefing.agenda) {
        const timeStr = new Date(item.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        lines.push(`• **${timeStr}** — ${item.title}`);
      }
      lines.push("");
    } else {
      lines.push("📅 **Today's Timeline:** Your schedule is open with no calendar events scheduled.");
      lines.push("");
    }

    // Key Commitments & Tasks
    if (briefing.commitmentsDue.length > 0 || briefing.tasksDue.length > 0) {
      lines.push("🎯 **Action Items & Deliverables:**");
      for (const c of briefing.commitmentsDue) {
        lines.push(`• 📌 **[Commitment]** ${c.title}`);
      }
      for (const t of briefing.tasksDue) {
        lines.push(`• ☑️ ${t.title}`);
      }
      lines.push("");
    }

    // Overdue items
    if (briefing.overdueTasks.length > 0) {
      lines.push(`⏳ **Overdue Items (${briefing.overdueTasks.length}):**`);
      for (const o of briefing.overdueTasks.slice(0, 3)) {
        lines.push(`• ⚠️ "${o.title}" (due ${new Date(o.dueAt).toLocaleDateString()})`);
      }
      lines.push("");
    }

    // Upcoming Exams (Student context)
    if (briefing.upcomingAssessments.length > 0) {
      lines.push("🎓 **Upcoming Academic Milestones:**");
      for (const a of briefing.upcomingAssessments.slice(0, 2)) {
        lines.push(`• 📚 **${a.title}** on ${new Date(a.dueAt).toLocaleDateString()}`);
      }
      lines.push("");
    }

    lines.push("Let me know how you'd like to tackle your day!");
    return lines.join("\n");
  }
}
