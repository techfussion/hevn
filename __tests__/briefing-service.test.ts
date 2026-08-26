import test from "node:test";
import assert from "node:assert/strict";
import { RiskEngineService } from "../src/core/briefing/RiskEngineService";
import { BriefingService } from "../src/core/briefing/BriefingService";
import type { TaskService } from "../src/core/tasks/TaskService";
import type { CalendarService } from "../src/core/calendar/CalendarService";
import type { Task, StudySession, Assessment, CourseTopic, CalendarEvent } from "../src/types/domain";

test("BriefingService & RiskEngineService — Cross-Domain Secretary Briefing & Risk Analysis", async (t) => {
  const riskEngine = new RiskEngineService();

  await t.test("RiskEngineService flags overdue commitments, schedule clashes and exam mastery deficits", () => {
    const now = new Date("2026-08-26T10:00:00.000Z");

    const overdueTask: Task = {
      id: "task-overdue-1",
      userId: "user-1",
      title: "Deliver Quarterly Report",
      dueAt: "2026-08-25T17:00:00.000Z", // overdue
      status: "pending",
      taskType: "commitment",
      priority: "high",
      parentTaskId: null,
      projectId: null,
      reminderOffsetMinutes: null,
      recurrenceRule: null,
      createdAt: "2026-08-20T00:00:00Z",
      updatedAt: "2026-08-20T00:00:00Z",
    };

    const calendarEvent: CalendarEvent = {
      id: "cal-ev-1",
      summary: "Executive Committee Meeting",
      startTime: "2026-08-26T14:00:00.000Z",
      endTime: "2026-08-26T16:00:00.000Z",
      isAllDay: false,
      status: "confirmed",
    };

    const clashingSession: StudySession = {
      id: "session-1",
      userId: "user-1",
      studyPlanId: "plan-1",
      courseId: "course-1",
      topicId: "topic-1",
      taskId: "task-1",
      title: "Deep Learning Revision",
      scheduledStart: "2026-08-26T14:30:00.000Z", // Clashes with Committee Meeting
      scheduledEnd: "2026-08-26T15:30:00.000Z",
      plannedMinutes: 60,
      actualMinutes: null,
      status: "scheduled",
      createdAt: "2026-08-20T00:00:00Z",
      updatedAt: "2026-08-20T00:00:00Z",
    };

    const upcomingExam: Assessment = {
      id: "exam-1",
      courseId: "course-1",
      title: "Final Exam — CS301",
      type: "exam",
      dueAt: "2026-08-30T09:00:00.000Z", // 4 days away
      weightPercent: 40,
      createdAt: "2026-08-01T00:00:00Z",
    };

    const weakTopic: CourseTopic = {
      id: "topic-1",
      courseId: "course-1",
      title: "Recurrent Neural Networks",
      masteryLevel: 35, // Deficit (< 60)
      importanceScore: 5,
      createdAt: "2026-08-01T00:00:00Z",
      updatedAt: "2026-08-01T00:00:00Z",
    };

    const assessment = riskEngine.assessScheduleRisks(
      {
        date: "2026-08-26",
        timezone: "UTC",
        tasks: [overdueTask],
        studySessions: [clashingSession],
        assessments: [upcomingExam],
        topics: [weakTopic],
        calendarEvents: [calendarEvent],
      },
      now
    );

    assert.strictEqual(assessment.overallScore, "high");
    assert.strictEqual(assessment.totalRisks, 3);

    const categories = assessment.risks.map((r) => r.category);
    assert.ok(categories.includes("overdue_commitment"));
    assert.ok(categories.includes("schedule_conflict"));
    assert.ok(categories.includes("exam_mastery_deficit"));
  });

  await t.test("BriefingService aggregates cross-domain state and formats conversation briefing", async () => {
    const mockTaskService = {
      async listTasks() {
        return [
          {
            id: "task-comm-1",
            userId: "user-maya",
            title: "Submit Thesis Draft",
            dueAt: "2026-08-26T17:00:00.000Z",
            status: "pending",
            taskType: "commitment",
            priority: "high",
          },
        ];
      },
    } as unknown as TaskService;

    const mockCalendarService = {
      async listUpcomingEvents() {
        return [
          {
            id: "cal-ev-meet",
            summary: "Advisor Check-In",
            startTime: "2026-08-26T11:00:00.000Z",
            endTime: "2026-08-26T11:30:00.000Z",
            isAllDay: false,
          },
        ];
      },
    } as unknown as CalendarService;

    const mockDbScope = async (userId: string, fn: any) => {
      const mockClient = {
        async query(sql: string) {
          if (sql.includes("FROM study_sessions")) {
            return { rows: [] };
          }
          if (sql.includes("FROM follow_ups")) {
            return { rows: [] };
          }
          if (sql.includes("FROM projects")) {
            return { rows: [{ id: "proj-1", name: "Master Thesis", open_task_count: 3 }] };
          }
          return { rows: [] };
        },
      };
      return fn(mockClient);
    };

    const briefingService = new BriefingService(
      mockTaskService,
      undefined,
      mockCalendarService,
      undefined,
      undefined,
      riskEngine,
      mockDbScope as any
    );

    const briefing = await briefingService.getDailyBriefing("user-maya", "2026-08-26", "UTC");

    assert.strictEqual(briefing.date, "2026-08-26");
    assert.strictEqual(briefing.commitmentsDue.length, 1);
    assert.strictEqual(briefing.commitmentsDue[0].title, "Submit Thesis Draft");
    assert.strictEqual(briefing.agenda.length, 2); // 1 calendar event + 1 commitment deadline
    assert.ok(briefing.conversationalSummary.includes("Secretary Briefing"));
    assert.ok(briefing.conversationalSummary.includes("Advisor Check-In"));
    assert.ok(briefing.conversationalSummary.includes("Submit Thesis Draft"));
  });
});
