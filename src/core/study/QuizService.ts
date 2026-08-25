import type { PoolClient } from "pg";
import { withUserScope } from "../../db/pool";
import { logger } from "../../utils/logger";
import type {
  Quiz,
  QuizDifficulty,
  QuizQuestion,
  QuizAnswer,
  QuizStatus,
} from "../../types/domain";
import type { GemmaClient } from "../gemma/GemmaClient";
import type { CourseService } from "./CourseService";

export type UserScopeFn = <T>(
  userId: string,
  fn: (client: PoolClient) => Promise<T>
) => Promise<T>;

export interface GenerateQuizOptions {
  courseId?: string;
  topicId?: string;
  topicTitle?: string;
  difficulty?: QuizDifficulty;
  questionCount?: number; // default 5
}

export interface QuizTurnResult {
  quizId: string;
  questionIndex: number;
  totalQuestions: number;
  currentQuestion?: QuizQuestion;
  lastAnswerFeedback?: {
    isCorrect: boolean;
    userAnswer: string;
    expectedAnswer: string;
    explanation: string;
  };
  isFinished: boolean;
  finalScore?: {
    score: number;
    total: number;
    percentage: number;
    weakTopics: string[];
    recommendation?: string;
  };
}

export class QuizService {
  private dbScope: UserScopeFn;

  constructor(
    private gemma: GemmaClient,
    private courseService?: CourseService,
    dbScope?: UserScopeFn
  ) {
    this.dbScope = dbScope || withUserScope;
  }

  /**
   * Generates a new quiz and persists it in PostgreSQL with status 'ACTIVE'.
   */
  async generateQuiz(userId: string, options: GenerateQuizOptions): Promise<Quiz> {
    const questionCount = Math.max(1, Math.min(10, options.questionCount ?? 5));
    const difficulty = options.difficulty || "medium";
    const topicTitle = options.topicTitle || "General Knowledge";

    const prompt = `You are an academic examination generator.
Generate a structured quiz for the topic "${topicTitle}" with difficulty "${difficulty}".
Number of questions: ${questionCount}.

Return ONLY a valid JSON array of question objects matching this schema:
[
  {
    "question": "string",
    "type": "multiple_choice | true_false | short_answer",
    "options": ["A) ...", "B) ...", "C) ...", "D) ..."],
    "answer": "string (e.g. 'A' or 'True' or concise keyword)",
    "explanation": "string explaining why the answer is correct",
    "topic": "${topicTitle}"
  }
]

JSON Response:`;

    const response = await this.gemma.converse(prompt, [], "", []);

    const parsedQuestions = this.extractJsonArray(response.text || "");
    const questions: QuizQuestion[] =
      parsedQuestions && parsedQuestions.length > 0
        ? parsedQuestions.map((q) => ({
            question: String(q.question || "").trim(),
            options: Array.isArray(q.options) ? q.options.map(String) : undefined,
            type: (q.type as QuizQuestion["type"]) || (Array.isArray(q.options) && q.options.length > 0 ? "multiple_choice" : "short_answer"),
            answer: String(q.answer || "").trim(),
            explanation: String(q.explanation || "").trim(),
            topic: q.topic ? String(q.topic).trim() : topicTitle,
          }))
        : [
            {
              question: `What is the core principle of ${topicTitle}?`,
              type: "short_answer",
              answer: topicTitle,
              explanation: `Basic foundational concept of ${topicTitle}.`,
              topic: topicTitle,
            },
          ];

    return this.dbScope(userId, async (client) => {
      // Mark any prior active quiz as COMPLETED or REVIEWED so only 1 quiz is active at a time
      await client.query(
        `UPDATE quizzes SET status = 'COMPLETED', updated_at = now()
         WHERE user_id = $1 AND status IN ('CREATED', 'ACTIVE', 'ANSWERING')`,
        [userId]
      );

      const title = `Quiz: ${topicTitle} (${difficulty})`;
      const { rows } = await client.query(
        `INSERT INTO quizzes (user_id, course_id, topic_id, title, difficulty, questions, status, current_question_index, score, total_questions, answers)
         VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', 0, 0, $7, '[]'::jsonb)
         RETURNING id, user_id, course_id, topic_id, title, difficulty, questions, status, current_question_index, score, total_questions, answers, created_at, updated_at`,
        [
          userId,
          options.courseId || null,
          options.topicId || null,
          title,
          difficulty,
          JSON.stringify(questions),
          questions.length,
        ]
      );

      logger.info({ quizId: rows[0].id, userId, topicTitle }, "Quiz generated and activated");
      return this.mapQuizRow(rows[0]);
    });
  }

