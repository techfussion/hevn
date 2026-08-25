import type { PoolClient } from "pg";
import { withUserScope } from "../../db/pool";
import type { StudyInsights } from "../../types/domain";

type DbScope = <T>(
  userId: string,
  fn: (client: PoolClient) => Promise<T>
) => Promise<T>;

/**
 * Productivity & Follow-Through Insights.
 * Computed deterministically at the application/database layer.
 */

export interface FollowThroughMetrics {
  commitmentsCreated: number;
  commitmentsCompleted: number;
  tasksCreated: number;
  tasksCompleted: number;
  tasksMissed: number;
  followUpsDelivered: number;
  followUpsCompleted: number;
  followUpsRescheduled: number;
  followUpsSnoozed: number;
  completionRate: number | null; // null if no tasks were due — avoids misleading 0%
  followThroughRate: number | null; // null if no follow-ups delivered
  averageFollowUpAttempts: number | null;
  bestDay: string | null;
  conversationalSummary: string;
  suggestions: string[];
}

export class InsightsService {
  private dbScope: DbScope;

  constructor(dbScope?: DbScope) {
    this.dbScope = dbScope || withUserScope;
  }

  async getStudyInsights(userId: string, _timezone?: string): Promise<StudyInsights> {
    return this.dbScope(userId, async (client) => {
      // 1. Study Sessions in the last 30 days
      const { rows: sessionRows } = await client.query(
        `SELECT id, status, planned_minutes, actual_minutes, scheduled_start
         FROM study_sessions
         WHERE user_id = $1 AND created_at >= now() - interval '30 days'`,
        [userId]
      );

      const scheduledSessions = sessionRows.length;
      const completedSessions = sessionRows.filter((s) => s.status === "completed").length;
      let totalStudyMinutes = 0;
      for (const s of sessionRows) {
        if (s.status === "completed") {
          totalStudyMinutes += Number(s.actual_minutes) || Number(s.planned_minutes) || 0;
        }
      }

      const studyAdherenceRate =
        scheduledSessions > 0
          ? Math.round((completedSessions / scheduledSessions) * 100)
          : null;

      // 2. Completed Quizzes in last 30 days
      const { rows: quizRows } = await client.query(
        `SELECT score, total_questions
         FROM quizzes
         WHERE user_id = $1 AND status IN ('COMPLETED', 'REVIEWED') AND total_questions > 0`,
        [userId]
      );

      let totalScore = 0;
      let totalQuestions = 0;
      for (const q of quizRows) {
        totalScore += Number(q.score) || 0;
        totalQuestions += Number(q.total_questions) || 0;
      }
      const averageQuizAccuracy =
        totalQuestions > 0 ? Math.round((totalScore / totalQuestions) * 100) : null;

      // 3. Topics (strongest vs weakest)
      const { rows: topicRows } = await client.query(
        `SELECT title, mastery_level
         FROM course_topics
         WHERE user_id = $1
         ORDER BY mastery_level DESC`,
        [userId]
      );

      const strongestTopics = topicRows
        .filter((t) => Number(t.mastery_level) >= 70)
        .slice(0, 3)
        .map((t) => ({ topicTitle: t.title, masteryLevel: Number(t.mastery_level) }));

      const weakestTopics = topicRows
        .filter((t) => Number(t.mastery_level) < 70)
        .reverse()
        .slice(0, 3)
        .map((t) => ({ topicTitle: t.title, masteryLevel: Number(t.mastery_level) }));

      // 4. Upcoming assessments in next 30 days
      const { rows: examRows } = await client.query(
        `SELECT a.title, a.due_at, c.name AS course_name
         FROM assessments a
         JOIN courses c ON c.id = a.course_id
         WHERE a.user_id = $1 AND a.due_at >= now()
         ORDER BY a.due_at ASC
         LIMIT 5`,
        [userId]
      );

      const upcomingAssessments = examRows.map((e) => ({
        title: e.title,
        courseName: e.course_name,
        dueAt: new Date(e.due_at).toISOString(),
      }));

      return {
        totalStudyMinutes,
        completedSessions,
        scheduledSessions,
        studyAdherenceRate,
        averageQuizAccuracy,
        strongestTopics,
        weakestTopics,
        upcomingAssessments,
      };
    });
  }

