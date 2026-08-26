import { getSchedulerPool } from "../../db/pool";
import { logger } from "../../utils/logger";
import type { NotificationDedupStatus } from "../../types/domain";

export type DbQueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>;

export class NotificationDeduplicationService {
  private dbQuery: DbQueryFn;

  constructor(dbQuery?: DbQueryFn) {
    this.dbQuery =
      dbQuery ||
      (async (sql: string, params?: unknown[]) => {
        return getSchedulerPool().query(sql, params);
      });
  }

  /**
   * Atomically claims a notification delivery by its unique dedupKey.
   * Returns true if successfully reserved, false if already claimed/delivered.
   */
  async claimNotification(
    userId: string,
    dedupKey: string,
    channel: string,
    category: string = "general"
  ): Promise<boolean> {
    try {
      const { rows } = await this.dbQuery(
        `INSERT INTO notification_dedup_log (user_id, dedup_key, channel, category, status)
         VALUES ($1, $2, $3, $4, 'pending')
         ON CONFLICT (user_id, dedup_key) DO NOTHING
         RETURNING id`,
        [userId, dedupKey, channel, category]
      );

      const claimed = rows.length > 0;
      if (!claimed) {
        logger.info({ userId, dedupKey, channel }, "Notification suppressed: duplicate dedup key already exists");
      }
      return claimed;
    } catch (err) {
      logger.error({ err, userId, dedupKey }, "Failed to claim notification deduplication lock");
      return false;
    }
  }

  async reserveNotification(
    userId: string,
    dedupKey: string,
    channel: string,
    category: string = "general",
    _payloadSummary?: string
  ): Promise<boolean> {
    return this.claimNotification(userId, dedupKey, channel, category);
  }

  /**
   * Updates notification record outcome following delivery attempt.
   */
  async recordOutcome(
    userId: string,
    dedupKey: string,
    status: NotificationDedupStatus,
    payloadSummary?: string
  ): Promise<void> {
    await this.dbQuery(
      `UPDATE notification_dedup_log
       SET status = $1,
           payload_summary = $2,
           delivered_at = now()
       WHERE user_id = $3 AND dedup_key = $4`,
      [status, payloadSummary || null, userId, dedupKey]
    );
  }

  /**
   * Checks if notification key was already delivered or batched.
   */
  async isDelivered(userId: string, dedupKey: string): Promise<boolean> {
    const { rows } = await this.dbQuery(
      `SELECT id, status FROM notification_dedup_log
       WHERE user_id = $1 AND dedup_key = $2 AND status IN ('delivered', 'batched')`,
      [userId, dedupKey]
    );
    return rows.length > 0;
  }

  /**
   * Returns recent notification delivery count in rolling window (e.g. 1 hour) for rate limiting.
   */
  async getRecentNotificationCount(userId: string, windowMinutes: number = 60): Promise<number> {
    const { rows } = await this.dbQuery(
      `SELECT COUNT(*) as count
       FROM notification_dedup_log
       WHERE user_id = $1
         AND delivered_at >= now() - ($2 || ' minutes')::interval
         AND status = 'delivered'`,
      [userId, windowMinutes]
    );

    const r = (rows[0] || {}) as { count?: string | number };
    return Number(r.count) || 0;
  }

  /**
   * Checks the timestamp of the most recent follow-up for a task to prevent rapid nagging.
   */
  async getLastNotificationTimestamp(userId: string, dedupKeyPrefix: string): Promise<Date | null> {
    const { rows } = await this.dbQuery(
      `SELECT delivered_at
       FROM notification_dedup_log
       WHERE user_id = $1 AND dedup_key LIKE $2 || '%'
       ORDER BY delivered_at DESC
       LIMIT 1`,
      [userId, dedupKeyPrefix]
    );

    if (rows.length === 0) return null;
    const r = rows[0] as { delivered_at: string };
    return new Date(r.delivered_at);
  }
}
