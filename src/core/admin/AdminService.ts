import { getSchedulerPool } from "../../db/pool";
import { JobQueueService } from "../jobs/JobQueueService";
import { AudioSynthesisService } from "../voice/AudioSynthesisService";
import { CalendarService } from "../calendar/CalendarService";

export interface AdminDashboardMetrics {
  users: {
    total: number;
    newToday: number;
    newThisWeek: number;
    newThisMonth: number;
    dau: number;
    wau: number;
    mau: number;
    onboardedRate: number;
    byPlatform: Record<string, number>;
    byPersona: Record<string, number>;
  };
  engagement: {
    totalTasks: number;
    completedTasks: number;
    followThroughRate: number;
    totalFollowUps: number;
    completedFollowUps: number;
    activeProjects: number;
    totalMemories: number;
    totalStudySessions: number;
    completedQuizzes: number;
    averageQuizScore?: number;
    messagesProcessed?: number;
  };
  timestamp: string;
}

export interface AdminSystemHealth {
  status: "healthy" | "degraded" | "unhealthy";
  database: {
    connected: boolean;
    latencyMs: number;
  };
  jobQueue: {
    pending: number;
    active: number;
    failed: number;
    retrying: number;
    deadLetter: number;
  };
  integrations: {
    telegram: { configured: boolean };
    whatsapp: { configured: boolean };
    googleCalendar: {
      configured: boolean;
      totalAccounts: number;
      activeAccounts: number;
      reauthRequiredAccounts: number;
    };
    voiceSynthesis: {
      providers?: Array<{ name: string; state: string; isHealthy: boolean }>;
    };
  };
  timestamp: string;
}

export interface AdminUserSummary {
  id: string;
  platform: string;
  displayName: string | null;
  assistantName: string | null;
  botPersona: string | null;
  timezone: string;
  plan: string;
  onboarded: boolean;
  responseMode: string;
  createdAt: string;
  taskCount: number;
  completedTaskCount: number;
  calendarConnected: boolean;
  studyCourseCount: number;
}

export class AdminService {
  constructor(
    _jobQueueService?: JobQueueService,
    private audioSynthesisService?: AudioSynthesisService,
    _calendarService?: CalendarService
  ) {}