  /**
   * Retrieves the currently active quiz for the user, if any.
   */
  async getActiveQuiz(userId: string): Promise<Quiz | null> {
    return this.dbScope(userId, async (client) => {
      const { rows } = await client.query(
        `SELECT id, user_id, course_id, topic_id, title, difficulty, questions, status, current_question_index, score, total_questions, answers, created_at, updated_at
         FROM quizzes
         WHERE user_id = $1 AND status IN ('ACTIVE', 'ANSWERING')
         ORDER BY created_at DESC
         LIMIT 1`,
        [userId]
      );
      return rows[0] ? this.mapQuizRow(rows[0]) : null;
    });
  }

  async getQuiz(userId: string, quizId: string): Promise<Quiz | null> {
    return this.dbScope(userId, async (client) => {
      const { rows } = await client.query(
        `SELECT id, user_id, course_id, topic_id, title, difficulty, questions, status, current_question_index, score, total_questions, answers, created_at, updated_at
         FROM quizzes
         WHERE id = $1 AND user_id = $2`,
        [quizId, userId]
      );
      return rows[0] ? this.mapQuizRow(rows[0]) : null;
    });
  }

  /**
   * Submits an answer for the current question in the active quiz.
   */
  async submitAnswer(
    userId: string,
    quizId: string,
    userAnswerText: string
  ): Promise<QuizTurnResult> {
    const quiz = await this.getQuiz(userId, quizId);
    if (!quiz) {
      throw new Error(`Quiz not found: ${quizId}`);
    }

    if (quiz.status === "COMPLETED" || quiz.status === "REVIEWED") {
      return {
        quizId: quiz.id,
        questionIndex: quiz.currentQuestionIndex,
        totalQuestions: quiz.totalQuestions,
        isFinished: true,
        finalScore: {
          score: quiz.score,
          total: quiz.totalQuestions,
          percentage: quiz.totalQuestions > 0 ? Math.round((quiz.score / quiz.totalQuestions) * 100) : 0,
          weakTopics: [],
        },
      };
    }

    const currentIndex = quiz.currentQuestionIndex;
    const currentQuestion = quiz.questions[currentIndex];
    if (!currentQuestion) {
      throw new Error(`No question found at index ${currentIndex}`);
    }

    // Evaluate answer deterministically and with semantic tolerance
    const isCorrect = this.evaluateAnswer(userAnswerText, currentQuestion.answer, currentQuestion.options);
    const feedbackText = isCorrect
      ? `Correct! ${currentQuestion.explanation}`
      : `Not quite. The correct answer was "${currentQuestion.answer}". ${currentQuestion.explanation}`;

    const newAnswer: QuizAnswer = {
      questionIndex: currentIndex,
      userAnswer: userAnswerText.trim(),
      isCorrect,
      feedback: feedbackText,
    };

    const updatedAnswers = [...quiz.answers, newAnswer];
    const newScore = quiz.score + (isCorrect ? 1 : 0);
    const nextIndex = currentIndex + 1;
    const isFinished = nextIndex >= quiz.totalQuestions;
    const nextStatus: QuizStatus = isFinished ? "COMPLETED" : "ANSWERING";

    // Update Quiz in DB
    await this.dbScope(userId, async (client) => {
      await client.query(
        `UPDATE quizzes
         SET current_question_index = $1, score = $2, answers = $3, status = $4, updated_at = now()
         WHERE id = $5 AND user_id = $6`,
        [nextIndex, newScore, JSON.stringify(updatedAnswers), nextStatus, quizId, userId]
      );
    });

    // If finished, adjust topic mastery and generate recommendations
    let finalScoreData: QuizTurnResult["finalScore"];
    if (isFinished) {
      const percentage = Math.round((newScore / quiz.totalQuestions) * 100);
      const weakTopics: string[] = [];

      // Collect weak questions
      for (const ans of updatedAnswers) {
        if (!ans.isCorrect) {
          const q = quiz.questions[ans.questionIndex];
          if (q?.topic && !weakTopics.includes(q.topic)) {
            weakTopics.push(q.topic);
          }
        }
      }

      // Deterministically update topic mastery in CourseService
      if (this.courseService && quiz.topicId) {
        const delta = percentage >= 80 ? 10 : percentage >= 50 ? 0 : -10;
        await this.courseService.updateTopicMastery(userId, quiz.topicId, { delta });
      }

      let recommendation = "";
      if (weakTopics.length > 0) {
        recommendation = `Review ${weakTopics.join(", ")} before attempting another quiz.`;
      } else {
        recommendation = "Great job! You showed solid mastery across all tested topics.";
      }

      finalScoreData = {
        score: newScore,
        total: quiz.totalQuestions,
        percentage,
        weakTopics,
        recommendation,
      };
    }

    return {
      quizId: quiz.id,
      questionIndex: nextIndex,
      totalQuestions: quiz.totalQuestions,
      currentQuestion: isFinished ? undefined : quiz.questions[nextIndex],
      lastAnswerFeedback: {
        isCorrect,
        userAnswer: userAnswerText,
        expectedAnswer: currentQuestion.answer,
        explanation: currentQuestion.explanation,
      },
      isFinished,
      finalScore: finalScoreData,
    };
  }

