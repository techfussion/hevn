import test from "node:test";
import assert from "node:assert/strict";
import { JobQueueService } from "../src/core/jobs/JobQueueService";
import { NotificationDeduplicationService } from "../src/core/notifications/NotificationDeduplicationService";
import { NotificationPolicyService } from "../src/core/notifications/NotificationPolicyService";
import { CircuitBreaker } from "../src/core/voice/CircuitBreaker";
import { AudioSynthesisService } from "../src/core/voice/AudioSynthesisService";
import { ResponsePolicyService } from "../src/core/voice/ResponsePolicyService";
import { RiskEngineService } from "../src/core/briefing/RiskEngineService";
import { BriefingService } from "../src/core/briefing/BriefingService";
import type { AudioSynthesisProvider, SynthesizedAudio } from "../src/core/voice/types";
import type { MessagingAdapter, OutboundMessage } from "../src/adapters/MessagingAdapter";
import type { TaskService } from "../src/core/tasks/TaskService";
import type { CalendarService } from "../src/core/calendar/CalendarService";
import type { User, Job } from "../types/domain";

test("HEVN AI P2.5 End-to-End Scenarios — Production Reliability, Resilience & Cross-Domain Orchestration", async (t) => {
  await t.test("Scenario 1: Durable Job Queue prioritizes urgent jobs, deduplicates with singletons, and tracks metrics", async () => {
    const memoryJobs: any[] = [];
    let jobSeq = 0;

    const mockDbQuery = async (rawSql: string, params?: any[]): Promise<{ rows: any[] }> => {
      const sql = rawSql.replace(/\s+/g, " ");

      if (sql.includes("FROM job_queue") && sql.includes("singleton_key = $2")) {
        const qName = params![0];
        const sKey = params![1];
        const match = memoryJobs.find(
          (j) => j.queue_name === qName && j.singleton_key === sKey && ["pending", "active"].includes(j.status)
        );
        return { rows: match ? [match] : [] };
      }

      if (sql.includes("INSERT INTO job_queue")) {
        const queueName = params![0];
        const jobType = params![1];
        const userId = params![2];
        const payload = JSON.parse(params![3]);
        const priority = Number(params![4]);
        const maxAttempts = Number(params![5]);
        const runAt = params![6];
        const idempKey = params![7];
        const singletonKey = params![8];

        if (singletonKey && memoryJobs.some((j) => j.singleton_key === singletonKey && ["pending", "active"].includes(j.status))) {
          return { rows: [] };
        }

        jobSeq++;
        const newJob = {
          id: `e2e-job-${jobSeq}`,
          queue_name: queueName,
          job_type: jobType,
          user_id: userId,
          payload,
          status: "pending",
          priority,
          attempts: 0,
          max_attempts: maxAttempts,
          run_at: runAt,
          idempotency_key: idempKey,
          singleton_key: singletonKey,
          locked_until: null,
          locked_by: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        memoryJobs.push(newJob);
        return { rows: [newJob] };
      }

      if (sql.includes("WITH claimable AS") || (sql.includes("UPDATE job_queue") && sql.includes("status = 'active'"))) {
        const qName = params![0];
        const limit = params![1];
        const lockSec = params![2];
        const lockBy = params![3];

        const claimable = memoryJobs
          .filter((j) => j.queue_name === qName && j.status === "pending")
          .sort((a, b) => b.priority - a.priority)
          .slice(0, limit);

        claimable.forEach((j) => {
          j.status = "active";
          j.attempts += 1;
          j.locked_until = new Date(Date.now() + lockSec * 1000).toISOString();
          j.locked_by = lockBy;
        });

        return { rows: claimable };
      }

      if (sql.includes("UPDATE job_queue SET status = 'completed'")) {
        const jobId = params![0];
        const match = memoryJobs.find((j) => j.id === jobId);
        if (match) {
          match.status = "completed";
          match.completed_at = new Date().toISOString();
        }
        return { rows: match ? [match] : [] };
      }

      if (sql.includes("AS pending_count") || sql.includes("COUNT(*) FILTER")) {
        const qName = params![0];
        const inQueue = memoryJobs.filter((j) => j.queue_name === qName);
        return {
          rows: [
            {
              pending_count: inQueue.filter((j) => j.status === "pending").length,
              active_count: inQueue.filter((j) => j.status === "active").length,
              completed_count: inQueue.filter((j) => j.status === "completed").length,
              failed_count: inQueue.filter((j) => j.status === "failed").length,
              oldest_pending_run_at: null,
            },
          ],
        };
      }

      return { rows: [] };
    };

    const queue = new JobQueueService(mockDbQuery);

    // Enqueue lower priority reminder
    await queue.enqueueJob("e2e", "reminder_dispatch", { taskId: "t-low" }, { priority: 1 });
    // Enqueue higher priority urgent notification
    await queue.enqueueJob("e2e", "reminder_dispatch", { taskId: "t-urgent" }, { priority: 100 });
    // Attempt duplicate singleton enqueue
    const dupResult = await queue.enqueueJob("e2e", "reminder_dispatch", { taskId: "t-urgent" }, { priority: 100, singletonKey: "rem:t-urgent" });
    assert.strictEqual(dupResult.enqueued, true);
    const dupResult2 = await queue.enqueueJob("e2e", "reminder_dispatch", { taskId: "t-urgent" }, { priority: 100, singletonKey: "rem:t-urgent" });
    assert.strictEqual(dupResult2.enqueued, false); // singleton suppressed

    // Claim 1 job -> MUST claim highest priority first
    const claimed = await queue.claimJobs("e2e", 1, 30);
    assert.strictEqual(claimed.length, 1);
    assert.strictEqual(claimed[0].payload.taskId, "t-urgent");
    assert.strictEqual(claimed[0].priority, 100);

    // Complete job
    await queue.completeJob(claimed[0].id);

    const metrics = await queue.getQueueMetrics("e2e");
    assert.strictEqual(metrics.completedCount, 1);
  });

  await t.test("Scenario 2: Multi-Provider TTS Failover with Circuit Breaker handles outages gracefully", async () => {
    let provider1Hits = 0;
    let provider2Hits = 0;

    const provider1: AudioSynthesisProvider = {
      providerName: "flaky-tts-1",
      async synthesize(): Promise<SynthesizedAudio> {
        provider1Hits++;
        throw new Error("HTTP 502 Bad Gateway");
      },
    };

    const provider2: AudioSynthesisProvider = {
      providerName: "backup-tts-2",
      async synthesize(): Promise<SynthesizedAudio> {
        provider2Hits++;
        return {
          buffer: Buffer.from("audio-bytes"),
          mimeType: "audio/ogg",
          durationSeconds: 2.0,
          provider: "backup-tts-2",
        };
      },
    };

    const synthesisService = new AudioSynthesisService([provider1, provider2]);
    const responsePolicy = new ResponsePolicyService(synthesisService);

    const deliveredMessages: OutboundMessage[] = [];
    const mockAdapter: MessagingAdapter = {
      platform: "telegram",
      capabilities: { textInput: true, audioInput: true, textOutput: true, audioOutput: true, interactiveButtons: true },
      async sendMessage(m: OutboundMessage) {
        deliveredMessages.push(m);
      },
    };

    const user: User = {
      id: "u-alex",
      platform: "telegram",
      platformUserId: "tg-100",
      displayName: "Alex",
      timezone: "America/New_York",
      onboarded: true,
      onboardingState: "COMPLETED",
      assistantName: "Hevn",
      botPersona: "Hevn",
      persona: "student",
      preferredCheckinTime: "08:00",
      preferredCheckinHour: 8,
      plan: "free",
      followupPreference: "active",
      quietHoursStart: null,
      quietHoursEnd: null,
      responseMode: "voice",
      voiceEnabled: true,
      voiceName: null,
      voiceLanguage: "en",
      createdAt: new Date().toISOString(),
    };

    // First call: provider 1 fails -> fails over to provider 2 -> succeeds
    const res = await synthesisService.synthesize("Your study session starts in 10 minutes.", undefined, user.id);
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.audio?.provider, "backup-tts-2");
    assert.strictEqual(provider1Hits, 1);
    assert.strictEqual(provider2Hits, 1);

    // Provoke provider 1 failure threshold to trip circuit breaker OPEN
    await synthesisService.synthesize("Text 2", undefined, user.id);
    await synthesisService.synthesize("Text 3", undefined, user.id);

    const health = synthesisService.getProviderHealth();
    const p1Health = health.find((h) => h.providerName === "flaky-tts-1");
    assert.strictEqual(p1Health?.circuitState, "OPEN");
    assert.strictEqual(p1Health?.failureCount, 3);
  });

  await t.test("Scenario 3: Cross-Domain Secretary Briefing synthesizes tasks, study sessions and schedule risks", async () => {
    const riskEngine = new RiskEngineService();

    const mockTaskService = {
      async listTasks() {
        return [
          {
            id: "task-comm-1",
            userId: "u-sam",
            title: "Submit Ethics Paper",
            dueAt: "2026-08-26T17:00:00.000Z",
            status: "pending",
            taskType: "commitment",
            priority: "high",
          },
          {
            id: "task-overdue-1",
            userId: "u-sam",
            title: "Lab Safety Quiz",
            dueAt: "2026-08-25T12:00:00.000Z", // Overdue
            status: "pending",
            taskType: "task",
            priority: "medium",
          },
        ];
      },
    } as unknown as TaskService;

    const mockCalendarService = {
      async listUpcomingEvents() {
        return [
          {
            id: "cal-ev-1",
            summary: "Bioethics Seminar",
            startTime: "2026-08-26T14:00:00.000Z",
            endTime: "2026-08-26T15:30:00.000Z",
            isAllDay: false,
          },
        ];
      },
    } as unknown as CalendarService;

    const mockDbScope = async (userId: string, fn: any) => {
      const mockClient = {
        async query(sql: string) {
          if (sql.includes("FROM study_sessions")) {
            return {
              rows: [
                {
                  id: "study-1",
                  user_id: userId,
                  study_plan_id: "plan-1",
                  course_id: "c-bio",
                  topic_id: "top-1",
                  task_id: "t-study-1",
                  title: "Gene Editing Ethics",
                  scheduled_start: "2026-08-26T16:00:00.000Z",
                  scheduled_end: "2026-08-26T17:00:00.000Z",
                  planned_minutes: 60,
                  actual_minutes: null,
                  status: "scheduled",
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                },
              ],
            };
          }
          if (sql.includes("FROM follow_ups")) {
            return { rows: [] };
          }
          if (sql.includes("FROM projects")) {
            return { rows: [{ id: "proj-1", name: "Bioethics Term Paper", open_task_count: 2 }] };
          }
          return { rows: [] };
        },
      };
      return fn(mockClient);
    };

    const briefingService = new BriefingService(
      mockTaskService,
      undefined,
      mockCalendarService,
      undefined,
      undefined,
      riskEngine,
      mockDbScope as any
    );

    const briefing = await briefingService.getDailyBriefing("u-sam", "2026-08-26", "UTC");

    assert.strictEqual(briefing.date, "2026-08-26");
    assert.strictEqual(briefing.agenda.length, 3); // 1 calendar event + 1 study session + 1 commitment deadline
    assert.strictEqual(briefing.overdueTasks.length, 1);
    assert.strictEqual(briefing.overdueTasks[0].title, "Lab Safety Quiz");
    assert.ok(briefing.conversationalSummary.includes("Bioethics Seminar"));
    assert.ok(briefing.conversationalSummary.includes("Gene Editing Ethics"));
    assert.ok(briefing.conversationalSummary.includes("Submit Ethics Paper"));
  });
});
