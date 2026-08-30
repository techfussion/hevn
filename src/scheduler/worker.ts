/**
 * Background Scheduler & Queue Worker Process
 * Implements:
 * 1. PostgreSQL FOR UPDATE SKIP LOCKED Durable Job Queue consumption
 * 2. Database Capability Self-Check at startup (least-privilege role validation)
 * 3. Canonical Natural Response Composition (ResponseCopyService)
 * 4. Multi-Provider TTS Failover & Circuit Breaking
 * 5. Canonical Notification Policy & Anti-Nagging Gap checks
 * 6. Calendar Reconciliation sweeps
 */

import cron from "node-cron";
import { JobQueueService } from "../core/jobs/JobQueueService";
import { TaskService } from "../core/tasks/TaskService";
import { FollowUpService } from "../core/followup/FollowUpService";
import { RecurringTaskService } from "../core/recurring/RecurringTaskService";
import { NotificationDeduplicationService } from "../core/notifications/NotificationDeduplicationService";
import { NotificationPolicyService } from "../core/notifications/NotificationPolicyService";
import { ResponseCopyService } from "../core/notifications/ResponseCopyService";
import { CalendarService } from "../core/calendar/CalendarService";
import { CalendarReconciliationService } from "../core/calendar/CalendarReconciliationService";
import { BriefingService } from "../core/briefing/BriefingService";
import { AudioSynthesisService } from "../core/voice/AudioSynthesisService";
import { ResponsePolicyService } from "../core/voice/ResponsePolicyService";
import { ElevenLabsSynthesisProvider } from "../core/voice/providers/ElevenLabsSynthesisProvider";
import { GoogleCloudTtsProvider } from "../core/voice/providers/GoogleCloudTtsProvider";
import { DatabaseCapabilityChecker } from "../core/db/DatabaseCapabilityChecker";
import { getSchedulerPool } from "../db/pool";
import { getAdapter, initDefaultAdapters } from "../adapters/registry";
import { logger } from "../utils/logger";
import type { User, FollowUpPreference, Job } from "../types/domain";
import type { AudioSynthesisProvider } from "../core/voice/types";
import "./dailyCheckIns";

initDefaultAdapters();

const WORKER_CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || "5", 10);
const DEFAULT_LEASE_SECONDS = parseInt(process.env.DEFAULT_LEASE_SECONDS || "30", 10);

let isShuttingDown = false;
let activeJobsCount = 0;

// Initialize Core Services with Scheduler Pool
const jobQueue = new JobQueueService();
const taskService = new TaskService();
const followUpService = new FollowUpService();
const recurringService = new RecurringTaskService();
const dedupService = new NotificationDeduplicationService();
const policyService = new NotificationPolicyService(dedupService);
const copyService = new ResponseCopyService();
const calendarService = new CalendarService();
const calendarReconciliationService = new CalendarReconciliationService(calendarService);
const briefingService = new BriefingService(taskService, followUpService, calendarService);
const capabilityChecker = new DatabaseCapabilityChecker();

function createAudioSynthesisService(): AudioSynthesisService | undefined {
  const providers: AudioSynthesisProvider[] = [];
  if (process.env.ELEVENLABS_API_KEY) {
    providers.push(new ElevenLabsSynthesisProvider({ apiKey: process.env.ELEVENLABS_API_KEY }));
  }
  if (process.env.GOOGLE_TTS_API_KEY) {
    providers.push(new GoogleCloudTtsProvider({ apiKey: process.env.GOOGLE_TTS_API_KEY }));
  }
  if (providers.length === 0) return undefined;
  return new AudioSynthesisService(providers);
}

const audioSynthesisService = createAudioSynthesisService();
const responsePolicyService = new ResponsePolicyService(audioSynthesisService);

// -------------------------------------------------------------
// Job Handlers Dispatch Table
// -------------------------------------------------------------