  private evaluateAnswer(userAnswer: string, expectedAnswer: string, options?: string[]): boolean {
    const userClean = userAnswer.trim().toLowerCase();
    const expClean = expectedAnswer.trim().toLowerCase();

    // 1. Direct equality
    if (userClean === expClean) return true;

    // 2. Letter option match e.g. user answered "B", expected is "B" or option B
    if (userClean.length === 1 && expClean.startsWith(userClean)) return true;
    if (expClean.length === 1 && userClean.startsWith(expClean)) return true;

    // 3. Option text match if options are provided
    if (options && options.length > 0) {
      for (const opt of options) {
        const optLower = opt.toLowerCase();
        // If option is "A) Normalization" and user said "normalization" or "A"
        if (optLower.includes(expClean) && optLower.includes(userClean)) {
          return true;
        }
      }
    }

    // 4. Substring containment for short answer
    if (userClean.includes(expClean) || expClean.includes(userClean)) {
      // Ensure it's not trivial 1-char substring
      if (userClean.length >= 3 && expClean.length >= 3) {
        return true;
      }
    }

    return false;
  }

  private extractJsonArray(text: string): Record<string, unknown>[] | null {
    const cleaned = text
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    try {
      const parsed = JSON.parse(cleaned);
      return Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : null;
    } catch {
      const startIdx = cleaned.indexOf("[");
      const endIdx = cleaned.lastIndexOf("]");
      if (startIdx !== -1 && endIdx > startIdx) {
        try {
          const parsed = JSON.parse(cleaned.substring(startIdx, endIdx + 1));
          return Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : null;
        } catch {
          return null;
        }
      }
      return null;
    }
  }

  private mapQuizRow(r: Record<string, unknown>): Quiz {
    return {
      id: r.id as string,
      userId: r.user_id as string,
      courseId: r.course_id as string | null,
      topicId: r.topic_id as string | null,
      title: r.title as string,
      difficulty: r.difficulty as QuizDifficulty,
      questions: typeof r.questions === "string" ? JSON.parse(r.questions) : (r.questions as QuizQuestion[]),
      status: r.status as QuizStatus,
      currentQuestionIndex: Number(r.current_question_index),
      score: Number(r.score),
      totalQuestions: Number(r.total_questions),
      answers: typeof r.answers === "string" ? JSON.parse(r.answers) : ((r.answers as QuizAnswer[]) || []),
      createdAt: new Date(r.created_at as string | number | Date).toISOString(),
      updatedAt: new Date(r.updated_at as string | number | Date).toISOString(),
    };
  }
}
