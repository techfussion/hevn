import type { PoolClient } from "pg";
import { withUserScope } from "../../db/pool";
import { logger } from "../../utils/logger";
import type {
  Course,
  CourseStatus,
  CourseTopic,
  TopicStatus,
  Assessment,
  AssessmentType,
} from "../../types/domain";
import type { TaskService } from "../tasks/TaskService";

export type UserScopeFn = <T>(
  userId: string,
  fn: (client: PoolClient) => Promise<T>
) => Promise<T>;

export interface CreateCourseInput {
  name: string;
  code?: string;
  description?: string;
  instructor?: string;
  institution?: string;
  semester?: string;
}

export interface CreateTopicInput {
  courseId: string;
  title: string;
  description?: string;
  ordering?: number;
  estimatedStudyMinutes?: number;
}

export interface CreateAssessmentInput {
  courseId: string;
  title: string;
  assessmentType?: AssessmentType;
  dueAt: string; // ISO 8601
  weightPercentage?: number;
}

export class CourseService {
  private dbScope: UserScopeFn;

  constructor(
    private taskService?: TaskService,
    dbScope?: UserScopeFn
  ) {
    this.dbScope = dbScope || withUserScope;
  }

  // ==========================================
  // Course Management
  // ==========================================

  async createCourse(userId: string, input: CreateCourseInput): Promise<Course> {
    const trimmedName = input.name.trim();
    if (!trimmedName) {
      throw new Error("Course name cannot be empty");
    }

    return this.dbScope(userId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO courses (user_id, name, code, description, instructor, institution, semester, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
         RETURNING id, user_id, name, code, description, instructor, institution, semester, status, created_at, updated_at`,
        [
          userId,
          trimmedName,
          input.code?.trim() || null,
          input.description?.trim() || null,
          input.instructor?.trim() || null,
          input.institution?.trim() || null,
          input.semester?.trim() || null,
        ]
      );
      logger.info({ courseId: rows[0].id, userId, name: trimmedName }, "Course created");
      return this.mapCourseRow(rows[0]);
    });
  }

  async listCourses(userId: string, status?: CourseStatus): Promise<Course[]> {
    return this.dbScope(userId, async (client) => {
      let query = `SELECT id, user_id, name, code, description, instructor, institution, semester, status, created_at, updated_at
                   FROM courses
                   WHERE user_id = $1`;
      const params: (string | CourseStatus)[] = [userId];

      if (status) {
        query += ` AND status = $2`;
        params.push(status);
      } else {
        query += ` AND status = 'active'`;
      }

      query += ` ORDER BY created_at DESC`;

      const { rows } = await client.query(query, params);
      return rows.map((r) => this.mapCourseRow(r));
    });
  }

  async getCourse(userId: string, courseId: string): Promise<Course | null> {
    return this.dbScope(userId, async (client) => {
      const { rows } = await client.query(
        `SELECT id, user_id, name, code, description, instructor, institution, semester, status, created_at, updated_at
         FROM courses
         WHERE id = $1 AND user_id = $2`,
        [courseId, userId]
      );
      return rows[0] ? this.mapCourseRow(rows[0]) : null;
    });
  }

  async findCourseByName(userId: string, name: string): Promise<Course | null> {
    return this.dbScope(userId, async (client) => {
      const { rows } = await client.query(
        `SELECT id, user_id, name, code, description, instructor, institution, semester, status, created_at, updated_at
         FROM courses
         WHERE user_id = $1 AND (LOWER(name) = LOWER($2) OR LOWER(code) = LOWER($2))
         LIMIT 1`,
        [userId, name.trim()]
      );
      return rows[0] ? this.mapCourseRow(rows[0]) : null;
    });
  }

  // ==========================================
  // Course Topics & Mastery
  // ==========================================

  async createTopic(userId: string, input: CreateTopicInput): Promise<CourseTopic> {
    const trimmedTitle = input.title.trim();
    if (!trimmedTitle) {
      throw new Error("Topic title cannot be empty");
    }

    return this.dbScope(userId, async (client) => {
      // If ordering not provided, append to the end
      let ordering = input.ordering;
      if (ordering === undefined) {
        const { rows: maxRows } = await client.query(
          `SELECT COALESCE(MAX(ordering), 0) + 1 AS next_order
           FROM course_topics
           WHERE course_id = $1 AND user_id = $2`,
          [input.courseId, userId]
        );
        ordering = Number(maxRows[0]?.next_order) || 1;
      }

      const { rows } = await client.query(
        `INSERT INTO course_topics (course_id, user_id, title, description, ordering, estimated_study_minutes, mastery_level, status)
         VALUES ($1, $2, $3, $4, $5, $6, 0, 'not_started')
         RETURNING id, course_id, user_id, title, description, ordering, estimated_study_minutes, mastery_level, status, created_at, updated_at`,
        [
          input.courseId,
          userId,
          trimmedTitle,
          input.description?.trim() || null,
          ordering,
          input.estimatedStudyMinutes ?? 60,
        ]
      );
      return this.mapTopicRow(rows[0]);
    });
  }

  async listTopics(userId: string, courseId: string): Promise<CourseTopic[]> {
    return this.dbScope(userId, async (client) => {
      const { rows } = await client.query(
        `SELECT id, course_id, user_id, title, description, ordering, estimated_study_minutes, mastery_level, status, created_at, updated_at
         FROM course_topics
         WHERE course_id = $1 AND user_id = $2
         ORDER BY ordering ASC`,
        [courseId, userId]
      );
      return rows.map((r) => this.mapTopicRow(r));
    });
  }

  async getTopic(userId: string, topicId: string): Promise<CourseTopic | null> {
    return this.dbScope(userId, async (client) => {
      const { rows } = await client.query(
        `SELECT id, course_id, user_id, title, description, ordering, estimated_study_minutes, mastery_level, status, created_at, updated_at
         FROM course_topics
         WHERE id = $1 AND user_id = $2`,
        [topicId, userId]
      );
      return rows[0] ? this.mapTopicRow(rows[0]) : null;
    });
  }

  /**
   * Deterministically updates topic mastery level.
   * Bounded strictly between 0 and 100.
   */
  async updateTopicMastery(
    userId: string,
    topicId: string,
    adjustment: { delta?: number; absolute?: number }
  ): Promise<CourseTopic | null> {
    return this.dbScope(userId, async (client) => {
      const current = await this.getTopic(userId, topicId);
      if (!current) return null;

      let newLevel = current.masteryLevel;
      if (adjustment.absolute !== undefined) {
        newLevel = adjustment.absolute;
      } else if (adjustment.delta !== undefined) {
        newLevel += adjustment.delta;
      }

      // Bound strictly 0..100
      newLevel = Math.max(0, Math.min(100, Math.round(newLevel)));

      let status: TopicStatus = "in_progress";
      if (newLevel >= 85) {
        status = "mastered";
      } else if (newLevel === 0) {
        status = "not_started";
      }

      const { rows } = await client.query(
        `UPDATE course_topics
         SET mastery_level = $1, status = $2, updated_at = now()
         WHERE id = $3 AND user_id = $4
         RETURNING id, course_id, user_id, title, description, ordering, estimated_study_minutes, mastery_level, status, created_at, updated_at`,
        [newLevel, status, topicId, userId]
      );

      return rows[0] ? this.mapTopicRow(rows[0]) : null;
    });
  }

  // ==========================================
  // Assessment & Exam Tracking
  // ==========================================

  async createAssessment(userId: string, input: CreateAssessmentInput): Promise<Assessment> {
    const trimmedTitle = input.title.trim();
    if (!trimmedTitle) {
      throw new Error("Assessment title cannot be empty");
    }

    let linkedTaskId: string | null = null;

    // Automatically create a linked commitment task in Hevn task subsystem if taskService is available
    if (this.taskService) {
      try {
        const task = await this.taskService.createTask(userId, {
          title: trimmedTitle,
          dueAtIso: input.dueAt,
          priority: "high",
          taskType: "commitment",
          reminderOffsetMinutes: 1440, // 24h before exam reminder
        });
        linkedTaskId = task.id;
      } catch (err) {
        logger.warn({ err, userId }, "Failed to create linked commitment task for assessment");
      }
    }

    return this.dbScope(userId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO assessments (course_id, user_id, title, assessment_type, due_at, weight_percentage, linked_task_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, course_id, user_id, title, assessment_type, due_at, weight_percentage, linked_task_id, created_at, updated_at`,
        [
          input.courseId,
          userId,
          trimmedTitle,
          input.assessmentType || "exam",
          input.dueAt,
          input.weightPercentage || null,
          linkedTaskId,
        ]
      );

      logger.info({ assessmentId: rows[0].id, userId, title: trimmedTitle }, "Assessment created");
      return this.mapAssessmentRow(rows[0]);
    });
  }

  async listAssessments(userId: string, courseId?: string): Promise<Assessment[]> {
    return this.dbScope(userId, async (client) => {
      let query = `SELECT id, course_id, user_id, title, assessment_type, due_at, weight_percentage, linked_task_id, created_at, updated_at
                   FROM assessments
                   WHERE user_id = $1`;
      const params: string[] = [userId];

      if (courseId) {
        query += ` AND course_id = $2`;
        params.push(courseId);
      }

      query += ` ORDER BY due_at ASC`;

      const { rows } = await client.query(query, params);
      return rows.map((r) => this.mapAssessmentRow(r));
    });
  }

  async getAssessment(userId: string, assessmentId: string): Promise<Assessment | null> {
    return this.dbScope(userId, async (client) => {
      const { rows } = await client.query(
        `SELECT id, course_id, user_id, title, assessment_type, due_at, weight_percentage, linked_task_id, created_at, updated_at
         FROM assessments
         WHERE id = $1 AND user_id = $2`,
        [assessmentId, userId]
      );
      return rows[0] ? this.mapAssessmentRow(rows[0]) : null;
    });
  }

  // ==========================================
  // Row Mappers
  // ==========================================

  private mapCourseRow(r: Record<string, unknown>): Course {
    return {
      id: r.id as string,
      userId: r.user_id as string,
      name: r.name as string,
      code: r.code as string | null,
      description: r.description as string | null,
      instructor: r.instructor as string | null,
      institution: r.institution as string | null,
      semester: r.semester as string | null,
      status: r.status as CourseStatus,
      createdAt: new Date(r.created_at as string | number | Date).toISOString(),
      updatedAt: new Date(r.updated_at as string | number | Date).toISOString(),
    };
  }

  private mapTopicRow(r: Record<string, unknown>): CourseTopic {
    return {
      id: r.id as string,
      courseId: r.course_id as string,
      userId: r.user_id as string,
      title: r.title as string,
      description: r.description as string | null,
      ordering: Number(r.ordering),
      estimatedStudyMinutes: Number(r.estimated_study_minutes),
      masteryLevel: Number(r.mastery_level),
      status: r.status as TopicStatus,
      createdAt: new Date(r.created_at as string | number | Date).toISOString(),
      updatedAt: new Date(r.updated_at as string | number | Date).toISOString(),
    };
  }

  private mapAssessmentRow(r: Record<string, unknown>): Assessment {
    return {
      id: r.id as string,
      courseId: r.course_id as string,
      userId: r.user_id as string,
      title: r.title as string,
      assessmentType: r.assessment_type as AssessmentType,
      dueAt: new Date(r.due_at as string | number | Date).toISOString(),
      weightPercentage: r.weight_percentage ? Number(r.weight_percentage) : null,
      linkedTaskId: r.linked_task_id as string | null,
      createdAt: new Date(r.created_at as string | number | Date).toISOString(),
      updatedAt: new Date(r.updated_at as string | number | Date).toISOString(),
    };
  }
}
