import test from "node:test";
import assert from "node:assert/strict";
import { JobQueueService } from "../src/core/jobs/JobQueueService";
import type { Job } from "../src/types/domain";

test("JobQueueService — Durable Job Execution, Lease Locking, Crash Recovery & Dead-Letter Replay", async (t) => {
  // In-memory mock database for job_queue
  const jobDb: any[] = [];

  const mockDbQuery = async (rawSql: string, params?: any[]): Promise<{ rows: any[]; rowCount?: number }> => {
    const sql = rawSql.replace(/\s+/g, " ");

    // 1. SELECT singleton_key check
    if (sql.includes("FROM job_queue WHERE queue_name = $1 AND singleton_key = $2")) {
      const match = jobDb.find(
        (j) => j.queue_name === params![0] && j.singleton_key === params![1] && (j.status === "pending" || j.status === "active")
      );
      return { rows: match ? [match] : [] };
    }

    // 2. INSERT into job_queue
    if (sql.includes("INSERT INTO job_queue")) {
      const idempotencyKey = params![7];
      if (idempotencyKey) {
        const existing = jobDb.find((j) => j.idempotency_key === idempotencyKey);
        if (existing) {
          return { rows: [] }; // ON CONFLICT DO NOTHING
        }
      }

      const job = {
        id: `job-${jobDb.length + 1}`,
        queue_name: params![0],
        job_type: params![1],
        user_id: params![2],
        payload: typeof params![3] === "string" ? JSON.parse(params![3]) : params![3],
        priority: Number(params![4]),
        max_attempts: Number(params![5]),
        run_at: params![6],
        idempotency_key: params![7] || null,
        singleton_key: params![8] || null,
        status: "pending",
        attempts: 0,
        locked_until: null,
        locked_by: null,
        last_error: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        completed_at: null,
      };
      jobDb.push(job);
      return { rows: [job] };
    }

    // 3. SELECT by idempotency_key
    if (sql.includes("FROM job_queue WHERE idempotency_key = $1")) {
      const match = jobDb.find((j) => j.idempotency_key === params![0]);
      return { rows: match ? [match] : [] };
    }

    // 4. Claim pending jobs (WITH claimable AS ...)
    if (sql.includes("WITH claimable AS") && sql.includes("UPDATE job_queue")) {
      const queueName = params![0];
      const limit = Number(params![1]);
      const leaseSeconds = Number(params![2]);
      const workerId = params![3];

      const now = new Date();
      const claimable = jobDb
        .filter((j) => j.queue_name === queueName && j.status === "pending" && new Date(j.run_at) <= now)
        .sort((a, b) => b.priority - a.priority || new Date(a.run_at).getTime() - new Date(b.run_at).getTime())
        .slice(0, limit);

      const updatedJobs = claimable.map((j) => {
        j.status = "active";
        j.locked_until = new Date(Date.now() + leaseSeconds * 1000).toISOString();
        j.locked_by = workerId;
        j.attempts += 1;
        j.updated_at = new Date().toISOString();
        return { ...j };
      });

      return { rows: updatedJobs };
    }

    // 5. UPDATE complete
    if (sql.includes("UPDATE job_queue SET status = 'completed'")) {
      const jobId = params![0];
      const job = jobDb.find((j) => j.id === jobId);
      if (job) {
        job.status = "completed";
        job.locked_until = null;
        job.locked_by = null;
        job.completed_at = new Date().toISOString();
        job.updated_at = new Date().toISOString();
        return { rows: [job] };
      }
      return { rows: [] };
    }

    // 6. SELECT for failure check
    if (sql.includes("SELECT attempts, max_attempts, job_type, queue_name, user_id FROM job_queue WHERE id = $1")) {
      const job = jobDb.find((j) => j.id === params![0]);
      return { rows: job ? [job] : [] };
    }

    // 7. UPDATE retry
    if (sql.includes("UPDATE job_queue SET status = 'pending', run_at = $2")) {
      const jobId = params![0];
      const nextRun = params![1];
      const lastError = params![2];
      const job = jobDb.find((j) => j.id === jobId);
      if (job) {
        job.status = "pending";
        job.run_at = nextRun;
        job.locked_until = null;
        job.locked_by = null;
        job.last_error = lastError;
        job.updated_at = new Date().toISOString();
        return { rows: [job] };
      }
      return { rows: [] };
    }

    // 8. UPDATE dead letter
    if (sql.includes("UPDATE job_queue SET status = 'failed'")) {
      const jobId = params![0];
      const lastError = params![1];
      const job = jobDb.find((j) => j.id === jobId);
      if (job) {
        job.status = "failed";
        job.locked_until = null;
        job.locked_by = null;
        job.last_error = lastError;
        job.updated_at = new Date().toISOString();
        return { rows: [job] };
      }
      return { rows: [] };
    }

    // 9. Recover stale jobs
    if (sql.includes("UPDATE job_queue") && sql.includes("locked_until < now()")) {
      const now = new Date();
      const stale = jobDb.filter((j) => j.status === "active" && j.locked_until && new Date(j.locked_until) < now);
      stale.forEach((j) => {
        j.status = "pending";
        j.locked_until = null;
        j.locked_by = null;
        j.updated_at = new Date().toISOString();
      });
      return { rows: stale };
    }

    // 10. Replay dead letter
    if (sql.includes("UPDATE job_queue") && sql.includes("WHERE status = 'failed'")) {
      let failed = jobDb.filter((j) => j.status === "failed");
      if (params && params.length > 0 && typeof params[0] === "string") {
        failed = failed.filter((j) => j.queue_name === params[0]);
      }
      failed.forEach((j) => {
        j.status = "pending";
        j.attempts = 0;
        j.run_at = new Date().toISOString();
        j.locked_until = null;
        j.locked_by = null;
        j.last_error = null;
        j.completed_at = null;
        j.updated_at = new Date().toISOString();
      });
      return { rows: failed };
    }

    // 11. Queue metrics
    if (sql.includes("COUNT(*) FILTER (WHERE status = 'pending')")) {
      const queueName = params![0];
      const filtered = jobDb.filter((j) => j.queue_name === queueName);
      return {
        rows: [
          {
            pending_count: filtered.filter((j) => j.status === "pending").length,
            active_count: filtered.filter((j) => j.status === "active").length,
            completed_count: filtered.filter((j) => j.status === "completed").length,
            failed_count: filtered.filter((j) => j.status === "failed").length,
            oldest_pending_run_at: filtered.find((j) => j.status === "pending")?.run_at || null,
          },
        ],
      };
    }

    return { rows: [] };
  };

  const queueService = new JobQueueService(mockDbQuery);

  await t.test("enqueues and claims priority jobs with lease locking", async () => {
    const q = "queue-priority";
    const job1 = await queueService.enqueue("reminder_dispatch", { taskId: "task-1" }, { queueName: q, priority: 1 });
    const job2 = await queueService.enqueue("reminder_dispatch", { taskId: "task-2" }, { queueName: q, priority: 10 });

    assert.strictEqual(job1.status, "pending");
    assert.strictEqual(job2.status, "pending");

    const claimed = await queueService.claimJobs(q, 2, 30, "worker-test-1");
    assert.strictEqual(claimed.length, 2);
    // Highest priority job claimed first
    assert.strictEqual(claimed[0].payload.taskId, "task-2");
    assert.strictEqual(claimed[0].status, "active");
    assert.strictEqual(claimed[0].lockedBy, "worker-test-1");
    assert.ok(claimed[0].lockedUntil !== null);

    // Complete job2
    await queueService.completeJob(claimed[0].id);
    const completedJob = jobDb.find((j) => j.id === claimed[0].id);
    assert.strictEqual(completedJob.status, "completed");
    assert.strictEqual(completedJob.locked_until, null);
  });

  await t.test("deduplicates with singleton keys and idempotency keys", async () => {
    const q = "queue-dedup";
    // Singleton key test: prevents duplicate pending/active jobs
    const jobA = await queueService.enqueue(
      "calendar_sync",
      { accountId: "acc-1" },
      { queueName: q, singletonKey: "sync:acc-1" }
    );
    const jobB = await queueService.enqueue(
      "calendar_sync",
      { accountId: "acc-1" },
      { queueName: q, singletonKey: "sync:acc-1" }
    );
    assert.strictEqual(jobA.id, jobB.id);

    // Idempotency key test
    const jobX = await queueService.enqueue(
      "daily_briefing",
      { date: "2026-08-26" },
      { queueName: q, idempotencyKey: "briefing:user-1:2026-08-26" }
    );
    const jobY = await queueService.enqueue(
      "daily_briefing",
      { date: "2026-08-26" },
      { queueName: q, idempotencyKey: "briefing:user-1:2026-08-26" }
    );
    assert.strictEqual(jobX.id, jobY.id);
  });

  await t.test("retries transient failures with backoff and moves to dead letter after max attempts", async () => {
    const q = "queue-retry";
    const job = await queueService.enqueue("webhook_notify", { data: 123 }, { queueName: q, maxAttempts: 2 });
    const claimed = await queueService.claimJobs(q, 1, 30, "worker-1");
    assert.strictEqual(claimed.length, 1);
    const targetJob = claimed[0];

    // First failure: retried with immediate re-eligibility in test
    const fail1 = await queueService.failJob(targetJob.id, "Connection timeout", { retryDelaySeconds: 0 });
    assert.strictEqual(fail1.status, "retried");
    assert.ok(fail1.nextRunAt !== undefined);

    // Second failure: attempts reached maxAttempts (2) -> dead-lettered
    const claimed2 = await queueService.claimJobs(q, 1, 30, "worker-1");
    assert.strictEqual(claimed2.length, 1);
    const fail2 = await queueService.failJob(claimed2[0].id, "Persistent 500 internal server error");
    assert.strictEqual(fail2.status, "dead_lettered");

    const failedRecord = jobDb.find((j) => j.id === targetJob.id);
    assert.strictEqual(failedRecord.status, "failed");
    assert.strictEqual(failedRecord.last_error, "Persistent 500 internal server error");
  });

  await t.test("recovers stale jobs after worker crash and replays dead-lettered jobs", async () => {
    const q = "queue-recovery";
    // 1. Simulate worker crash: active job with expired lock
    const staleJob = {
      id: "job-stale-1",
      queue_name: q,
      job_type: "study_reminder",
      user_id: "user-1",
      payload: {},
      priority: 0,
      max_attempts: 3,
      run_at: new Date(Date.now() - 3600000).toISOString(),
      idempotency_key: null,
      singleton_key: null,
      status: "active",
      attempts: 1,
      locked_until: new Date(Date.now() - 1000).toISOString(), // expired lease
      locked_by: "crashed-worker",
      last_error: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      completed_at: null,
    };
    jobDb.push(staleJob);

    const recoveredCount = await queueService.recoverStaleJobs(q);
    assert.strictEqual(recoveredCount, 1);
    assert.strictEqual(staleJob.status, "pending");
    assert.strictEqual(staleJob.locked_until, null);

    // Fail the job to put it into failed state for replay test
    staleJob.status = "failed";

    // 2. Dead-letter replay
    const replayedCount = await queueService.replayDeadLetterJobs({ queueName: q });
    assert.strictEqual(replayedCount, 1);
    assert.strictEqual(staleJob.status, "pending");
    assert.strictEqual(staleJob.attempts, 0);

    const metrics = await queueService.getQueueMetrics(q);
    assert.strictEqual(metrics.pendingCount, 1);
    assert.strictEqual(metrics.failedCount, 0);
  });
});
