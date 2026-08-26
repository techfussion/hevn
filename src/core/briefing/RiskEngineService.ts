import type {
  RiskAssessment,
  RiskItem,
  RiskSeverity,
  Task,
  StudySession,
  Assessment,
  CourseTopic,
  CalendarEvent,
} from "../../types/domain";

export interface ScheduleRiskContext {
  date: string;
  timezone: string;
  tasks: Task[];
  studySessions: StudySession[];
  assessments: Assessment[];
  topics: CourseTopic[];
  calendarEvents: CalendarEvent[];
  quietHoursStart?: string | null;
  quietHoursEnd?: string | null;
}

export class RiskEngineService {
  /**
   * Evaluates comprehensive schedule, academic, and follow-through risks deterministically.
   */
  assessScheduleRisks(ctx: ScheduleRiskContext, now: Date = new Date()): RiskAssessment {
    const risks: RiskItem[] = [];
    const suggestions: string[] = [];

    const targetDateStart = new Date(`${ctx.date}T00:00:00.000Z`).getTime();
    const targetDateEnd = new Date(`${ctx.date}T23:59:59.999Z`).getTime();

    // 1. Overdue Commitments & Tasks
    const overdueCommitments = ctx.tasks.filter(
      (t) =>
        t.status !== "done" &&
        new Date(t.dueAt).getTime() < now.getTime() &&
        t.taskType === "commitment"
    );

    for (const task of overdueCommitments) {
      risks.push({
        id: `risk-overdue-${task.id}`,
        category: "overdue_commitment",
        severity: "high",
        title: `Overdue Commitment: "${task.title}"`,
        description: `This commitment was due on ${new Date(task.dueAt).toLocaleDateString()} and is still pending.`,
        suggestedAction: "Reschedule deadline or mark completed immediately.",
        metadata: { taskId: task.id },
      });
      suggestions.push(`Address overdue commitment "${task.title}" first.`);
    }

    // 2. Schedule Overlaps (Calendar Events vs Study Sessions)
    for (const ev of ctx.calendarEvents) {
      const raw = ev as unknown as Record<string, unknown>;
      const startStr = ev.startAt || (raw.startTime as string);
      const endStr = ev.endAt || (raw.endTime as string);
      const evSummary = ev.title || (raw.summary as string) || "Calendar Event";
      const evStart = new Date(startStr).getTime();
      const evEnd = new Date(endStr).getTime();

      for (const session of ctx.studySessions) {
        if (session.status === "completed" || session.status === "skipped") continue;
        const sStart = new Date(session.scheduledStart).getTime();
        const sEnd = new Date(session.scheduledEnd).getTime();

        const overlaps = Math.max(evStart, sStart) < Math.min(evEnd, sEnd);
        if (overlaps) {
          risks.push({
            id: `risk-overlap-${ev.id}-${session.id}`,
            category: "schedule_conflict",
            severity: "high",
            title: `Schedule Conflict: "${session.title}" vs "${evSummary}"`,
            description: `Study session "${session.title}" clashes directly with external calendar event "${evSummary}" (${new Date(startStr).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}).`,
            suggestedAction: `Reschedule "${session.title}" to an open time slot.`,
            metadata: { eventId: ev.id, sessionId: session.id },
          });
          suggestions.push(`Reschedule study session "${session.title}" to resolve external calendar conflict.`);
        }
      }
    }

    // 3. Academic Exam Mastery Deficit (Exam in <= 14 days with weak topic mastery < 60%)
    for (const exam of ctx.assessments) {
      const examDue = new Date(exam.dueAt).getTime();
      const diffDays = (examDue - now.getTime()) / (1000 * 60 * 60 * 24);

      if (diffDays >= 0 && diffDays <= 14) {
        // Find weak topics for this course
        const weakCourseTopics = ctx.topics.filter(
          (t) => t.courseId === exam.courseId && t.masteryLevel < 60
        );

        if (weakCourseTopics.length > 0) {
          const isUrgent = diffDays <= 3;
          risks.push({
            id: `risk-exam-mastery-${exam.id}`,
            category: "exam_mastery_deficit",
            severity: isUrgent ? "critical" : "medium",
            title: `Mastery Deficit for "${exam.title}" (${Math.ceil(diffDays)}d away)`,
            description: `You have ${weakCourseTopics.length} topic(s) below 60% mastery (e.g. "${weakCourseTopics[0].title}" at ${weakCourseTopics[0].masteryLevel}%).`,
            suggestedAction: `Schedule active recall flashcard reviews or practice quizzes for ${weakCourseTopics[0].title}.`,
            metadata: { assessmentId: exam.id, weakCount: weakCourseTopics.length },
          });
          suggestions.push(`Focus preparation on weak topics before ${exam.title} (${Math.ceil(diffDays)} days away).`);
        }
      }
    }

    // 4. Overloaded Schedule (> 6 hours of combined commitments/sessions on target date)
    let totalScheduledMinutes = 0;
    for (const ev of ctx.calendarEvents) {
      const raw = ev as unknown as Record<string, unknown>;
      const startStr = ev.startAt || (raw.startTime as string);
      const endStr = ev.endAt || (raw.endTime as string);
      const evStart = new Date(startStr).getTime();
      const evEnd = new Date(endStr).getTime();
      if (evStart >= targetDateStart && evStart <= targetDateEnd) {
        totalScheduledMinutes += Math.max(0, (evEnd - evStart) / (1000 * 60));
      }
    }
    for (const session of ctx.studySessions) {
      const sStart = new Date(session.scheduledStart).getTime();
      if (sStart >= targetDateStart && sStart <= targetDateEnd) {
        totalScheduledMinutes += session.plannedMinutes || 60;
      }
    }

    if (totalScheduledMinutes > 360) {
      // > 6 hours
      const hours = (totalScheduledMinutes / 60).toFixed(1);
      risks.push({
        id: "risk-overloaded-day",
        category: "overloaded_day",
        severity: "medium",
        title: `Heavy Workload: ${hours} Hours Scheduled`,
        description: `Your calendar and study sessions total ${hours} hours today, leaving minimal buffer for unexpected delays.`,
        suggestedAction: "Consider deferring non-essential tasks to tomorrow.",
      });
      suggestions.push(`Pace yourself: ${hours} hours of scheduled commitments today.`);
    }

    // Determine overall score
    let overallScore: RiskSeverity = "low";
    if (risks.some((r) => r.severity === "critical")) {
      overallScore = "critical";
    } else if (risks.some((r) => r.severity === "high")) {
      overallScore = "high";
    } else if (risks.some((r) => r.severity === "medium")) {
      overallScore = "medium";
    }

    return {
      overallScore,
      totalRisks: risks.length,
      risks,
      mitigationSuggestions: Array.from(new Set(suggestions)),
    };
  }
}
