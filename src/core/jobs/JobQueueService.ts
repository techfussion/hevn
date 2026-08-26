import { getSchedulerPool } from "../../db/pool";
import { logger } from "../../utils/logger";
import type { Job, JobOptions, JobStatus } from "../../types/domain";
import type { JobTelemetryEvent, QueueMetrics } from "./types";

export type DbQueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>;

export class JobQueueService {
  private dbQuery: DbQueryFn;

  constructor(dbQuery?: DbQueryFn) {
    this.dbQuery =
      dbQuery ||
      (async (sql: string, params?: unknown[]) => {
        return getSchedulerPool().query(sql, params);
      });
  }

  /**
   * Structured telemetry emission for job lifecycle events.
   */
  emitTelemetry(event: JobTelemetryEvent) {
    logger.info(
      {
        telemetry: true,
        metric: event.eventType,
        jobId: event.jobId,
        jobType: event.jobType,
        queueName: event.queueName,
        userId: event.userId,
        attempts: event.attempts,
        durationMs: event.durationMs,
        error: event.error,
      },
      `Job telemetry event: ${event.eventType}`
    );
  }

  /**
   * Enqueues a durable job with optional scheduling, priority, idempotency, or singleton locks.
   */
  async enqueue<T = Record<string, unknown>>(
    jobType: string,
    payload: T,
    options?: JobOptions,
    userId?: string | null
  ): Promise<Job<T>> {
    const queueName = options?.queueName || "default";
    const priority = options?.priority ?? 0;
    const maxAttempts = options?.maxAttempts ?? 5;
    const idempotencyKey = options?.idempotencyKey || null;
    const singletonKey = options?.singletonKey || null;

    let runAtDate = new Date();
    if (options?.runAt) {
      runAtDate = new Date(options.runAt);
    } else if (options?.delaySeconds && options.delaySeconds > 0) {
      runAtDate = new Date(Date.now() + options.delaySeconds * 1000);
    }
    const runAtIso = runAtDate.toISOString();

    // 1. If singleton_key provided, check if active/pending job exists
    if (singletonKey) {
      const existing = await this.dbQuery(
        `SELECT id, queue_name, job_type, user_id, payload, status, idempotency_key, singleton_key,
                priority, attempts, max_attempts, run_at, locked_until, locked_by, last_error,
                created_at, updated_at, completed_at
         FROM job_queue
         WHERE queue_name = $1 AND singleton_key = $2 AND status IN ('pending', 'active')
         LIMIT 1`,
        [queueName, singletonKey]
      );
      if (existing.rows.length > 0) {
        return this.mapJobRow<T>(existing.rows[0] as Record<string, unknown>);
      }
    }

    // 2. Insert with idempotency guard
    const query = `
      INSERT INTO job_queue (
        queue_name, job_type, user_id, payload, priority, max_attempts,
        run_at, idempotency_key, singleton_key, status
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending'
      )
      ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
      RETURNING id, queue_name, job_type, user_id, payload, status, idempotency_key, singleton_key,
                priority, attempts, max_attempts, run_at, locked_until, locked_by, last_error,
                created_at, updated_at, completed_at
    `;

    const { rows } = await this.dbQuery(query, [
      queueName,
      jobType,
      userId || null,
      JSON.stringify(payload),
      priority,
      maxAttempts,
      runAtIso,
      idempotencyKey,
      singletonKey,
    ]);

    if (rows.length > 0) {
      const createdJob = this.mapJobRow<T>(rows[0] as Record<string, unknown>);
      this.emitTelemetry({
        eventType: "job.enqueued",
        jobId: createdJob.id,
        jobType: createdJob.jobType,
        queueName: createdJob.queueName,
        userId: createdJob.userId,
      });
      return createdJob;
    }

    // Idempotency key collided — retrieve the existing record
    if (idempotencyKey) {
      const existing = await this.dbQuery(
        `SELECT id, queue_name, job_type, user_id, payload, status, idempotency_key, singleton_key,
                priority, attempts, max_attempts, run_at, locked_until, locked_by, last_error,
                created_at, updated_at, completed_at
         FROM job_queue
         WHERE idempotency_key = $1
         LIMIT 1`,
        [idempotencyKey]
      );
      if (existing.rows.length > 0) {
        return this.mapJobRow<T>(existing.rows[0] as Record<string, unknown>);
      }
    }

    throw new Error(`Failed to enqueue job of type '${jobType}'`);
  }

