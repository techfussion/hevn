import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ConversationOrchestrator } from "../src/orchestrator/ConversationOrchestrator";
import { GemmaClient, GemmaResponse, ToolResult } from "../src/core/gemma/GemmaClient";
import { TaskService } from "../src/core/tasks/TaskService";
import { UserService } from "../src/core/tasks/UserService";
import { InsightsService } from "../src/core/insights/InsightsService";
import { FollowUpService } from "../src/core/followup/FollowUpService";
import { RecurringTaskService } from "../src/core/recurring/RecurringTaskService";
import { MemoryService } from "../src/core/memory/MemoryService";
import { ProjectService } from "../src/core/projects/ProjectService";
import type { User, Task, FollowUp } from "../src/types/domain";

describe("P1 Proactive Commitment & E2E Follow-Through Journey", () => {
  const mockUser: User = {
    id: "00000000-0000-0000-0000-000000000001",
    platform: "telegram",
    platformUserId: "123456",
    displayName: "Alex",
    timezone: "UTC",
    onboarded: true,
    onboardingState: "COMPLETED",
    assistantName: "Scott",
    botPersona: "Scott",
    persona: "student",
    preferredCheckinTime: "06:00",
    preferredCheckinHour: 6,
    plan: "free",
    followupPreference: "active",
    quietHoursStart: "22:00",
    quietHoursEnd: "07:00",
    createdAt: new Date().toISOString(),
  };

  it("Step 1: Detects implicit milestone commitment, creates commitment, and suggests preparation without unauthorized task creation", async () => {
    let createdCommitment = false;

    const mockTask: Task = {
      id: "commitment-123",
      userId: mockUser.id,
      title: "Database Exam",
      dueAt: "2026-08-27T14:00:00.000Z",
      priority: "high",
      status: "pending",
      taskType: "commitment",
      isSystemGenerated: false,
      parentTaskId: null,
      projectId: null,
      reminderOffsetMinutes: null,
      reminderSentAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const mockGemma = {
      converse: async (): Promise<GemmaResponse> => ({
        text: null,
        toolCalls: [
          {
            name: "create_task",
            args: {
              title: "Database Exam",
              due_at_iso: "2026-08-27T14:00:00.000Z",
              priority: "high",
              task_type: "commitment",
            },
          },
        ],
        rawContent: { role: "model", parts: [] },
      }),
      continueWithToolResults: async (
        _prompt: string,
        _history: unknown[],
        _msg: string,
        _content: unknown,
        toolResults: ToolResult[]
      ): Promise<GemmaResponse> => {
        assert.equal(toolResults[0].name, "create_task");
        return {
          text: "I saved the Database exam milestone. Now I will suggest a preparation reminder.\nREPLY: Got it! I've noted your Database exam on Thursday. Would you like me to remind you Tuesday to start preparing?",
          toolCalls: [],
          rawContent: null,
        };
      },
    } as unknown as GemmaClient;

    const mockTaskService = {
      createTask: async (
        _userId: string,
        input: { title: string; dueAtIso: string; taskType?: string }
      ): Promise<Task> => {
        assert.equal(input.title, "Database Exam");
        assert.equal(input.taskType, "commitment");
        createdCommitment = true;
        return mockTask;
      },
    } as unknown as TaskService;

    const mockFollowUpService = {
      getLatestPendingFollowUp: async () => null,
    } as unknown as FollowUpService;

    const mockMemoryService = {
      getMemories: async () => [],
    } as unknown as MemoryService;

    const orchestrator = new ConversationOrchestrator(
      mockGemma,
      mockTaskService,
      {} as UserService,
      {} as InsightsService,
      mockFollowUpService,
      {} as RecurringTaskService,
      mockMemoryService,
      {} as ProjectService
    );

    (orchestrator as unknown as { getRecentHistory: () => Promise<[]> }).getRecentHistory = async () => [];
    (orchestrator as unknown as { persistTurn: () => Promise<void> }).persistTurn = async () => {};

    const reply = await orchestrator.handleMessage(mockUser, "I have a Database exam Thursday.");
    assert.equal(createdCommitment, true);
    assert.ok(reply.includes("Database exam on Thursday"));
    assert.ok(reply.includes("Would you like me to remind you Tuesday to start preparing?"));
  });

  it("Step 2: User confirms 'Yes', creating linked preparation task with parent_task_id", async () => {
    let createdPrepTask = false;

    const prepTask: Task = {
      id: "prep-task-456",
      userId: mockUser.id,
      title: "Start preparing for Database exam",
      dueAt: "2026-08-25T18:00:00.000Z",
      priority: "high",
      status: "pending",
      taskType: "task",
      isSystemGenerated: false,
      parentTaskId: "commitment-123",
      projectId: null,
      reminderOffsetMinutes: 60,
      reminderSentAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const mockGemma = {
      converse: async (): Promise<GemmaResponse> => ({
        text: null,
        toolCalls: [
          {
            name: "create_task",
            args: {
              title: "Start preparing for Database exam",
              due_at_iso: "2026-08-25T18:00:00.000Z",
              priority: "high",
              task_type: "task",
              parent_task_id: "commitment-123",
              reminder_offset_minutes: 60,
            },
          },
        ],
        rawContent: { role: "model", parts: [] },
      }),
      continueWithToolResults: async (): Promise<GemmaResponse> => ({
        text: "Preparation reminder scheduled.\nREPLY: Perfect! I'll remind you Tuesday at 6:00 PM to start preparing for your Database exam.",
        toolCalls: [],
        rawContent: null,
      }),
    } as unknown as GemmaClient;

    const mockTaskService = {
      createTask: async (_userId: string, input: { parentTaskId?: string }): Promise<Task> => {
        assert.equal(input.parentTaskId, "commitment-123");
        createdPrepTask = true;
        return prepTask;
      },
    } as unknown as TaskService;

    const mockFollowUpService = {
      getLatestPendingFollowUp: async () => null,
    } as unknown as FollowUpService;

    const mockMemoryService = {
      getMemories: async () => [],
    } as unknown as MemoryService;

    const orchestrator = new ConversationOrchestrator(
      mockGemma,
      mockTaskService,
      {} as UserService,
      {} as InsightsService,
      mockFollowUpService,
      {} as RecurringTaskService,
      mockMemoryService,
      {} as ProjectService
    );

    (orchestrator as unknown as { getRecentHistory: () => Promise<[]> }).getRecentHistory = async () => [];
    (orchestrator as unknown as { persistTurn: () => Promise<void> }).persistTurn = async () => {};

    const reply = await orchestrator.handleMessage(mockUser, "Yes please");
    assert.equal(createdPrepTask, true);
    assert.ok(reply.includes("I'll remind you Tuesday at 6:00 PM"));
  });

  it("Step 3: User responds 'Not yet' to active follow-up, triggering contextual status update", async () => {
    let respondedFollowup = false;

    const activeFollowUp: FollowUp = {
      id: "followup-789",
      userId: mockUser.id,
      taskId: "prep-task-456",
      scheduledAt: "2026-08-25T19:00:00.000Z",
      status: "WAITING_FOR_RESPONSE",
      attemptCount: 1,
      maxAttempts: 3,
      lastAttemptAt: new Date().toISOString(),
      deliveredAt: new Date().toISOString(),
      completedAt: null,
      cancelledAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const task: Task = {
      id: "prep-task-456",
      userId: mockUser.id,
      title: "Start preparing for Database exam",
      dueAt: "2026-08-25T18:00:00.000Z",
      priority: "high",
      status: "pending",
      taskType: "task",
      isSystemGenerated: false,
      parentTaskId: "commitment-123",
      projectId: null,
      reminderOffsetMinutes: 60,
      reminderSentAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const mockGemma = {
      converse: async (prompt: string): Promise<GemmaResponse> => {
        // Assert that prompt contains active pending follow-up context
        assert.ok(prompt.includes("ACTIVE PENDING FOLLOW-UP"));
        assert.ok(prompt.includes("followup-789"));
        return {
          text: null,
          toolCalls: [
            {
              name: "respond_followup",
              args: {
                followup_id: "followup-789",
                intent: "not_yet",
              },
            },
          ],
          rawContent: { role: "model", parts: [] },
        };
      },
      continueWithToolResults: async (): Promise<GemmaResponse> => ({
        text: "Follow-up marked not yet.\nREPLY: No worries at all! When should I check back with you?",
        toolCalls: [],
        rawContent: null,
      }),
    } as unknown as GemmaClient;

    const mockFollowUpService = {
      getLatestPendingFollowUp: async () => activeFollowUp,
      handleFollowUpResponse: async (
        _uId: string,
        fId: string,
        intent: string
      ): Promise<{ success: boolean; followUp: FollowUp; message: string }> => {
        assert.equal(fId, "followup-789");
        assert.equal(intent, "not_yet");
        respondedFollowup = true;
        return { success: true, followUp: { ...activeFollowUp, status: "NOT_YET" }, message: "Recorded" };
      },
    } as unknown as FollowUpService;

    const mockTaskService = {
      getTask: async () => task,
    } as unknown as TaskService;

    const mockMemoryService = {
      getMemories: async () => [],
    } as unknown as MemoryService;

    const orchestrator = new ConversationOrchestrator(
      mockGemma,
      mockTaskService,
      {} as UserService,
      {} as InsightsService,
      mockFollowUpService,
      {} as RecurringTaskService,
      mockMemoryService,
      {} as ProjectService
    );

    (orchestrator as unknown as { getRecentHistory: () => Promise<[]> }).getRecentHistory = async () => [];
    (orchestrator as unknown as { persistTurn: () => Promise<void> }).persistTurn = async () => {};

    const reply = await orchestrator.handleMessage(mockUser, "Not yet");
    assert.equal(respondedFollowup, true);
    assert.ok(reply.includes("When should I check back with you?"));
  });

  it("Step 4: User says 'Done', marking task completed and closing the loop", async () => {
    let completedFollowup = false;

    const activeFollowUp: FollowUp = {
      id: "followup-789",
      userId: mockUser.id,
      taskId: "prep-task-456",
      scheduledAt: "2026-08-26T19:00:00.000Z",
      status: "WAITING_FOR_RESPONSE",
      attemptCount: 1,
      maxAttempts: 3,
      lastAttemptAt: new Date().toISOString(),
      deliveredAt: new Date().toISOString(),
      completedAt: null,
      cancelledAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const task: Task = {
      id: "prep-task-456",
      userId: mockUser.id,
      title: "Start preparing for Database exam",
      dueAt: "2026-08-25T18:00:00.000Z",
      priority: "high",
      status: "pending",
      taskType: "task",
      isSystemGenerated: false,
      parentTaskId: "commitment-123",
      projectId: null,
      reminderOffsetMinutes: 60,
      reminderSentAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const mockGemma = {
      converse: async (): Promise<GemmaResponse> => ({
        text: null,
        toolCalls: [
          {
            name: "respond_followup",
            args: {
              followup_id: "followup-789",
              intent: "completed",
            },
          },
        ],
        rawContent: { role: "model", parts: [] },
      }),
      continueWithToolResults: async (): Promise<GemmaResponse> => ({
        text: "Task completed.\nREPLY: Great job! I've marked your Database exam preparation as complete. Good luck on Thursday!",
        toolCalls: [],
        rawContent: null,
      }),
    } as unknown as GemmaClient;

    const mockFollowUpService = {
      getLatestPendingFollowUp: async () => activeFollowUp,
      handleFollowUpResponse: async (
        _uId: string,
        fId: string,
        intent: string
      ): Promise<{ success: boolean; followUp: FollowUp; message: string }> => {
        assert.equal(fId, "followup-789");
        assert.equal(intent, "completed");
        completedFollowup = true;
        return { success: true, followUp: { ...activeFollowUp, status: "COMPLETED" }, message: "Task completed" };
      },
    } as unknown as FollowUpService;

    const mockTaskService = {
      getTask: async () => task,
    } as unknown as TaskService;

    const mockMemoryService = {
      getMemories: async () => [],
    } as unknown as MemoryService;

    const orchestrator = new ConversationOrchestrator(
      mockGemma,
      mockTaskService,
      {} as UserService,
      {} as InsightsService,
      mockFollowUpService,
      {} as RecurringTaskService,
      mockMemoryService,
      {} as ProjectService
    );

    (orchestrator as unknown as { getRecentHistory: () => Promise<[]> }).getRecentHistory = async () => [];
    (orchestrator as unknown as { persistTurn: () => Promise<void> }).persistTurn = async () => {};

    const reply = await orchestrator.handleMessage(mockUser, "Yes, I did it!");
    assert.equal(completedFollowup, true);
    assert.ok(reply.includes("Great job!"));
    assert.ok(reply.includes("complete"));
  });
});