async function handleReminderDispatch(job: Job): Promise<void> {
  const taskId = job.payload?.taskId as string;
  const userId = job.userId;
  if (!taskId || !userId) {
    throw new Error("Invalid reminder_dispatch job: missing taskId or userId");
  }

  const { rows } = await getSchedulerPool().query(
    `SELECT t.id, t.title, t.due_at, t.status, t.priority,
            u.id as u_id, u.platform, u.platform_user_id, u.timezone,
            u.quiet_hours_start, u.quiet_hours_end, u.response_mode,
            u.voice_enabled, u.voice_name, u.voice_language
     FROM tasks t
     JOIN users u ON u.id = t.user_id
     WHERE t.id = $1 AND t.user_id = $2`,
    [taskId, userId]
  );

  const row = rows[0];
  if (!row || row.status === "done") {
    logger.info({ taskId }, "Reminder cancelled: task is already completed or deleted");
    return;
  }

  const user: User = {
    id: row.u_id,
    platform: row.platform,
    platformUserId: row.platform_user_id,
    displayName: null,
    fullName: null,
    preferredName: null,
    username: null,
    namelessMode: false,
    timezone: row.timezone || "UTC",
    onboarded: true,
    onboardingState: "COMPLETED",
    assistantName: "Hevn",
    botPersona: "Hevn",
    persona: "professional",
    preferredCheckinTime: "06:00",
    preferredCheckinHour: 6,
    plan: "free",
    followupPreference: "active",
    quietHoursStart: row.quiet_hours_start,
    quietHoursEnd: row.quiet_hours_end,
    responseMode: row.response_mode || "auto",
    voiceEnabled: row.voice_enabled !== false,
    voiceName: row.voice_name || null,
    voiceLanguage: row.voice_language || null,
    createdAt: new Date().toISOString(),
  };

  const adapter = getAdapter(user.platform as "telegram" | "whatsapp");
  if (!adapter) {
    throw new Error(`No messaging adapter registered for platform: ${user.platform}`);
  }

  const dueTime = new Date(row.due_at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: user.timezone || "UTC",
  });

  const { text: messageText, voiceText } = copyService.composeTaskReminder(taskId, {
    taskTitle: row.title,
    dueTimeStr: dueTime,
    isUrgent: row.priority === "high",
  });

  // 1. Evaluate Notification Policy (quiet hours, rate limits)
  const decision = await policyService.evaluate(user, {
    id: taskId,
    category: "reminder",
    priority: row.priority || "medium",
    taskId,
    title: row.title,
    text: messageText,
    channelCapabilities: adapter.capabilities,
  });

  if (!decision.eligible) {
    if (decision.action === "defer" && decision.deferredUntil) {
      await jobQueue.enqueueJob(
        "default",
        "reminder_dispatch",
        job.payload,
        {
          userId,
          runAtIso: decision.deferredUntil,
          singletonKey: `reminder:${taskId}`,
        }
      );
    }
    return;
  }

  // 2. Atomic Deduplication Lock Claim
  const dedupKey = `reminder:${taskId}:${new Date(row.due_at).toISOString()}`;
  const claimed = await dedupService.claimNotification(userId, dedupKey, user.platform, "reminder");
  if (!claimed) {
    logger.info({ dedupKey, userId }, "Reminder delivery suppressed: duplicate already claimed");
    return;
  }

  // 3. Deliver Response
  await responsePolicyService.deliverResponse(
    adapter,
    user,
    {
      userId: user.platformUserId,
      text: decision.deliveryModality === "voice" ? voiceText : messageText,
    }
  );

  await dedupService.recordOutcome(userId, dedupKey, "delivered", messageText);
  await taskService.markReminderSent(taskId);
}