  /**
   * Enqueues a job with a boolean return pattern (suppresses singleton collisions cleanly).
   */
  async enqueueJob<T = Record<string, unknown>>(
    queueName: string,
    jobType: string,
    payload: T,
    options?: {
      userId?: string | null;
      priority?: number;
      runAtIso?: string;
      singletonKey?: string;
      idempotencyKey?: string;
      maxAttempts?: number;
      delaySeconds?: number;
    }
  ): Promise<{ enqueued: boolean; job?: Job<T> }> {
    if (options?.singletonKey) {
      const existing = await this.dbQuery(
        `SELECT id, queue_name, job_type, user_id, payload, status, idempotency_key, singleton_key,
                priority, attempts, max_attempts, run_at, locked_until, locked_by, last_error,
                created_at, updated_at, completed_at
         FROM job_queue
         WHERE queue_name = $1 AND singleton_key = $2 AND status IN ('pending', 'active')
         LIMIT 1`,
        [queueName, options.singletonKey]
      );
      if (existing.rows.length > 0) {
        return { enqueued: false, job: this.mapJobRow<T>(existing.rows[0] as Record<string, unknown>) };
      }
    }

    const job = await this.enqueue<T>(
      jobType,
      payload,
      {
        queueName,
        priority: options?.priority,
        runAt: options?.runAtIso ? new Date(options.runAtIso) : undefined,
        delaySeconds: options?.delaySeconds,
        singletonKey: options?.singletonKey,
        idempotencyKey: options?.idempotencyKey,
        maxAttempts: options?.maxAttempts,
      },
      options?.userId
    );
    return { enqueued: true, job };
  }

  /**
   * Atomically claims a batch of pending jobs using PostgreSQL SKIP LOCKED.
   * Sets lease timeout via locked_until and increments attempt count.
   */
  async claimJobs<T = Record<string, unknown>>(
    queueName: string = "default",
    count: number = 10,
    leaseDurationSeconds: number = 60,
    workerId: string = `worker-${process.pid}`
  ): Promise<Job<T>[]> {
    const query = `
      WITH claimable AS (
        SELECT id FROM job_queue
        WHERE queue_name = $1
          AND status = 'pending'
          AND run_at <= now()
        ORDER BY priority DESC, run_at ASC
        LIMIT $2
        FOR UPDATE SKIP LOCKED
      )
      UPDATE job_queue
      SET status = 'active',
          locked_until = now() + ($3 || ' seconds')::interval,
          locked_by = $4,
          attempts = attempts + 1,
          updated_at = now()
      FROM claimable
      WHERE job_queue.id = claimable.id
      RETURNING job_queue.id, job_queue.queue_name, job_queue.job_type, job_queue.user_id,
                job_queue.payload, job_queue.status, job_queue.idempotency_key, job_queue.singleton_key,
                job_queue.priority, job_queue.attempts, job_queue.max_attempts, job_queue.run_at,
                job_queue.locked_until, job_queue.locked_by, job_queue.last_error, job_queue.created_at,
                job_queue.updated_at, job_queue.completed_at
    `;

    const { rows } = await this.dbQuery(query, [
      queueName,
      count,
      leaseDurationSeconds,
      workerId,
    ]);

    const claimed = rows.map((r) => this.mapJobRow<T>(r as Record<string, unknown>));
    for (const job of claimed) {
      this.emitTelemetry({
        eventType: "job.claimed",
        jobId: job.id,
        jobType: job.jobType,
        queueName: job.queueName,
        userId: job.userId,
        attempts: job.attempts,
      });
    }

    return claimed;
  }

