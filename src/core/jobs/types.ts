import type { Job } from "../../types/domain";

export interface QueueMetrics {
  queueName: string;
  pendingCount: number;
  activeCount: number;
  completedCount: number;
  failedCount: number;
  oldestPendingRunAt: string | null;
}

export interface JobTelemetryEvent {
  eventType:
    | "job.enqueued"
    | "job.claimed"
    | "job.completed"
    | "job.failed"
    | "job.retried"
    | "job.dead_lettered"
    | "job.stale_recovered"
    | "job.dead_letter_replayed";
  jobId?: string;
  jobType?: string;
  queueName?: string;
  userId?: string | null;
  attempts?: number;
  durationMs?: number;
  error?: string;
}

export type JobHandler<T = unknown> = (job: Job<T>) => Promise<void>;
