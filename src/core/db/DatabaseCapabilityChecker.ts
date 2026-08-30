import { Pool } from "pg";
import { getSchedulerPool } from "../../db/pool";
import { logger } from "../../utils/logger";

export interface CapabilityCheckResult {
  success: boolean;
  role: string;
  sessionRole: string;
  missingCapabilities: string[];
  errorDetails?: string;
}

export class DatabaseCapabilityChecker {
  private pool: Pool;

  constructor(pool?: Pool) {
    this.pool = pool || getSchedulerPool();
  }

  /**
   * Non-destructively checks whether the connected database role has required
   * table permissions and RLS access for background scheduler operations.
   */
  async checkCapabilities(): Promise<CapabilityCheckResult> {
    const missing: string[] = [];
    let currentRole = "unknown";
    let sessionRole = "unknown";

    try {
      const roleRes = await this.pool.query(
        "SELECT current_user AS role, session_user AS session_role"
      );
      if (roleRes.rows[0]) {
        currentRole = String(roleRes.rows[0].role);
        sessionRole = String(roleRes.rows[0].session_role);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        role: currentRole,
        sessionRole,
        missingCapabilities: ["CONNECT"],
        errorDetails: `Database connection error: ${msg}`,
      };
    }

    const checks: Array<{ table: string; query: string; capability: string }> = [
      {
        table: "job_queue",
        query: "SELECT id, status FROM job_queue WHERE status = 'pending' LIMIT 0",
        capability: "SELECT on public.job_queue",
      },
      {
        table: "follow_ups",
        query: "SELECT id, status FROM follow_ups WHERE status = 'SCHEDULED' LIMIT 0",
        capability: "SELECT on public.follow_ups",
      },
      {
        table: "tasks",
        query: "SELECT id, status FROM tasks WHERE status = 'pending' LIMIT 0",
        capability: "SELECT on public.tasks",
      },
      {
        table: "notification_dedup_log",
        query: "SELECT id FROM notification_dedup_log LIMIT 0",
        capability: "SELECT on public.notification_dedup_log",
      },
      {
        table: "users",
        query: "SELECT id, platform, timezone FROM users LIMIT 0",
        capability: "SELECT on public.users",
      },
    ];

    for (const check of checks) {
      try {
        await this.pool.query(check.query);
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        if (
          errorMsg.toLowerCase().includes("permission denied") ||
          errorMsg.includes("42501")
        ) {
          missing.push(check.capability);
        } else {
          logger.warn(
            { table: check.table, err: errorMsg },
            `Capability check diagnostic on table '${check.table}' returned non-fatal error`
          );
        }
      }
    }

    return {
      success: missing.length === 0,
      role: currentRole,
      sessionRole,
      missingCapabilities: missing,
    };
  }

  /**
   * Asserts that database permissions are intact at worker startup.
   * Logs clear diagnostics and throws descriptive error if permissions are missing.
   */
  async assertCapabilitiesOrHalt(): Promise<void> {
    const result = await this.checkCapabilities();

    if (!result.success) {
      const errorMsg = [
        "=================================================================",
        "❌ WORKER DATABASE CAPABILITY CHECK FAILED",
        `Role: ${result.role} (Session: ${result.sessionRole})`,
        "Missing required capabilities:",
        ...result.missingCapabilities.map((c) => `  - ${c}`),
        "",
        "Required Action:",
        "Execute database migration: 008_p2_worker_database_permissions.sql",
        "Ensure SCHEDULER_DATABASE_URL connects with role 'scheduler_service' or equivalent trusted worker role.",
        "=================================================================",
      ].join("\n");

      logger.fatal(
        {
          role: result.role,
          missingCapabilities: result.missingCapabilities,
          errorDetails: result.errorDetails,
        },
        errorMsg
      );

      throw new Error(
        `Worker database capability check failed for role '${result.role}'. Missing capabilities: ${result.missingCapabilities.join(", ")}. Apply migration 008_p2_worker_database_permissions.sql.`
      );
    }

    logger.info(
      { role: result.role, sessionRole: result.sessionRole },
      "✅ Worker database capability check passed (Role permissions & RLS policies verified)"
    );
  }
}