  /**
   * Marks job as successfully completed.
   */
  async completeJob(jobId: string, durationMs?: number): Promise<void> {
    await this.dbQuery(
      `UPDATE job_queue
       SET status = 'completed',
           locked_until = NULL,
           locked_by = NULL,
           completed_at = now(),
           updated_at = now()
       WHERE id = $1`,
      [jobId]
    );

    this.emitTelemetry({
      eventType: "job.completed",
      jobId,
      durationMs,
    });
  }

  /**
   * Handles job failure.
   * If attempts < max_attempts: schedules retry with exponential backoff.
   * If attempts >= max_attempts: transitions to 'failed' (Dead-letter queue).
   */
  async failJob(
    jobId: string,
    error: Error | string,
    options?: { retryDelaySeconds?: number; durationMs?: number }
  ): Promise<{ status: "retried" | "dead_lettered"; nextRunAt?: string }> {
    const errorMessage = typeof error === "string" ? error : error.message || String(error);

    // 1. Fetch current attempt and max_attempts
    const { rows } = await this.dbQuery(
      `SELECT attempts, max_attempts, job_type, queue_name, user_id FROM job_queue WHERE id = $1`,
      [jobId]
    );

    if (rows.length === 0) {
      throw new Error(`Job not found: ${jobId}`);
    }

    const row = rows[0] as {
      attempts: number;
      max_attempts: number;
      job_type: string;
      queue_name: string;
      user_id: string | null;
    };

    const attempts = Number(row.attempts) || 1;
    const maxAttempts = Number(row.max_attempts) || 5;

    if (attempts < maxAttempts) {
      // Calculate exponential backoff with jitter: 2^attempts * 10 seconds (capped at 1 hour)
      const delaySeconds =
        options?.retryDelaySeconds !== undefined
          ? options.retryDelaySeconds
          : Math.min(3600, Math.pow(2, attempts) * 10) + Math.floor(Math.random() * 5);

      const nextRunDate = new Date(Date.now() + delaySeconds * 1000);
      const nextRunIso = nextRunDate.toISOString();

      await this.dbQuery(
        `UPDATE job_queue
         SET status = 'pending',
             run_at = $2,
             locked_until = NULL,
             locked_by = NULL,
             last_error = $3,
             updated_at = now()
         WHERE id = $1`,
        [jobId, nextRunIso, errorMessage]
      );

      this.emitTelemetry({
        eventType: "job.retried",
        jobId,
        jobType: row.job_type,
        queueName: row.queue_name,
        userId: row.user_id,
        attempts,
        durationMs: options?.durationMs,
        error: errorMessage,
      });

      return { status: "retried", nextRunAt: nextRunIso };
    }

    // Exceeded max attempts -> Dead Letter Queue
    await this.dbQuery(
      `UPDATE job_queue
       SET status = 'failed',
           locked_until = NULL,
           locked_by = NULL,
           last_error = $2,
           updated_at = now()
       WHERE id = $1`,
      [jobId, errorMessage]
    );

    this.emitTelemetry({
      eventType: "job.dead_lettered",
      jobId,
      jobType: row.job_type,
      queueName: row.queue_name,
      userId: row.user_id,
      attempts,
      durationMs: options?.durationMs,
      error: errorMessage,
    });

    return { status: "dead_lettered" };
  }

  /**
   * Reclaims stale jobs whose lock leases have expired (e.g. after worker crash/timeout).
   */
  async recoverStaleJobs(queueName?: string): Promise<number> {
    let query = `
      UPDATE job_queue
      SET status = 'pending',
          locked_until = NULL,
          locked_by = NULL,
          updated_at = now()
      WHERE status = 'active'
        AND locked_until < now()
    `;
    const params: unknown[] = [];

    if (queueName) {
      query += ` AND queue_name = $1`;
      params.push(queueName);
    }

    query += ` RETURNING id, job_type, queue_name`;

    const { rows } = await this.dbQuery(query, params);
    const recoveredCount = rows.length;

    if (recoveredCount > 0) {
      logger.warn({ count: recoveredCount, queueName }, "Recovered stale active job(s) from expired lease");
      this.emitTelemetry({
        eventType: "job.stale_recovered",
        queueName,
        attempts: recoveredCount,
      });
    }

    return recoveredCount;
  }