  async getWeeklyReport(userId: string, timezone: string): Promise<FollowThroughMetrics> {
    return this.dbScope(userId, async (client) => {
      // 1. Tasks & Commitments Created in last 7 days
      const { rows: createdRows } = await client.query(
        `SELECT id, task_type FROM tasks
         WHERE user_id = $1 AND created_at >= now() - interval '7 days'`,
        [userId]
      );

      const tasksCreated = createdRows.length;
      const commitmentsCreated = createdRows.filter((r) => r.task_type === "commitment").length;

      // 2. Tasks Due in last 7 days
      const { rows: dueRows } = await client.query(
        `SELECT id, status, due_at, updated_at, task_type
         FROM tasks
         WHERE user_id = $1
           AND due_at >= now() - interval '7 days'
           AND due_at <= now()`,
        [userId]
      );

      const completed = dueRows.filter((t) => t.status === "done");
      const missed = dueRows.filter(
        (t) => t.status === "missed" || (t.status === "pending" && new Date(t.due_at) < new Date())
      );
      const commitmentsCompleted = completed.filter((t) => t.task_type === "commitment").length;

      // 3. Follow-Ups delivered in last 7 days
      const { rows: fuRows } = await client.query(
        `SELECT id, status, attempt_count, delivered_at, completed_at, updated_at
         FROM follow_ups
         WHERE user_id = $1
           AND (delivered_at >= now() - interval '7 days' OR updated_at >= now() - interval '7 days')`,
        [userId]
      );

      const followUpsDelivered = fuRows.filter((f) => f.delivered_at !== null || f.status !== "SCHEDULED").length;
      const followUpsCompleted = fuRows.filter((f) => f.status === "COMPLETED").length;
      const followUpsRescheduled = fuRows.filter((f) => f.status === "RESCHEDULED").length;
      const followUpsSnoozed = fuRows.filter((f) => f.status === "SNOOZED").length;

      let totalAttempts = 0;
      for (const f of fuRows) {
        totalAttempts += Number(f.attempt_count) || 0;
      }
      const averageFollowUpAttempts =
        fuRows.length > 0 ? Math.round((totalAttempts / fuRows.length) * 10) / 10 : null;

      // Deterministic rate calculations
      const completionRate =
        dueRows.length > 0 ? Math.round((completed.length / dueRows.length) * 100) : null;

      const followThroughRate =
        followUpsDelivered > 0 ? Math.round((followUpsCompleted / followUpsDelivered) * 100) : null;

      const bestDay = computeBestDay(completed, timezone);
      const suggestions = buildSuggestions(completionRate, followThroughRate, missed.length, dueRows.length);
      const conversationalSummary = buildConversationalSummary({
        commitmentsCreated,
        commitmentsCompleted,
        tasksCompleted: completed.length,
        tasksTotalDue: dueRows.length,
        completionRate,
        followThroughRate,
        followUpsRescheduled,
      });

      return {
        commitmentsCreated,
        commitmentsCompleted,
        tasksCreated,
        tasksCompleted: completed.length,
        tasksMissed: missed.length,
        followUpsDelivered,
        followUpsCompleted,
        followUpsRescheduled,
        followUpsSnoozed,
        completionRate,
        followThroughRate,
        averageFollowUpAttempts,
        bestDay,
        conversationalSummary,
        suggestions,
      };
    });
  }
}

function computeBestDay(
  completedTasks: Array<{ due_at: Date }>,
  timezone: string
): string | null {
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
  followThroughRate: number | null,
  missedCount: number,
  totalDue: number
): string[] {
  const suggestions: string[] = [];

  if (totalDue === 0) {
    suggestions.push("No tasks due yet this week — add your top commitments and I'll keep you accountable!");
    return suggestions;
  }

  if (completionRate !== null && completionRate < 50) {
    suggestions.push("Completion rate is under half this week — consider breaking larger tasks into smaller 30-minute steps.");
  }
  if (missedCount >= 3) {
    suggestions.push(`You have ${missedCount} overdue tasks — want to review and reschedule what's realistic for next week?`);
  }
  if (followThroughRate !== null && followThroughRate >= 80) {
    suggestions.push("Excellent follow-through on your check-ins this week — keep up the strong momentum!");
  } else if (completionRate !== null && completionRate >= 80) {
    suggestions.push("Strong overall completion rate this week!");
  }

  return suggestions;
}

function buildConversationalSummary(metrics: {
  commitmentsCreated: number;
  commitmentsCompleted: number;
  tasksCompleted: number;
  tasksTotalDue: number;
  completionRate: number | null;
  followThroughRate: number | null;
  followUpsRescheduled: number;
}): string {
  if (metrics.tasksTotalDue === 0 && metrics.commitmentsCreated === 0) {
    return "You didn't have any scheduled tasks or commitments due this week.";
  }

  const parts: string[] = [];

  if (metrics.commitmentsCreated > 0) {
    parts.push(`You completed ${metrics.commitmentsCompleted} of ${metrics.commitmentsCreated} tracked commitments.`);
  }

  if (metrics.completionRate !== null) {
    parts.push(`Overall, you finished ${metrics.tasksCompleted} of ${metrics.tasksTotalDue} scheduled tasks (${metrics.completionRate}% completion rate).`);
  }

  if (metrics.followThroughRate !== null) {
    parts.push(`You followed through on ${metrics.followThroughRate}% of your follow-up check-ins.`);
  }

  if (metrics.followUpsRescheduled > 0) {
    parts.push(`${metrics.followUpsRescheduled} item${metrics.followUpsRescheduled > 1 ? "s" : ""} required rescheduling.`);
  }

  return parts.join(" ");
}