async function handleFollowUpDispatch(job: Job): Promise<void> {
  const followUpId = job.payload?.followUpId as string;
  const userId = job.userId;
  if (!followUpId || !userId) {
    throw new Error("Invalid followup_dispatch job: missing followUpId or userId");
  }

  const { rows } = await getSchedulerPool().query(
    `SELECT f.id, f.task_id, f.user_id, f.attempt_count, f.last_attempt_at, f.status as follow_up_status,
            t.title, t.status as task_status, t.priority,
            u.id as u_id, u.platform, u.platform_user_id, u.timezone,
            u.quiet_hours_start, u.quiet_hours_end, u.followup_preference,
            u.response_mode, u.voice_enabled, u.voice_name, u.voice_language
     FROM follow_ups f
     JOIN tasks t ON t.id = f.task_id
     JOIN users u ON u.id = f.user_id
     WHERE f.id = $1 AND f.user_id = $2`,
    [followUpId, userId]
  );

  const row = rows[0];
  if (!row || row.task_status === "done" || row.followup_preference === "off") {
    await followUpService.handleFollowUpResponse(userId, followUpId, "cancelled");
    return;
  }

  const user: User = {
    id: row.u_id,
    platform: row.platform,
    platformUserId: row.platform_user_id,
    displayName: null,
    fullName: null,
    preferredName: null,
    username: null,
    namelessMode: false,
    timezone: row.timezone || "UTC",
    onboarded: true,
    onboardingState: "COMPLETED",
    assistantName: "Hevn",
    botPersona: "Hevn",
    persona: "professional",
    preferredCheckinTime: "06:00",
    preferredCheckinHour: 6,
    plan: "free",
    followupPreference: (row.followup_preference as FollowUpPreference) || "active",
    quietHoursStart: row.quiet_hours_start,
    quietHoursEnd: row.quiet_hours_end,
    responseMode: row.response_mode || "auto",
    voiceEnabled: row.voice_enabled !== false,
    voiceName: row.voice_name || null,
    voiceLanguage: row.voice_language || null,
    createdAt: new Date().toISOString(),
  };

  const adapter = getAdapter(user.platform);
  if (!adapter) return;

  const dedupKey = `fu:${followUpId}:${row.attempt_count}`;
  const now = new Date();

  const attemptNum = Number(row.attempt_count ?? 1);
  const wasSnoozed = attemptNum > 0 && row.last_attempt_at !== null;

  const { text: messageText, voiceText } = copyService.composeFollowUp(followUpId, {
    taskTitle: row.title,
    attemptCount: attemptNum,
    wasSnoozed,
  });

  // Evaluate Notification Policy
  const decision = await policyService.evaluatePolicy(
    user,
    {
      id: followUpId,
      category: "follow_up",
      priority: row.priority || "medium",
      taskId: row.task_id,
      title: row.title,
      text: messageText,
      channelCapabilities: adapter.capabilities,
      incomingModality: "text",
    },
    now
  );

  if (!decision.eligible) {
    await dedupService.recordOutcome(userId, dedupKey, "deferred");
    return;
  }

  const reserved = await dedupService.reserveNotification(
    userId,
    dedupKey,
    user.platform,
    "follow_up",
    `Follow-up on ${row.title}`
  );

  if (!reserved) return;

  const buttons = [
    { label: "✅ Done", action: `fu:done:${followUpId}` },
    { label: "⏳ Snooze 1h", action: `fu:snooze:${followUpId}` },
    { label: "❌ Drop", action: `fu:drop:${followUpId}` },
  ];

  await responsePolicyService.deliverResponse(
    adapter,
    user,
    {
      userId: user.platformUserId,
      text: decision.deliveryModality === "voice" ? voiceText : messageText,
      buttons,
    }
  );

  await dedupService.recordOutcome(userId, dedupKey, "delivered", messageText);
  await followUpService.markDelivered(followUpId);
}