  /**
   * Replays dead-lettered jobs by resetting status to 'pending' and zeroing attempts.
   */
  async replayDeadLetterJobs(options?: { queueName?: string; jobIds?: string[] }): Promise<number> {
    let query = `
      UPDATE job_queue
      SET status = 'pending',
          attempts = 0,
          run_at = now(),
          locked_until = NULL,
          locked_by = NULL,
          last_error = NULL,
          completed_at = NULL,
          updated_at = now()
      WHERE status = 'failed'
    `;
    const params: unknown[] = [];

    if (options?.jobIds && options.jobIds.length > 0) {
      query += ` AND id = ANY($1::uuid[])`;
      params.push(options.jobIds);
    } else if (options?.queueName) {
      query += ` AND queue_name = $1`;
      params.push(options.queueName);
    }

    query += ` RETURNING id`;

    const { rows } = await this.dbQuery(query, params);
    const replayedCount = rows.length;

    if (replayedCount > 0) {
      logger.info({ count: replayedCount }, "Replayed dead-lettered job(s)");
      this.emitTelemetry({
        eventType: "job.dead_letter_replayed",
        queueName: options?.queueName,
        attempts: replayedCount,
      });
    }

    return replayedCount;
  }

  /**
   * Retrieves high-level queue metrics.
   */
  async getQueueMetrics(queueName: string = "default"): Promise<QueueMetrics> {
    const { rows } = await this.dbQuery(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'pending') AS pending_count,
         COUNT(*) FILTER (WHERE status = 'active') AS active_count,
         COUNT(*) FILTER (WHERE status = 'completed') AS completed_count,
         COUNT(*) FILTER (WHERE status = 'failed') AS failed_count,
         MIN(run_at) FILTER (WHERE status = 'pending') AS oldest_pending_run_at
       FROM job_queue
       WHERE queue_name = $1`,
      [queueName]
    );

    const r = (rows[0] || {}) as Record<string, unknown>;
    return {
      queueName,
      pendingCount: Number(r.pending_count) || 0,
      activeCount: Number(r.active_count) || 0,
      completedCount: Number(r.completed_count) || 0,
      failedCount: Number(r.failed_count) || 0,
      oldestPendingRunAt: r.oldest_pending_run_at ? new Date(r.oldest_pending_run_at as string).toISOString() : null,
    };
  }

  private mapJobRow<T>(r: Record<string, unknown>): Job<T> {
    let payload = r.payload as T;
    if (typeof payload === "string") {
      try {
        payload = JSON.parse(payload);
      } catch {
        // use raw
      }
    }

    return {
      id: r.id as string,
      queueName: r.queue_name as string,
      jobType: r.job_type as string,
      userId: (r.user_id as string) || null,
      payload,
      status: r.status as JobStatus,
      idempotencyKey: (r.idempotency_key as string) || null,
      singletonKey: (r.singleton_key as string) || null,
      priority: Number(r.priority) || 0,
      attempts: Number(r.attempts) || 0,
      maxAttempts: Number(r.max_attempts) || 5,
      runAt: new Date(r.run_at as string | number | Date).toISOString(),
      lockedUntil: r.locked_until ? new Date(r.locked_until as string | number | Date).toISOString() : null,
      lockedBy: (r.locked_by as string) || null,
      lastError: (r.last_error as string) || null,
      createdAt: new Date(r.created_at as string | number | Date).toISOString(),
      updatedAt: new Date(r.updated_at as string | number | Date).toISOString(),
      completedAt: r.completed_at ? new Date(r.completed_at as string | number | Date).toISOString() : null,
    };
  }
}
