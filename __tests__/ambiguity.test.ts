import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ConversationOrchestrator } from "../src/orchestrator/ConversationOrchestrator";
import { TaskService } from "../src/core/tasks/TaskService";
import { UserService } from "../src/core/tasks/UserService";
import { InsightsService } from "../src/core/insights/InsightsService";
import { FollowUpService } from "../src/core/followup/FollowUpService";
import type { User, GemmaResponse, FollowUp, Task } from "../src/types/domain";

describe("Multi-Follow-up Ambiguity Handling", () => {
  const taskService = new TaskService();
  const userService = new UserService();
  const insightsService = new InsightsService();
  const userId = "00000000-0000-0000-0000-000000000001";

  const dummyUser: User = {
    id: userId,
    platform: "telegram",
    platformUserId: "tg_12345",
    displayName: "Alexander",
    timezone: "America/New_York",
    onboarded: true,
    onboardingState: "COMPLETED",
    assistantName: "Hevn",
    botPersona: "Hevn",
    persona: "executive_assistant",
    preferredCheckinTime: "08:00",
    preferredCheckinHour: 8,
    plan: "free",
    followupPreference: "active",
    quietHoursStart: "22:00",
    quietHoursEnd: "07:00",
    createdAt: new Date().toISOString(),
  };

  it("clarifies instead of guessing when multiple candidate follow-ups are active and response is bare 'Done'", async () => {
    const followUpService = new FollowUpService();

    const candidate1: { followUp: FollowUp; task: Task } = {
      followUp: {
        id: "fu-1",
        userId,
        taskId: "t-1",
        scheduledAt: new Date().toISOString(),
        status: "WAITING_FOR_RESPONSE",
        attemptCount: 1,
        maxAttempts: 3,
        lastAttemptAt: new Date().toISOString(),
        deliveredAt: new Date().toISOString(),
        completedAt: null,
        cancelledAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      task: {
        id: "t-1",
        userId,
        title: "Send proposal to Acme",
        dueAt: new Date().toISOString(),
        priority: "high",
        status: "pending",
        taskType: "task",
        isSystemGenerated: false,
        parentTaskId: null,
        projectId: null,
        reminderOffsetMinutes: 30,
        reminderSentAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    };

    const candidate2: { followUp: FollowUp; task: Task } = {
      followUp: {
        id: "fu-2",
        userId,
        taskId: "t-2",
        scheduledAt: new Date().toISOString(),
        status: "WAITING_FOR_RESPONSE",
        attemptCount: 1,
        maxAttempts: 3,
        lastAttemptAt: new Date().toISOString(),
        deliveredAt: new Date().toISOString(),
        completedAt: null,
        cancelledAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      task: {
        id: "t-2",
        userId,
        title: "Review vendor contract",
        dueAt: new Date().toISOString(),
        priority: "medium",
        status: "pending",
        taskType: "task",
        isSystemGenerated: false,
        parentTaskId: null,
        projectId: null,
        reminderOffsetMinutes: 30,
        reminderSentAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    };

    (followUpService as unknown as Record<string, unknown>).getActiveCandidateFollowUps = async (
      _uid: string
    ) => {
      return [candidate1, candidate2];
    };

    const mockGemma = {
      converse: async () => {
        throw new Error("Should not call LLM when ambiguous bare response needs deterministic clarification");
      },
      continueWithToolResults: async () => {
        throw new Error("Should not continue");
      },
    };

    const orchestrator = new ConversationOrchestrator(
      mockGemma as any,
      taskService,
      userService,
      insightsService
    );
    (orchestrator as unknown as Record<string, unknown>).followUpService = followUpService;
    (orchestrator as unknown as Record<string, unknown>).getRecentHistory = async () => [];
    (orchestrator as unknown as Record<string, unknown>).persistTurn = async () => {};

    // User sends ambiguous "Done"
    const reply = await orchestrator.handleMessage(dummyUser, "Done", "test-corr-1");

    assert.ok(reply.includes("open follow-ups"), `Expected clarification message, got: ${reply}`);
    assert.ok(reply.includes("Send proposal to Acme"));
    assert.ok(reply.includes("Review vendor contract"));
  });

  it("accurately resolves candidate without clarifying when user specifically mentions task title", async () => {
    const followUpService = new FollowUpService();

    const candidate1: { followUp: FollowUp; task: Task } = {
      followUp: {
        id: "fu-1",
        userId,
        taskId: "t-1",
        scheduledAt: new Date().toISOString(),
        status: "WAITING_FOR_RESPONSE",
        attemptCount: 1,
        maxAttempts: 3,
        lastAttemptAt: new Date().toISOString(),
        deliveredAt: new Date().toISOString(),
        completedAt: null,
        cancelledAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      task: {
        id: "t-1",
        userId,
        title: "Send proposal to Acme",
        dueAt: new Date().toISOString(),
        priority: "high",
        status: "pending",
        taskType: "task",
        isSystemGenerated: false,
        parentTaskId: null,
        projectId: null,
        reminderOffsetMinutes: 30,
        reminderSentAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    };

    const candidate2: { followUp: FollowUp; task: Task } = {
      followUp: {
        id: "fu-2",
        userId,
        taskId: "t-2",
        scheduledAt: new Date().toISOString(),
        status: "WAITING_FOR_RESPONSE",
        attemptCount: 1,
        maxAttempts: 3,
        lastAttemptAt: new Date().toISOString(),
        deliveredAt: new Date().toISOString(),
        completedAt: null,
        cancelledAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      task: {
        id: "t-2",
        userId,
        title: "Review vendor contract",
        dueAt: new Date().toISOString(),
        priority: "medium",
        status: "pending",
        taskType: "task",
        isSystemGenerated: false,
        parentTaskId: null,
        projectId: null,
        reminderOffsetMinutes: 30,
        reminderSentAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    };

    (followUpService as unknown as Record<string, unknown>).getActiveCandidateFollowUps = async (
      _uid: string
    ) => {
      return [candidate1, candidate2];
    };

    (followUpService as unknown as Record<string, unknown>).handleFollowUpResponse = async (
      _uid: string,
      _fId: string,
      _intent: string
    ) => {
      return { success: true, followUp: candidate1.followUp, message: "Marked as completed" };
    };

    let systemPromptSeen = "";
    const mockGemma = {
      converse: async (systemPrompt: string) => {
        systemPromptSeen = systemPrompt;
        return {
          reply: "Got it, marked the proposal as done!",
          toolCalls: [
            {
              id: "call_1",
              name: "respond_followup",
              args: { followup_id: "fu-1", intent: "completed" },
            },
          ],
          rawContent: { parts: [] },
        } as unknown as GemmaResponse;
      },
      continueWithToolResults: async () => {
        return {
          text: "REPLY: I've marked the proposal as completed!",
          reply: "I've marked the proposal as completed!",
          toolCalls: [],
          rawContent: null,
        } as unknown as GemmaResponse;
      },
    };

    const orchestrator = new ConversationOrchestrator(
      mockGemma as any,
      taskService,
      userService,
      insightsService
    );
    (orchestrator as unknown as Record<string, unknown>).followUpService = followUpService;
    (orchestrator as unknown as Record<string, unknown>).getRecentHistory = async () => [];
    (orchestrator as unknown as Record<string, unknown>).persistTurn = async () => {};

    const reply = await orchestrator.handleMessage(
      dummyUser,
      "I finished sending the proposal to Acme",
      "test-corr-2"
    );

    assert.ok(reply.includes("completed"));
    assert.ok(systemPromptSeen.includes("fu-1"));
  });
});