async function handleRecurringTaskAdvance(job: Job): Promise<void> {
  const recurringTaskId = job.payload?.recurringTaskId as string;
  if (!recurringTaskId) return;

  const { rows } = await getSchedulerPool().query(
    `SELECT * FROM recurring_tasks WHERE id = $1 AND status = 'active'`,
    [recurringTaskId]
  );
  const item = rows[0];
  if (!item) return;

  // Create task instance
  await taskService.createTask(item.user_id, {
    title: item.title,
    dueAtIso: new Date(item.next_run_at).toISOString(),
    priority: item.priority || "medium",
    taskType: "task",
    isSystemGenerated: true,
    reminderOffsetMinutes: 30,
  });

  // Advance schedule
  await recurringService.advanceOccurrence({
    id: item.id,
    userId: item.user_id,
    title: item.title,
    recurrencePattern: item.recurrence_pattern,
    daysOfWeek: item.days_of_week,
    timeOfDay: item.time_of_day,
    timezone: item.timezone,
    priority: item.priority,
    status: item.status,
    nextRunAt: new Date(item.next_run_at).toISOString(),
    lastRunAt: item.last_run_at ? new Date(item.last_run_at).toISOString() : null,
    createdAt: new Date(item.created_at).toISOString(),
    updatedAt: new Date(item.updated_at).toISOString(),
  });
}

async function handleCalendarReconciliation(job: Job): Promise<void> {
  const accountId = job.payload?.accountId as string;
  const userId = job.userId;
  if (!accountId || !userId) throw new Error("Missing accountId or userId in calendar_reconciliation job");

  const result = await calendarReconciliationService.reconcileAccount(accountId, userId);
  logger.info(
    {
      accountId,
      userId,
      syncedEvents: result.syncedEventsCount,
      conflicts: result.conflicts.length,
      reauthRequired: result.reauthRequired,
    },
    "Calendar reconciliation job completed"
  );
}

// -------------------------------------------------------------
// Main Worker Execution & Concurrency Loop
// -------------------------------------------------------------

async function processJob(job: Job): Promise<void> {
  try {
    switch (job.jobType) {
      case "reminder_dispatch":
        await handleReminderDispatch(job);
        break;
      case "followup_dispatch":
        await handleFollowUpDispatch(job);
        break;
      case "recurring_task_advance":
        await handleRecurringTaskAdvance(job);
        break;
      case "calendar_reconciliation":
        await handleCalendarReconciliation(job);
        break;
      case "daily_briefing":
        if (job.userId) {
          const briefing = await briefingService.generateDailyBriefing(job.userId);
          logger.info({ userId: job.userId, summaryLength: briefing.conversationalSummary.length }, "Generated scheduled daily briefing");
        }
        break;
      default:
        logger.warn({ jobType: job.jobType, jobId: job.id }, "Unknown job type — completing as no-op");
        break;
    }

    await jobQueue.completeJob(job.id);
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error({ err, jobId: job.id, jobType: job.jobType }, "Job execution failed");
    await jobQueue.failJob(job.id, errorMsg);
  }
}

async function pollAndProcessJobs(): Promise<void> {
  if (isShuttingDown) return;

  try {
    const availableSlots = WORKER_CONCURRENCY - activeJobsCount;
    if (availableSlots <= 0) return;

    // Claim jobs from queue with lease
    const jobs = await jobQueue.claimJobs("default", availableSlots, DEFAULT_LEASE_SECONDS, `worker-${process.pid}`);
    if (jobs.length === 0) return;

    activeJobsCount += jobs.length;
    const promises = jobs.map((job: Job) =>
      processJob(job).finally(() => {
        activeJobsCount = Math.max(0, activeJobsCount - 1);
      })
    );

    await Promise.allSettled(promises);
  } catch (err) {
    logger.error({ err }, "Worker polling iteration error");
  }
}

// -------------------------------------------------------------
// Ingestion: Scan & Enqueue Scheduled Domain Work into Durable Job Queue
// -------------------------------------------------------------

