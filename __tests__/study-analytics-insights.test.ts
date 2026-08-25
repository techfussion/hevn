import test from "node:test";
import assert from "node:assert/strict";
import { InsightsService } from "../src/core/insights/InsightsService";
import { StudyRecommendationService } from "../src/core/study/StudyRecommendationService";
import type { CourseService } from "../src/core/study/CourseService";
import type { Course, CourseTopic, Assessment } from "../src/types/domain";

test("Study Analytics & Insights — Adherence, Quiz Performance & Adaptive Recommendations", async (t) => {
  const userId = "user-analytics-1";

  const mockCourses: Course[] = [
    {
      id: "c-1",
      userId,
      name: "Computer Networks",
      code: "CS455",
      description: "Network protocols",
      instructor: "Dr. Cerf",
      institution: "MIT",
      semester: "Fall 2026",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ];

  const mockTopics: CourseTopic[] = [
    {
      id: "t-weak",
      courseId: "c-1",
      userId,
      title: "TCP Congestion Control",
      description: "AIMD, Slow Start",
      ordering: 1,
      estimatedStudyMinutes: 60,
      masteryLevel: 35, // weak (<60)
      status: "in_progress",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: "t-strong",
      courseId: "c-1",
      userId,
      title: "IP Addressing & Subnetting",
      description: "IPv4 and CIDR",
      ordering: 2,
      estimatedStudyMinutes: 60,
      masteryLevel: 90, // strong (>=80)
      status: "mastered",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ];

  const mockAssessments: Assessment[] = [
    {
      id: "a-1",
      courseId: "c-1",
      userId,
      title: "Final Exam",
      assessmentType: "final",
      dueAt: new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString(), // 3 days away
      weightPercentage: 40,
      linkedTaskId: "task-exam",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ];

  const mockDbScope = async <T>(uId: string, fn: (client: any) => Promise<T>): Promise<T> => {
    const mockClient = {
      async query(rawSql: string, params?: any[]): Promise<{ rows: any[] }> {
        const sql = rawSql.replace(/\s+/g, " ");

        // Study sessions rows
        if (sql.includes("FROM study_sessions WHERE user_id = $1")) {
          return {
            rows: [
              { id: "s1", status: "completed", planned_minutes: 60, actual_minutes: 60 },
              { id: "s2", status: "completed", planned_minutes: 60, actual_minutes: 60 },
              { id: "s3", status: "completed", planned_minutes: 60, actual_minutes: 60 },
              { id: "s4", status: "completed", planned_minutes: 60, actual_minutes: 60 },
              { id: "s5", status: "scheduled", planned_minutes: 60, actual_minutes: null },
            ],
          };
        }

        // Topic mastery list
        if (sql.includes("FROM course_topics WHERE user_id = $1")) {
          return {
            rows: [
              { title: "IP Addressing & Subnetting", mastery_level: 90 },
              { title: "TCP Congestion Control", mastery_level: 35 },
            ],
          };
        }

        // Quiz scores
        if (sql.includes("FROM quizzes WHERE user_id = $1")) {
          return {
            rows: [
              { score: 9, total_questions: 10 },
              { score: 9, total_questions: 10 },
            ],
          };
        }

        // Assessments
        if (sql.includes("FROM assessments")) {
          return {
            rows: [
              { title: "Final Exam", due_at: new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString(), course_name: "Computer Networks" },
            ],
          };
        }

        return { rows: [] };
      },
    };
    return fn(mockClient);
  };

  const insightsService = new InsightsService(mockDbScope as any);

  const mockCourseService: CourseService = {
    async listCourses() {
      return mockCourses;
    },
    async listTopics(uId: string, courseId: string) {
      return courseId === "c-1" ? mockTopics : [];
    },
    async listAssessments(uId: string, courseId?: string) {
      return mockAssessments;
    },
  } as unknown as CourseService;

  const recommendationService = new StudyRecommendationService(mockCourseService);

  await t.test("computes accurate study insights adhering to the null/empty-data philosophy", async () => {
    const insights = await insightsService.getStudyInsights(userId, "UTC");

    assert.strictEqual(insights.scheduledSessions, 5);
    assert.strictEqual(insights.completedSessions, 4);
    assert.strictEqual(insights.totalStudyMinutes, 240);
    assert.strictEqual(insights.studyAdherenceRate, 80); // 4 / 5 = 80%
    assert.strictEqual(insights.averageQuizAccuracy, 90); // 18 / 20 = 90%
    assert.strictEqual(insights.strongestTopics.length, 1);
    assert.strictEqual(insights.strongestTopics[0].topicTitle, "IP Addressing & Subnetting");
    assert.strictEqual(insights.weakestTopics.length, 1);
    assert.strictEqual(insights.weakestTopics[0].topicTitle, "TCP Congestion Control");
  });

  await t.test("returns zeroed metrics gracefully when student has no study records", async () => {
    const emptyDbScope = async <T>(uId: string, fn: (client: any) => Promise<T>): Promise<T> => {
      const mockClient = {
        async query(): Promise<{ rows: any[] }> {
          return { rows: [] };
        },
      };
      return fn(mockClient);
    };

    const emptyInsightsService = new InsightsService(emptyDbScope as any);
    const insights = await emptyInsightsService.getStudyInsights("brand-new-user", "UTC");

    assert.strictEqual(insights.scheduledSessions, 0);
    assert.strictEqual(insights.completedSessions, 0);
    assert.strictEqual(insights.totalStudyMinutes, 0);
    assert.strictEqual(insights.studyAdherenceRate, null);
    assert.strictEqual(insights.averageQuizAccuracy, null);
    assert.deepStrictEqual(insights.strongestTopics, []);
    assert.deepStrictEqual(insights.weakestTopics, []);
  });

  await t.test("recommends weak topics prioritized by upcoming assessment urgency", async () => {
    const recommendations = await recommendationService.getStudyRecommendations(userId);

    assert.strictEqual(recommendations.length, 1);
    assert.strictEqual(recommendations[0].topicTitle, "TCP Congestion Control");
    assert.strictEqual(recommendations[0].currentMastery, 35);
    assert.ok(recommendations[0].reason.includes("Final Exam"));
  });
});
