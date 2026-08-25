import test from "node:test";
import assert from "node:assert/strict";
import { CourseService } from "../src/core/study/CourseService";
import type { TaskService } from "../src/core/tasks/TaskService";
import type { Task } from "../src/types/domain";

test("CourseService — Course and Topic Management with Bounded Mastery", async (t) => {
  // In-memory mock database state
  const coursesDb: any[] = [];
  const topicsDb: any[] = [];
  const assessmentsDb: any[] = [];
  const tasksDb: any[] = [];

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
  } as unknown as TaskService;

  const mockDbScope = async <T>(userId: string, fn: (client: any) => Promise<T>): Promise<T> => {
    const mockClient = {
      async query(rawSql: string, params?: any[]): Promise<{ rows: any[] }> {
        const sql = rawSql.replace(/\s+/g, " ");

        // Course INSERT
        if (sql.includes("INSERT INTO courses")) {
          const course = {
            id: `course-${coursesDb.length + 1}`,
            user_id: params![0],
            name: params![1],
            code: params![2],
            description: params![3],
            instructor: params![4],
            institution: params![5],
            semester: params![6],
            status: "active",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
          coursesDb.push(course);
          return { rows: [course] };
        }

        // Course SELECT by ID
        if (sql.includes("FROM courses") && (sql.includes("id = $1 AND user_id = $2") || sql.includes("user_id = $1 AND id = $2"))) {
          const cId = sql.includes("id = $1") ? params![0] : params![1];
          const uId = sql.includes("id = $1") ? params![1] : params![0];
          const match = coursesDb.find((c) => c.id === cId && c.user_id === uId);
          return { rows: match ? [match] : [] };
        }
        if (sql.includes("FROM courses WHERE user_id = $1")) {
          const match = coursesDb.filter((c) => c.user_id === params![0] && (params!.length > 1 ? c.status === params![1] : c.status === "active"));
          return { rows: match };
        }

        // Course UPDATE
        if (sql.includes("UPDATE courses")) {
          const course = coursesDb.find((c) => c.user_id === params![6] && c.id === params![7]);
          if (course) {
            course.name = params![0];
            course.code = params![1];
            course.description = params![2];
            course.instructor = params![3];
            course.semester = params![4];
            course.status = params![5];
            course.updated_at = new Date().toISOString();
            return { rows: [course] };
          }
          return { rows: [] };
        }

        // Topic ordering MAX query
        if (sql.includes("MAX(ordering)")) {
          const cId = sql.includes("course_id = $1") ? params![0] : params![1];
          const uId = sql.includes("course_id = $1") ? params![1] : params![0];
          const matched = topicsDb.filter((t) => t.course_id === cId && t.user_id === uId);
          const maxOrder = matched.length > 0 ? Math.max(...matched.map((t) => t.ordering)) : 0;
          return { rows: [{ next_order: maxOrder + 1 }] };
        }

        // Topic INSERT
        if (sql.includes("INSERT INTO course_topics")) {
          const topic = {
            id: `topic-${topicsDb.length + 1}`,
            course_id: params![0],
            user_id: params![1],
            title: params![2],
            description: params![3],
            ordering: params![4],
            estimated_study_minutes: params![5],
            mastery_level: 0,
            status: "not_started",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
          topicsDb.push(topic);
          return { rows: [topic] };
        }

        // Topic SELECT by course_id
        if (sql.includes("FROM course_topics") && sql.includes("course_id = $1")) {
          const cId = params![0];
          const uId = params![1];
          const match = topicsDb
            .filter((t) => t.user_id === uId && t.course_id === cId)
            .sort((a, b) => a.ordering - b.ordering);
          return { rows: match };
        }
        // Topic SELECT by topic ID
        if (sql.includes("FROM course_topics") && sql.includes(" WHERE id = $1")) {
          const tId = params![0];
          const uId = params![1];
          const match = topicsDb.find((t) => t.id === tId && t.user_id === uId);
          return { rows: match ? [match] : [] };
        }
        if (sql.includes("FROM course_topics WHERE user_id = $1")) {
          const match = topicsDb.filter((t) => t.user_id === params![0]);
          return { rows: match };
        }

        // Topic UPDATE mastery
        if (sql.includes("UPDATE course_topics SET mastery_level = $1")) {
          const topic = topicsDb.find((t) => t.id === params![2] && t.user_id === params![3]);
          if (topic) {
            topic.mastery_level = params![0];
            topic.status = params![1];
            topic.updated_at = new Date().toISOString();
            return { rows: [topic] };
          }
          return { rows: [] };
        }

        // Assessment INSERT
        if (sql.includes("INSERT INTO assessments")) {
          const assessment = {
            id: `assessment-${assessmentsDb.length + 1}`,
            course_id: params![0],
            user_id: params![1],
            title: params![2],
            assessment_type: params![3],
            due_at: params![4],
            weight_percentage: params![5],
            linked_task_id: params![6] || null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
          assessmentsDb.push(assessment);
          return { rows: [assessment] };
        }

        // Assessment UPDATE linked_task_id
        if (sql.includes("UPDATE assessments SET linked_task_id = $1")) {
          const assessment = assessmentsDb.find((a) => a.user_id === params![2] && a.id === params![1]);
          if (assessment) {
            assessment.linked_task_id = params![0];
            return { rows: [assessment] };
          }
          return { rows: [] };
        }

        // Assessment SELECT
        if (sql.includes("FROM assessments WHERE user_id = $1")) {
          let list = assessmentsDb.filter((a) => a.user_id === params![0]);
          if (params!.length > 1 && params![1]) {
            list = list.filter((a) => a.course_id === params![1]);
          }
          return { rows: list };
        }

        return { rows: [] };
      },
    };
    return fn(mockClient);
  };

  const service = new CourseService(mockTaskService, mockDbScope as any);
  const userId = "student-user-1";

  await t.test("creates and retrieves a course", async () => {
    const course = await service.createCourse(userId, {
      name: "Database Systems",
      code: "CS401",
      description: "Relational database concepts and SQL",
      instructor: "Dr. Smith",
      semester: "Fall 2026",
    });

    assert.ok(course.id);
    assert.strictEqual(course.name, "Database Systems");
    assert.strictEqual(course.code, "CS401");
    assert.strictEqual(course.status, "active");

    const retrieved = await service.getCourse(userId, course.id);
    assert.ok(retrieved);
    assert.strictEqual(retrieved?.name, "Database Systems");
  });

  await t.test("creates topics with sequential ordering", async () => {
    const courses = await service.listCourses(userId);
    const courseId = courses[0].id;

    const topic1 = await service.createTopic(userId, {
      courseId,
      title: "ER Modeling",
      estimatedStudyMinutes: 60,
    });
    assert.strictEqual(topic1.ordering, 1);
    assert.strictEqual(topic1.masteryLevel, 0);
    assert.strictEqual(topic1.status, "not_started");

    const topic2 = await service.createTopic(userId, {
      courseId,
      title: "Relational Algebra",
      estimatedStudyMinutes: 90,
    });
    assert.strictEqual(topic2.ordering, 2);

    const topics = await service.listTopics(userId, courseId);
    assert.strictEqual(topics.length, 2);
    assert.strictEqual(topics[0].title, "ER Modeling");
    assert.strictEqual(topics[1].title, "Relational Algebra");
  });

  await t.test("updates topic mastery bounded strictly between 0 and 100 with status transitions", async () => {
    const courses = await service.listCourses(userId);
    const topics = await service.listTopics(userId, courses[0].id);
    const topicId = topics[0].id;

    // Increment +45 -> mastery 45 (in_progress)
    const updated1 = await service.updateTopicMastery(userId, topicId, { delta: 45 });
    assert.strictEqual(updated1?.masteryLevel, 45);
    assert.strictEqual(updated1?.status, "in_progress");

    // Increment +50 -> mastery 95 (mastered)
    const updated2 = await service.updateTopicMastery(userId, topicId, { delta: 50 });
    assert.strictEqual(updated2?.masteryLevel, 95);
    assert.strictEqual(updated2?.status, "mastered");

    // Overshoot +20 -> clamped to 100
    const updated3 = await service.updateTopicMastery(userId, topicId, { delta: 20 });
    assert.strictEqual(updated3?.masteryLevel, 100);

    // Undershoot -150 -> clamped to 0
    const updated4 = await service.updateTopicMastery(userId, topicId, { delta: -150 });
    assert.strictEqual(updated4?.masteryLevel, 0);
    assert.strictEqual(updated4?.status, "not_started");
  });

  await t.test("creates assessment and automatically provisions linked commitment task with 24h reminder", async () => {
    const courses = await service.listCourses(userId);
    const courseId = courses[0].id;

    const dueAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const assessment = await service.createAssessment(userId, {
      courseId,
      title: "Midterm Exam",
      assessmentType: "midterm",
      dueAt,
      weightPercentage: 25,
    });

    assert.ok(assessment.id);
    assert.strictEqual(assessment.title, "Midterm Exam");
    assert.ok(assessment.linkedTaskId, "Assessment should have linkedTaskId set");

    // Check provisioned task in tasks table
    const createdTask = tasksDb.find((t) => t.id === assessment.linkedTaskId);
    assert.ok(createdTask);
    assert.strictEqual(createdTask.taskType, "commitment");
    assert.strictEqual(createdTask.title, "Midterm Exam");
    assert.strictEqual(createdTask.reminderOffsetMinutes, 1440, "24h milestone reminder");
  });
});