async function enqueueDueDomainWork(): Promise<void> {
  try {
    // 1. Enqueue due reminders
    const dueReminders = await taskService.getDueRemindersBatch(50);
    for (const task of dueReminders) {
      await jobQueue.enqueueJob(
        "default",
        "reminder_dispatch",
        { taskId: task.id },
        {
          userId: task.userId,
          priority: 10,
          singletonKey: `reminder:${task.id}`,
        }
      );
    }

    // 2. Enqueue due follow-ups
    const dueFollowUps = await followUpService.getDueFollowUpsBatch(50);
    for (const fu of dueFollowUps) {
      await jobQueue.enqueueJob(
        "default",
        "followup_dispatch",
        { followUpId: fu.id },
        {
          userId: fu.userId,
          priority: 5,
          singletonKey: `followup:${fu.id}`,
        }
      );
    }

    // 3. Enqueue due recurring tasks
    const dueRecurring = await recurringService.getDueRecurringTasksBatch(20);
    for (const rec of dueRecurring) {
      await jobQueue.enqueueJob(
        "default",
        "recurring_task_advance",
        { recurringId: rec.id },
        {
          userId: rec.userId,
          priority: 1,
          singletonKey: `recurring:${rec.id}:${rec.nextRunAt}`,
        }
      );
    }

    // 4. Enqueue active calendar accounts for sync reconciliation
    const { rows: calAccounts } = await getSchedulerPool().query(
      `SELECT id, user_id FROM calendar_accounts
       WHERE status = 'active'
         AND (last_sync_at IS NULL OR last_sync_at < now() - INTERVAL '15 minutes')
       LIMIT 10`
    );
    for (const acc of calAccounts) {
      await jobQueue.enqueueJob(
        "default",
        "calendar_reconciliation",
        { accountId: acc.id },
        {
          userId: acc.user_id,
          priority: 3,
          singletonKey: `calsync:${acc.id}`,
        }
      );
    }
  } catch (err) {
    logger.warn({ err }, "Periodic domain work scanner error");
  }
}

// -------------------------------------------------------------
// Startup & Capability Self-Check
// -------------------------------------------------------------

let pollInterval: NodeJS.Timeout | null = null;

async function startWorker() {
  try {
    // 1. Assert worker database capabilities
    await capabilityChecker.assertCapabilitiesOrHalt();

    // 2. Enqueue domain work every 30 seconds
    cron.schedule("*/30 * * * * *", enqueueDueDomainWork);

    // 3. Continuous job queue polling loop (every 2 seconds)
    pollInterval = setInterval(pollAndProcessJobs, 2000);

    // 4. Recover stale crashed worker leases every 60 seconds
    cron.schedule("*/60 * * * * *", async () => {
      try {
        await jobQueue.recoverStaleJobs("default");
      } catch (err) {
        logger.warn({ err }, "Stale job recovery run failed");
      }
    });

    logger.info(
      { concurrency: WORKER_CONCURRENCY, leaseSeconds: DEFAULT_LEASE_SECONDS },
      "Hevn P2.5.1 Durable Worker started (PostgreSQL SKIP LOCKED Job Queue, ResponseCopyService & DatabaseCapabilityChecker Active)"
    );
  } catch (err) {
    logger.fatal({ err }, "Worker failed to initialize — exiting");
    process.exit(1);
  }
}

// -------------------------------------------------------------
// Graceful Shutdown
// -------------------------------------------------------------

async function gracefulShutdown(signal: string) {
  logger.info({ signal }, "Received shutdown signal — initiating graceful worker shutdown");
  isShuttingDown = true;
  if (pollInterval) clearInterval(pollInterval);

  const shutdownTimeout = setTimeout(() => {
    logger.error("Graceful shutdown timeout exceeded — forcing exit");
    process.exit(1);
  }, 10000);

  while (activeJobsCount > 0) {
    logger.info({ activeJobsCount }, "Waiting for in-flight worker jobs to complete...");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  clearTimeout(shutdownTimeout);
  logger.info("All worker jobs finished cleanly — shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// Boot worker
startWorker();
