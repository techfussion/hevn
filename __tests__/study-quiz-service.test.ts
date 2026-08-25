import test from "node:test";
import assert from "node:assert/strict";
import { QuizService } from "../src/core/study/QuizService";
import type { GemmaClient } from "../src/core/gemma/GemmaClient";
import type { CourseService } from "../src/core/study/CourseService";
import type { QuizQuestion, CourseTopic } from "../src/types/domain";

test("QuizService — Multi-Turn Deterministic Quiz State Machine & Mastery Tuning", async (t) => {
  const quizzesDb: any[] = [];
  const topicsDb: any[] = [
    {
      id: "topic-sql",
      courseId: "course-db",
      userId: "user-quiz",
      title: "SQL Joins",
      description: "Inner and outer joins",
      ordering: 1,
      estimatedStudyMinutes: 60,
      masteryLevel: 50,
      status: "in_progress",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ];

  const mockQuestions: QuizQuestion[] = [
    {
      question: "Which JOIN returns all rows from the left table and matched rows from the right table?",
      options: ["INNER JOIN", "LEFT JOIN", "RIGHT JOIN", "FULL OUTER JOIN"],
      type: "multiple_choice",
      answer: "LEFT JOIN",
      explanation: "LEFT JOIN preserves all rows from the left table.",
      topic: "SQL Joins",
    },
    {
      question: "True or False: An INNER JOIN returns unmatched rows with NULL values.",
      type: "true_false",
      answer: "False",
      explanation: "INNER JOIN returns only matching rows from both tables.",
      topic: "SQL Joins",
    },
  ];

  const mockGemma: GemmaClient = {
    async converse() {
      return {
        text: `\`\`\`json\n${JSON.stringify(mockQuestions, null, 2)}\n\`\`\``,
        toolCalls: [],
        rawContent: null,
      };
    },
  } as unknown as GemmaClient;

  const mockCourseService: CourseService = {
    async updateTopicMastery(userId: string, topicId: string, options: { delta?: number }) {
      const topic = topicsDb.find((t) => t.id === topicId);
      if (topic) {
        topic.masteryLevel = Math.min(100, Math.max(0, topic.masteryLevel + (options.delta || 0)));
      }
      return topic || null;
    },
  } as unknown as CourseService;

  const mockDbScope = async <T>(userId: string, fn: (client: any) => Promise<T>): Promise<T> => {
    const mockClient = {
      async query(rawSql: string, params?: any[]): Promise<{ rows: any[] }> {
        const sql = rawSql.replace(/\s+/g, " ");

        // Quiz INSERT
        if (sql.includes("INSERT INTO quizzes")) {
          const quiz = {
            id: `quiz-${quizzesDb.length + 1}`,
            user_id: params![0],
            course_id: params![1],
            topic_id: params![2],
            title: params![3],
            difficulty: params![4],
            questions: typeof params![5] === "string" ? JSON.parse(params![5]) : params![5],
            status: "ACTIVE",
            current_question_index: 0,
            score: 0,
            total_questions: Number(params![6]),
            answers: [],
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
          quizzesDb.push(quiz);
          return { rows: [quiz] };
        }

        // Quiz SELECT by id
        if (sql.includes("FROM quizzes WHERE id = $1 AND user_id = $2")) {
          const quiz = quizzesDb.find((q) => q.id === params![0] && q.user_id === params![1]);
          return { rows: quiz ? [quiz] : [] };
        }

        // Active Quiz SELECT
        if (sql.includes("FROM quizzes WHERE user_id = $1") && sql.includes("status IN")) {
          const active = quizzesDb.find(
            (q) => q.user_id === params![0] && ["CREATED", "ACTIVE", "ANSWERING"].includes(q.status)
          );
          return { rows: active ? [active] : [] };
        }

        // Update previous quizzes to completed
        if (sql.includes("UPDATE quizzes SET status = 'COMPLETED'")) {
          for (const q of quizzesDb) {
            if (q.user_id === params![0] && ["CREATED", "ACTIVE", "ANSWERING"].includes(q.status)) {
              q.status = "COMPLETED";
            }
          }
          return { rows: [] };
        }

        // Update quiz state turn
        if (sql.includes("UPDATE quizzes") && sql.includes("current_question_index = $1")) {
          const quiz = quizzesDb.find((q) => q.id === params![4] && q.user_id === params![5]);
          if (quiz) {
            quiz.current_question_index = params![0];
            quiz.score = params![1];
            quiz.answers = typeof params![2] === "string" ? JSON.parse(params![2]) : params![2];
            quiz.status = params![3];
            return { rows: [quiz] };
          }
          return { rows: [] };
        }

        return { rows: [] };
      },
    };
    return fn(mockClient);
  };

  const service = new QuizService(mockGemma, mockCourseService, mockDbScope as any);
  const userId = "user-quiz";

  await t.test("generates quiz in ACTIVE state with first question exposed and answers secured in DB", async () => {
    const quiz = await service.generateQuiz(userId, {
      topicTitle: "SQL Joins",
      topicId: "topic-sql",
      courseId: "course-db",
      difficulty: "medium",
      questionCount: 2,
    });

    assert.ok(quiz.id);
    assert.strictEqual(quiz.status, "ACTIVE");
    assert.strictEqual(quiz.totalQuestions, 2);
    assert.strictEqual(quiz.currentQuestionIndex, 0);

    const activeQuiz = await service.getActiveQuiz(userId);
    assert.ok(activeQuiz);
    assert.strictEqual(activeQuiz?.id, quiz.id);
  });

  await t.test("evaluates Q1 correctly, provides explanation and advances to Q2", async () => {
    const activeQuiz = await service.getActiveQuiz(userId);
    assert.ok(activeQuiz);

    // User submits answer "LEFT JOIN" (or "B")
    const turn1 = await service.submitAnswer(userId, activeQuiz!.id, "LEFT JOIN");

    assert.strictEqual(turn1.isFinished, false);
    assert.strictEqual(turn1.lastAnswerFeedback?.isCorrect, true);
    assert.strictEqual(turn1.questionIndex, 1);
    assert.ok(turn1.currentQuestion?.question.includes("INNER JOIN"));
  });

  await t.test("evaluates Q2 correctly, completes quiz and boosts topic mastery", async () => {
    const activeQuiz = await service.getActiveQuiz(userId);
    assert.ok(activeQuiz);

    const initialMastery = topicsDb[0].masteryLevel;

    // User submits answer "False"
    const turn2 = await service.submitAnswer(userId, activeQuiz!.id, "False");

    assert.strictEqual(turn2.isFinished, true);
    assert.strictEqual(turn2.lastAnswerFeedback?.isCorrect, true);
    assert.strictEqual(turn2.finalScore?.score, 2);
    assert.strictEqual(turn2.finalScore?.percentage, 100);

    // Topic mastery boosted by +10 for >= 80% score
    assert.strictEqual(topicsDb[0].masteryLevel, initialMastery + 10);

    // Active quiz should now be null since quiz is COMPLETED
    const remainingActive = await service.getActiveQuiz(userId);
    assert.strictEqual(remainingActive, null);
  });
});
