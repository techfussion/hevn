import test from "node:test";
import assert from "node:assert/strict";
import { StudyPlanService } from "../src/core/study/StudyPlanService";
import type { CourseService } from "../src/core/study/CourseService";
import type { TaskService } from "../src/core/tasks/TaskService";
import type { CalendarService } from "../src/core/calendar/CalendarService";
import type { TimeSlot } from "../src/core/calendar/types";
import type { Task, CourseTopic, Course } from "../src/types/domain";

test("StudyPlanService — Calendar-Aware Study Plan Generation & Session Rescheduling", async (t) => {
  const plansDb: any[] = [];
  const sessionsDb: any[] = [];
  const tasksDb: any[] = [];

  const mockCourse: Course = {
    id: "course-1",
    userId: "user-1",
    name: "Operating Systems",
    code: "CS301",
    description: "OS internals",
    instructor: "Prof. Linus",
    institution: "Tech University",
    semester: "Fall 2026",
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const mockTopics: CourseTopic[] = [
    {
      id: "topic-1",
      courseId: "course-1",
      userId: "user-1",
      title: "Process Scheduling",
      description: "CPU scheduling algorithms",
      ordering: 1,
      estimatedStudyMinutes: 60,
      masteryLevel: 20,
      status: "in_progress",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: "topic-2",
      courseId: "course-1",
      userId: "user-1",
      title: "Memory Virtualization",
      description: "Paging and TLB",
      ordering: 2,
      estimatedStudyMinutes: 60,
      masteryLevel: 10,
      status: "not_started",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ];

  const mockCourseService: CourseService = {
    async getCourse(userId: string, courseId: string) {
      return courseId === "course-1" ? mockCourse : null;
    },
    async listTopics(userId: string, courseId: string) {
      return courseId === "course-1" ? mockTopics : [];
    },
    async updateTopicMastery(userId: string, topicId: string, options: { delta?: number }) {
      const topic = mockTopics.find((t) => t.id === topicId);
      if (topic) {
        topic.masteryLevel = Math.min(100, Math.max(0, topic.masteryLevel + (options.delta || 0)));
      }
      return topic || null;
    },
  } as unknown as CourseService;

  const mockTaskService: TaskService = {
    async createTask(userId: string, input: any): Promise<Task> {
      const task: Task = {
        id: `task-${tasksDb.length + 1}`,
        userId,
        title: input.title,
        status: "pending",
        priority: input.priority || "medium",
        taskType: input.taskType || "task",
        parentTaskId: input.parentTaskId || null,
        projectId: input.projectId || null,
        reminderOffsetMinutes: input.reminderOffsetMinutes || null,
        recurrenceRule: null,
        dueAt: input.dueAtIso,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      tasksDb.push(task);
      return task;
    },
    async updateTask(userId: string, taskId: string, input: any) {
      const task = tasksDb.find((t) => t.id === taskId);
      if (task) {
        if (input.dueAtIso) task.dueAt = input.dueAtIso;
        if (input.title) task.title = input.title;
        return task;
      }
      return null;
    },
    async markStatus(userId: string, taskId: string, status: any) {
      const task = tasksDb.find((t) => t.id === taskId);
      if (task) {
        task.status = status;
        return task;
      }
      return null;
    },
  } as unknown as TaskService;

  // Mock CalendarService returning free slots
  const mockCalendarService: CalendarService = {
    async findAvailableSlots(userId: string, options: any): Promise<TimeSlot[]> {
      const start = new Date(options?.timeMin || Date.now()).getTime();
      return [
        {
          startAt: new Date(start + 2 * 3600 * 1000).toISOString(),
          endAt: new Date(start + 3 * 3600 * 1000).toISOString(),
          durationMinutes: 60,
        },
        {
          startAt: new Date(start + 26 * 3600 * 1000).toISOString(),
          endAt: new Date(start + 27 * 3600 * 1000).toISOString(),
          durationMinutes: 60,
        },
      ];
    },
  } as unknown as CalendarService;

  const mockDbScope = async <T>(userId: string, fn: (client: any) => Promise<T>): Promise<T> => {
    const mockClient = {
      async query(rawSql: string, params?: any[]): Promise<{ rows: any[] }> {
        const sql = rawSql.replace(/\s+/g, " ");

        // StudyPlan INSERT
        if (sql.includes("INSERT INTO study_plans")) {
          const plan = {
            id: `plan-${plansDb.length + 1}`,
            user_id: params![0],
            course_id: params![1],
            assessment_id: params![2],
            title: params![3],
            target_date: params![4],
            status: "active",
            total_planned_minutes: params![5],
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
          plansDb.push(plan);
          return { rows: [plan] };
        }

        // StudySession INSERT
        if (sql.includes("INSERT INTO study_sessions")) {
          const session = {
            id: `session-${sessionsDb.length + 1}`,
            user_id: params![0],
            study_plan_id: params![1],
            course_id: params![2],
            topic_id: params![3],
            task_id: params![4],
            title: params![5],
            scheduled_start: params![6],
            scheduled_end: params![7],
            planned_minutes: params![8],
            actual_minutes: null,
            status: "scheduled",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
          sessionsDb.push(session);
          return { rows: [session] };
        }

        // StudySession SELECT
        if (sql.includes("FROM study_sessions WHERE id = $1 AND user_id = $2")) {
          const session = sessionsDb.find((s) => s.id === params![0] && s.user_id === params![1]);
          return { rows: session ? [session] : [] };
        }
        if (sql.includes("FROM study_sessions WHERE study_plan_id = $1 AND user_id = $2") || sql.includes("FROM study_sessions WHERE user_id = $1 AND study_plan_id = $2")) {
          const matched = sessionsDb.filter((s) => s.study_plan_id === params![0] && s.user_id === params![1]);
          return { rows: matched };
        }

        // StudySession UPDATE reschedule
        if (sql.includes("UPDATE study_sessions") && sql.includes("status = 'rescheduled'")) {
          const session = sessionsDb.find((s) => s.id === params![3] && s.user_id === params![4]);
          if (session) {
            session.scheduled_start = params![0];
            session.scheduled_end = params![1];
            session.planned_minutes = params![2];
            session.status = "rescheduled";
            return { rows: [session] };
          }
          return { rows: [] };
        }

        // StudySession UPDATE complete
        if (sql.includes("UPDATE study_sessions") && sql.includes("status = 'completed'")) {
          const session = sessionsDb.find((s) => s.id === params![1] && s.user_id === params![2]);
          if (session) {
            session.status = "completed";
            session.actual_minutes = params![0];
            return { rows: [session] };
          }
          return { rows: [] };
        }

        return { rows: [] };
      },
    };
    return fn(mockClient);
  };

  const service = new StudyPlanService(mockCourseService, mockTaskService, mockCalendarService, mockDbScope as any);
  const userId = "user-1";

  await t.test("generates study plan with scheduled sessions and canonical reminder tasks", async () => {
    const targetDate = new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString();
    const result = await service.generateStudyPlan(userId, {
      courseId: "course-1",
      targetDate,
      sessionDurationMinutes: 60,
      userTimezone: "UTC",
    });

    assert.strictEqual(result.success, true);
    assert.ok(result.studyPlan);
    assert.strictEqual(result.sessions.length, 2);

    // Verify linked canonical tasks were created with 15-minute reminders
    for (const session of result.sessions) {
      assert.ok(session.taskId, "Study session must have a linked task ID");
      const createdTask = tasksDb.find((t) => t.id === session.taskId);
      assert.ok(createdTask);
      assert.strictEqual(createdTask.reminderOffsetMinutes, 15, "15 minute reminder before study session");
    }
  });

  await t.test("reschedules a study session and syncs the linked task due date", async () => {
    const sessionId = sessionsDb[0].id;
    const newStart = new Date(Date.now() + 48 * 3600 * 1000).toISOString();

    const rescheduled = await service.rescheduleStudySession(userId, sessionId, newStart, 90);
    assert.ok(rescheduled);
    assert.strictEqual(rescheduled?.status, "rescheduled");
    assert.strictEqual(rescheduled?.plannedMinutes, 90);

    // Verify linked task dueAt was updated
    const linkedTask = tasksDb.find((t) => t.id === rescheduled?.taskId);
    assert.ok(linkedTask);
    assert.strictEqual(new Date(linkedTask.dueAt).toISOString(), new Date(newStart).toISOString());
  });

  await t.test("completes study session, marks task done and updates topic mastery", async () => {
    const sessionId = sessionsDb[0].id;
    const targetTopicId = sessionsDb[0].topic_id;
    const targetTopic = mockTopics.find((t) => t.id === targetTopicId);
    const initialMastery = targetTopic?.masteryLevel ?? 10;

    const completed = await service.completeStudySession(userId, sessionId, 60);
    assert.ok(completed);
    assert.strictEqual(completed?.status, "completed");

    // Linked task should be marked done
    const linkedTask = tasksDb.find((t) => t.id === completed?.taskId);
    assert.strictEqual(linkedTask?.status, "done");

    // Topic mastery should have increased by +5
    assert.strictEqual(targetTopic?.masteryLevel, initialMastery + 5);
  });

  await t.test("returns explanation constraint when target date is in the past", async () => {
    const pastDate = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const result = await service.generateStudyPlan(userId, {
      courseId: "course-1",
      targetDate: pastDate,
      userTimezone: "UTC",
    });

    assert.strictEqual(result.success, false);
    assert.ok(result.message.includes("future"));
  });
});