  /**
   * Aggregates key business KPIs and user engagement metrics directly from the database.
   */
  async getDashboardMetrics(): Promise<AdminDashboardMetrics> {
    const pool = getSchedulerPool();

    const [
      userStatsRes,
      activityRes,
      taskStatsRes,
      followUpStatsRes,
      projectCountRes,
      memoryCountRes,
      studyStatsRes,
      quizStatsRes,
      messagesRes,
    ] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*)::int AS total_users,
          COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE)::int AS new_today,
          COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE - INTERVAL '7 days')::int AS new_this_week,
          COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE - INTERVAL '30 days')::int AS new_this_month,
          COUNT(*) FILTER (WHERE onboarded = true)::int AS onboarded_users,
          COUNT(*) FILTER (WHERE platform = 'telegram')::int AS telegram_users,
          COUNT(*) FILTER (WHERE platform = 'whatsapp')::int AS whatsapp_users,
          COUNT(*) FILTER (WHERE persona = 'student')::int AS student_users,
          COUNT(*) FILTER (WHERE persona = 'executive_assistant')::int AS ea_users,
          COUNT(*) FILTER (WHERE persona = 'professional')::int AS pro_users
        FROM users
      `),
      pool.query(`
        SELECT
          COUNT(DISTINCT user_id) FILTER (WHERE created_at >= now() - INTERVAL '1 day')::int AS dau,
          COUNT(DISTINCT user_id) FILTER (WHERE created_at >= now() - INTERVAL '7 days')::int AS wau,
          COUNT(DISTINCT user_id) FILTER (WHERE created_at >= now() - INTERVAL '30 days')::int AS mau
        FROM conversation_turns
      `),
      pool.query(`
        SELECT
          COUNT(*)::int AS total_tasks,
          COUNT(*) FILTER (WHERE status = 'done')::int AS completed_tasks
        FROM tasks
      `),
      pool.query(`
        SELECT
          COUNT(*)::int AS total_followups,
          COUNT(*) FILTER (WHERE status = 'COMPLETED')::int AS completed_followups
        FROM follow_ups
      `),
      pool.query(`SELECT COUNT(*)::int AS total_projects FROM projects`),
      pool.query(`SELECT COUNT(*)::int AS total_memories FROM user_memories`),
      pool.query(`SELECT COUNT(*)::int AS total_sessions FROM study_sessions WHERE status = 'completed'`),
      pool.query(`
        SELECT
          COUNT(*)::int AS total_quizzes,
          COALESCE(AVG(score::float / NULLIF(total_questions, 0) * 100), 0)::int AS avg_accuracy
        FROM quizzes
        WHERE status IN ('COMPLETED', 'REVIEWED')
      `),
      pool.query(`SELECT COUNT(*)::int AS total_messages FROM conversation_turns WHERE role = 'user'`),
    ]);

    const uRow = userStatsRes.rows[0] || {};
    const actRow = activityRes.rows[0] || {};
    const tRow = taskStatsRes.rows[0] || {};
    const fuRow = followUpStatsRes.rows[0] || {};
    const totalUsers = uRow.total_users || 0;
    const onboardedUsers = uRow.onboarded_users || 0;
    const onboardedRate = totalUsers > 0 ? Math.round((onboardedUsers / totalUsers) * 100) : 0;

    const totalTasks = tRow.total_tasks || 0;
    const completedTasks = tRow.completed_tasks || 0;
    const followThroughRate = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

    return {
      users: {
        total: totalUsers,
        newToday: uRow.new_today || 0,
        newThisWeek: uRow.new_this_week || 0,
        newThisMonth: uRow.new_this_month || 0,
        dau: actRow.dau || 0,
        wau: actRow.wau || 0,
        mau: actRow.mau || 0,
        onboardedRate,
        byPlatform: {
          telegram: uRow.telegram_users || 0,
          whatsapp: uRow.whatsapp_users || 0,
        },
        byPersona: {
          student: uRow.student_users || 0,
          executive_assistant: uRow.ea_users || 0,
          professional: uRow.pro_users || 0,
        },
      },
      engagement: {
        totalTasks,
        completedTasks,
        followThroughRate,
        totalFollowUps: fuRow.total_followups || 0,
        completedFollowUps: fuRow.completed_followups || 0,
        activeProjects: projectCountRes.rows[0]?.total_projects || 0,
        totalMemories: memoryCountRes.rows[0]?.total_memories || 0,
        totalStudySessions: studyStatsRes.rows[0]?.total_sessions || 0,
        completedQuizzes: quizStatsRes.rows[0]?.total_quizzes || 0,
        averageQuizScore: quizStatsRes.rows[0]?.avg_accuracy || 0,
        messagesProcessed: messagesRes.rows[0]?.total_messages || 0,
      },
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Inspects database latency, job queue backlog, and provider circuit breaker health.
   */
  async getSystemHealth(): Promise<AdminSystemHealth> {
    const pool = getSchedulerPool();
    const dbStart = Date.now();
    let dbConnected = false;
    let latencyMs = 0;

    try {
      await pool.query("SELECT 1");
      dbConnected = true;
      latencyMs = Date.now() - dbStart;
    } catch {
      dbConnected = false;
    }

    const [jobStatsRes, calStatsRes] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
          COUNT(*) FILTER (WHERE status = 'active')::int AS active,
          COUNT(*) FILTER (WHERE status = 'failed' AND attempts < max_attempts)::int AS retrying,
          COUNT(*) FILTER (WHERE status = 'failed' AND attempts >= max_attempts)::int AS dead_letter,
          COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
        FROM job_queue
      `),
      pool.query(`
        SELECT
          COUNT(*)::int AS total_accounts,
          COUNT(*) FILTER (WHERE status = 'active')::int AS active_accounts,
          COUNT(*) FILTER (WHERE status = 'reauth_required')::int AS reauth_accounts
        FROM calendar_accounts
      `),
    ]);

    const jRow = jobStatsRes.rows[0] || {};
    const cRow = calStatsRes.rows[0] || {};

    const voiceHealth = this.audioSynthesisService
      ? this.audioSynthesisService.getProviderHealth().map((p) => ({
          name: p.providerName,
          state: p.circuitState,
          isHealthy: p.circuitState === "CLOSED",
        }))
      : [];

    const isHealthy = dbConnected && (jRow.dead_letter || 0) < 50;

    return {
      status: isHealthy ? "healthy" : "degraded",
      database: {
        connected: dbConnected,
        latencyMs,
      },
      jobQueue: {
        pending: jRow.pending || 0,
        active: jRow.active || 0,
        failed: jRow.failed || 0,
        retrying: jRow.retrying || 0,
        deadLetter: jRow.dead_letter || 0,
      },
      integrations: {
        telegram: { configured: Boolean(process.env.TELEGRAM_BOT_TOKEN) },
        whatsapp: { configured: Boolean(process.env.WHATSAPP_ACCESS_TOKEN) },
        googleCalendar: {
          configured: Boolean(
            process.env.GOOGLE_CLIENT_ID && !process.env.GOOGLE_CLIENT_ID.includes("PLACEHOLDER")
          ),
          totalAccounts: cRow.total_accounts || 0,
          activeAccounts: cRow.active_accounts || 0,
          reauthRequiredAccounts: cRow.reauth_accounts || 0,
        },
        voiceSynthesis: {
          providers: voiceHealth,
        },
      },
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Retrieves a paginated list of users with engagement counts and channel metadata.
   * Redacts all sensitive user content (conversations, tokens, secrets).
   */
  async getUsersList(
    page: number = 1,
    limit: number = 20,
    search?: string
  ): Promise<{ users: AdminUserSummary[]; total: number; page: number; limit: number }> {
    const pool = getSchedulerPool();
    const offset = Math.max(0, (page - 1) * limit);

    let whereClause = "";
    const params: unknown[] = [];

    if (search && search.trim().length > 0) {
      params.push(`%${search.trim().toLowerCase()}%`);
      whereClause = "WHERE LOWER(u.display_name) LIKE $1 OR LOWER(u.platform_user_id) LIKE $1";
    }

    const countRes = await pool.query(
      `SELECT COUNT(*)::int AS total FROM users u ${whereClause}`,
      params
    );
    const total = countRes.rows[0]?.total || 0;

    const limitParamIdx = params.length + 1;
    const offsetParamIdx = params.length + 2;
    params.push(limit, offset);

    const query = `
      SELECT
        u.id,
        u.platform,
        u.display_name AS "displayName",
        u.persona,
        u.plan,
        u.onboarded,
        u.response_mode AS "responseMode",
        u.created_at AS "createdAt",
        COALESCE(t.task_count, 0)::int AS "taskCount",
        COALESCE(t.completed_task_count, 0)::int AS "completedTaskCount",
        EXISTS(SELECT 1 FROM calendar_accounts ca WHERE ca.user_id = u.id AND ca.status = 'active') AS "calendarConnected",
        COALESCE(c.course_count, 0)::int AS "studyCourseCount"
      FROM users u
      LEFT JOIN (
        SELECT user_id, COUNT(*) AS task_count, COUNT(*) FILTER (WHERE status = 'done') AS completed_task_count
        FROM tasks
        GROUP BY user_id
      ) t ON t.user_id = u.id
      LEFT JOIN (
        SELECT user_id, COUNT(*) AS course_count
        FROM courses
        GROUP BY user_id
      ) c ON c.user_id = u.id
      ${whereClause}
      ORDER BY u.created_at DESC
      LIMIT $${limitParamIdx} OFFSET $${offsetParamIdx}
    `;

    const res = await pool.query(query, params);

    return {
      users: res.rows,
      total,
      page,
      limit,
    };
  }
}
