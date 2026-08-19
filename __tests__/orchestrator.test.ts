import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ConversationOrchestrator } from "../src/orchestrator/ConversationOrchestrator";
import { GemmaClient, GemmaResponse, ToolResult } from "../src/core/gemma/GemmaClient";
import { TaskService } from "../src/core/tasks/TaskService";
import { UserService } from "../src/core/tasks/UserService";
import { InsightsService } from "../src/core/insights/InsightsService";
import type { User, Task } from "../src/types/domain";

describe("ConversationOrchestrator Workflow", () => {
  const mockUser: User = {
    id: "00000000-0000-0000-0000-000000000001",
    platform: "telegram",
    platformUserId: "123456",
    displayName: "Test User",
    timezone: "UTC",
    onboarded: true,
    onboardingState: "COMPLETED",
    assistantName: "Scott",
    botPersona: "Scott",
    persona: "professional",
    preferredCheckinTime: "06:00",
    preferredCheckinHour: 6,
    plan: "free",
    createdAt: new Date().toISOString(),
  };

  it("routes un-onboarded user through OnboardingService directly", async () => {
    const unOnboardedUser: User = {
      ...mockUser,
      displayName: null,
      onboarded: false,
      onboardingState: "WELCOME",
    };

    let setOnboardingStateCalled = false;
    const mockUserService = {
      setOnboardingState: async () => {
        setOnboardingStateCalled = true;
      },
    } as unknown as UserService;

    const orchestrator = new ConversationOrchestrator(
      {} as GemmaClient,
      {} as TaskService,
      mockUserService,
      {} as InsightsService
    );

    (orchestrator as unknown as { persistTurn: () => Promise<void> }).persistTurn = async () => {};

    const reply = await orchestrator.handleMessage(unOnboardedUser, "Hi");
    assert.ok(reply.includes("Welcome to Hevn"));
    assert.ok(reply.includes("what should I call you?"));
    assert.equal(setOnboardingStateCalled, true);
  });

  it("handles simple conversational turn for onboarded user without tool calls", async () => {
    const mockGemma = {
      converse: async (): Promise<GemmaResponse> => ({
        text: "I should acknowledge warmly.\nREPLY: Hello! How can I help you organize your commitments today?",
        toolCalls: [],
        rawContent: null,
      }),
      continueWithToolResults: async (): Promise<GemmaResponse> => {
        throw new Error("Should not be called");
      },
    } as unknown as GemmaClient;

    const mockTaskService = {} as TaskService;
    const mockUserService = {} as UserService;
    const mockInsightsService = {} as InsightsService;

    const orchestrator = new ConversationOrchestrator(
      mockGemma,
      mockTaskService,
      mockUserService,
      mockInsightsService
    );

    (orchestrator as unknown as { getRecentHistory: () => Promise<[]> }).getRecentHistory = async () => [];
    (orchestrator as unknown as { persistTurn: () => Promise<void> }).persistTurn = async () => {};

    const reply = await orchestrator.handleMessage(mockUser, "Hi there!");
    assert.equal(reply, "Hello! How can I help you organize your commitments today?");
  });

  it("executes create_task tool call and feeds results back to Gemma", async () => {
    let continued = false;
    const mockTask: Task = {
      id: "11111111-1111-1111-1111-111111111111",
      userId: mockUser.id,
      title: "Board Meeting Prep",
      dueAt: "2026-09-01T18:00:00.000Z",
      priority: "high",
      status: "pending",
      taskType: "commitment",
      isSystemGenerated: false,
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
              title: "Board Meeting Prep",
              due_at_iso: "2026-09-01T18:00:00.000Z",
              priority: "high",
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
        continued = true;
        assert.equal(toolResults.length, 1);
        assert.equal(toolResults[0].name, "create_task");
        return {
          text: "Task created successfully in DB.\nREPLY: I've scheduled 'Board Meeting Prep' for September 1st at 6:00 PM.",
          toolCalls: [],
          rawContent: null,
        };
      },
    } as unknown as GemmaClient;

    const mockTaskService = {
      createTask: async (): Promise<Task> => mockTask,
    } as unknown as TaskService;

    const mockUserService = {} as UserService;
    const mockInsightsService = {} as InsightsService;

    const orchestrator = new ConversationOrchestrator(
      mockGemma,
      mockTaskService,
      mockUserService,
      mockInsightsService
    );

    (orchestrator as unknown as { getRecentHistory: () => Promise<[]> }).getRecentHistory = async () => [];
    (orchestrator as unknown as { persistTurn: () => Promise<void> }).persistTurn = async () => {};

    const reply = await orchestrator.handleMessage(mockUser, "Remind me to prepare for the board meeting on Sep 1 at 6pm");
    assert.equal(continued, true);
    assert.equal(reply, "I've scheduled 'Board Meeting Prep' for September 1st at 6:00 PM.");
  });

  it("returns graceful error fallback on unhandled failure", async () => {
    const mockGemma = {
      converse: async (): Promise<GemmaResponse> => {
        throw new Error("Network timeout or LLM failure");
      },
    } as unknown as GemmaClient;

    const orchestrator = new ConversationOrchestrator(
      mockGemma,
      {} as TaskService,
      {} as UserService,
      {} as InsightsService
    );

    (orchestrator as unknown as { getRecentHistory: () => Promise<[]> }).getRecentHistory = async () => [];

    const reply = await orchestrator.handleMessage(mockUser, "Hello");
    assert.ok(reply.includes("hit a snag"));
  });
});
