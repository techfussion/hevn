import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ConversationOrchestrator } from "../src/orchestrator/ConversationOrchestrator";
import { TaskService } from "../src/core/tasks/TaskService";
import { UserService } from "../src/core/tasks/UserService";
import { InsightsService } from "../src/core/insights/InsightsService";
import { FollowUpService } from "../src/core/followup/FollowUpService";
import { MemoryService } from "../src/core/memory/MemoryService";
import { ProjectService } from "../src/core/projects/ProjectService";
import { GemmaClient, GemmaResponse } from "../src/core/gemma/GemmaClient";
import { AudioIngestionService } from "../src/core/voice/AudioIngestionService";
import type { TranscriptionProvider, TranscriptionResult } from "../src/core/voice/types";
import type { MessagingAdapter, IncomingMessage } from "../src/adapters/MessagingAdapter";
import type { OutboundMessage, User, Task, FollowUp, UserMemory, ProjectSummary } from "../src/types/domain";

class MockVoiceTranscriptionProvider implements TranscriptionProvider {
  readonly providerName = "mock-gemini-voice";
  public nextTranscript = "";

  async transcribe(_audioBuffer: Buffer, _mimeType: string): Promise<TranscriptionResult> {
    return {
      transcript: this.nextTranscript,
      provider: this.providerName,
    };
  }
}

class MockAudioAdapter implements MessagingAdapter {
  readonly platformName = "telegram" as const;
  public sentMessages: OutboundMessage[] = [];

  async sendMessage(message: OutboundMessage): Promise<void> {
    this.sentMessages.push(message);
  }
  async sendTemplate(_userId: string, _template: string, _params: Record<string, string>): Promise<void> {}
  verifyWebhookSignature(_rawBody: string, _headers: Record<string, string | undefined>): boolean {
    return true;
  }
  parseIncomingWebhook(_payload: unknown): IncomingMessage | null {
    return null;
  }
  async downloadAudio(_mediaId: string): Promise<{ buffer: Buffer; mimeType: string }> {
    return {
      buffer: Buffer.from("mock_audio_bytes"),
      mimeType: "audio/ogg",
    };
  }
}

function createBaseUser(id: string, name: string): User {
  return {
    id,
    platform: "telegram",
    platformUserId: `tg_${id}`,
    displayName: name,
    timezone: "UTC",
    onboarded: true,
    onboardingState: "COMPLETED",
    assistantName: "Hevn",
    botPersona: "Hevn",
    persona: "professional",
    preferredCheckinTime: "06:00",
    preferredCheckinHour: 6,
    plan: "free",
    followupPreference: "active",
    quietHoursStart: "22:00",
    quietHoursEnd: "07:00",
    createdAt: new Date().toISOString(),
  };
}

describe("Voice Notes — End-to-End Secretary Scenarios", () => {
  it("Scenario 1: Voice Task Creation — 'Remind me tomorrow at 3pm to call Sarah'", async () => {
    const mockUser = createBaseUser("00000000-0000-0000-0000-000000000001", "Alex");
    const tasks: Task[] = [];

    const taskService = new TaskService();
    taskService.createTask = async (_userId: string, input: any): Promise<Task> => {
      const task: Task = {
        id: "task-101",
        userId: mockUser.id,
        title: input.title,
        dueAt: input.dueDate,
        priority: "medium",
        status: "pending",
        taskType: "task",
        isSystemGenerated: false,
        parentTaskId: null,
        projectId: null,
        reminderOffsetMinutes: input.reminderMinutesBefore || 15,
        reminderSentAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      tasks.push(task);
      return task;
    };
    taskService.getPendingTasks = async (): Promise<Task[]> => tasks;

    const userService = new UserService();
    const insightsService = new InsightsService();

    const mockGemma = {
      converse: async (): Promise<GemmaResponse> => ({
        text: null,
        toolCalls: [
          {
            name: "create_task",
            args: {
              title: "Call Sarah",
              dueDate: "2026-08-25T14:00:00.000Z",
              reminderMinutesBefore: 15,
            },
          },
        ],
        rawContent: { role: "model", parts: [] },
      }),
      continueWithToolResults: async (): Promise<GemmaResponse> => ({
        text: "REPLY: I have scheduled a reminder to call Sarah tomorrow at 3:00 PM.",
        toolCalls: [],
        rawContent: null,
      }),
    } as unknown as GemmaClient;

    const orchestrator = new ConversationOrchestrator(mockGemma, taskService, userService, insightsService);
    (orchestrator as unknown as { getRecentHistory: () => Promise<any[]> }).getRecentHistory = async () => [];
    (orchestrator as unknown as { persistTurn: () => Promise<void> }).persistTurn = async () => {};

    const provider = new MockVoiceTranscriptionProvider();
    provider.nextTranscript = "Remind me tomorrow at 3pm to call Sarah";
    const audioService = new AudioIngestionService(provider);
    const adapter = new MockAudioAdapter();

    const audioRes = await audioService.processAudioMessage(adapter, {
      mediaId: "voice_task_1",
      mimeType: "audio/ogg",
    });
    assert.equal(audioRes.success, true);

    const reply = await orchestrator.handleMessage(mockUser, audioRes.transcript!);
    assert.match(reply, /call Sarah/i);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].title, "Call Sarah");
  });

  it("Scenario 2: Voice Commitment & Preparation Suggestion — 'I have a database exam Thursday'", async () => {
    const mockUser = createBaseUser("00000000-0000-0000-0000-000000000002", "Bella");
    const commitments: Task[] = [];

    const taskService = new TaskService();
    taskService.createTask = async (_userId: string, input: any): Promise<Task> => {
      const task: Task = {
        id: "commit-202",
        userId: mockUser.id,
        title: input.title,
        dueAt: input.dueDate,
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
      commitments.push(task);
      return task;
    };
    taskService.getCommitments = async (): Promise<Task[]> => commitments;

    const userService = new UserService();
    const insightsService = new InsightsService();

    const mockGemma = {
      converse: async (): Promise<GemmaResponse> => ({
        text: null,
        toolCalls: [
          {
            name: "create_task",
            args: {
              title: "Database Exam",
              isCommitment: true,
              dueDate: "2026-08-27T09:00:00.000Z",
            },
          },
        ],
        rawContent: { role: "model", parts: [] },
      }),
      continueWithToolResults: async (): Promise<GemmaResponse> => ({
        text: "REPLY: I've noted your Database Exam on Thursday at 10:00 AM. Would you like me to set up a study session to prepare?",
        toolCalls: [],
        rawContent: null,
      }),
    } as unknown as GemmaClient;

    const orchestrator = new ConversationOrchestrator(mockGemma, taskService, userService, insightsService);
    (orchestrator as unknown as { getRecentHistory: () => Promise<any[]> }).getRecentHistory = async () => [];
    (orchestrator as unknown as { persistTurn: () => Promise<void> }).persistTurn = async () => {};

    const provider = new MockVoiceTranscriptionProvider();
    provider.nextTranscript = "I have a database exam Thursday at 10am";
    const audioService = new AudioIngestionService(provider);
    const adapter = new MockAudioAdapter();

    const audioRes = await audioService.processAudioMessage(adapter, {
      mediaId: "voice_commitment_1",
      mimeType: "audio/ogg",
    });

    const reply = await orchestrator.handleMessage(mockUser, audioRes.transcript!);
    assert.match(reply, /Database Exam/i);
    assert.match(reply, /prepare|study/i);
    assert.equal(commitments.length, 1);
    assert.equal(commitments[0].taskType, "commitment");
  });

  it("Scenario 3: Voice Follow-Up Response — 'Not yet, remind me tomorrow'", async () => {
    const mockUser = createBaseUser("00000000-0000-0000-0000-000000000003", "Charlie");

    const taskService = new TaskService();
    const userService = new UserService();
    const insightsService = new InsightsService();

    const followUpService = new FollowUpService();
    const mockFollowUp: FollowUp = {
      id: "fu-303",
      userId: mockUser.id,
      taskId: "task-303",
      scheduledAt: new Date(Date.now() - 3600000).toISOString(),
      deliveredAt: new Date(Date.now() - 1800000).toISOString(),
      status: "WAITING_FOR_RESPONSE",
      attemptCount: 1,
      maxAttempts: 3,
      intervalHours: 4,
      lastUserResponse: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    followUpService.getActiveCandidateFollowUps = async () => [
      {
        followUp: mockFollowUp,
        task: {
          id: "task-303",
          userId: mockUser.id,
          title: "Submit lab report",
          dueAt: new Date().toISOString(),
          priority: "high",
          status: "pending",
          taskType: "task",
          isSystemGenerated: false,
          parentTaskId: null,
          projectId: null,
          reminderOffsetMinutes: null,
          reminderSentAt: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      },
    ];

    let handledResponse = false;
    followUpService.handleFollowUpResponse = async () => {
      handledResponse = true;
      return { success: true, newStatus: "RESCHEDULED" };
    };

    const mockGemma = {
      converse: async (): Promise<GemmaResponse> => ({
        text: null,
        toolCalls: [
          {
            name: "respond_followup",
            args: {
              followup_id: "fu-303",
              intent: "rescheduled",
              new_scheduled_at_iso: "2026-08-25T09:00:00.000Z",
            },
          },
        ],
        rawContent: { role: "model", parts: [] },
      }),
      continueWithToolResults: async (): Promise<GemmaResponse> => ({
        text: "REPLY: Understood. I've rescheduled your follow-up for tomorrow.",
        toolCalls: [],
        rawContent: null,
      }),
    } as unknown as GemmaClient;

    const orchestrator = new ConversationOrchestrator(
      mockGemma,
      taskService,
      userService,
      insightsService,
      followUpService
    );
    (orchestrator as unknown as { getRecentHistory: () => Promise<any[]> }).getRecentHistory = async () => [];
    (orchestrator as unknown as { persistTurn: () => Promise<void> }).persistTurn = async () => {};

    const provider = new MockVoiceTranscriptionProvider();
    provider.nextTranscript = "Not yet, remind me tomorrow";
    const audioService = new AudioIngestionService(provider);
    const adapter = new MockAudioAdapter();

    const audioRes = await audioService.processAudioMessage(adapter, {
      mediaId: "voice_followup_1",
      mimeType: "audio/ogg",
    });

    const reply = await orchestrator.handleMessage(mockUser, audioRes.transcript!);
    assert.ok(reply.length > 0);
    assert.equal(handledResponse, true);
  });

  it("Scenario 4: Voice Memory — 'Remember that Sarah is my project supervisor'", async () => {
    const mockUser = createBaseUser("00000000-0000-0000-0000-000000000004", "Diana");
    const memories: UserMemory[] = [];

    const taskService = new TaskService();
    const userService = new UserService();
    const insightsService = new InsightsService();
    const memoryService = new MemoryService();
    memoryService.storeMemory = async (_userId: string, input: any) => {
      const mem: UserMemory = {
        id: "mem-404",
        userId: mockUser.id,
        category: input.category,
        key: input.key ?? null,
        value: input.content,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      memories.push(mem);
      return mem;
    };
    memoryService.getUserMemories = async () => memories;

    const mockGemma = {
      converse: async (): Promise<GemmaResponse> => ({
        text: null,
        toolCalls: [
          {
            name: "store_memory",
            args: {
              category: "relationship",
              key: "project_supervisor",
              content: "Sarah is the project supervisor",
            },
          },
        ],
        rawContent: { role: "model", parts: [] },
      }),
      continueWithToolResults: async (): Promise<GemmaResponse> => ({
        text: "REPLY: I will remember that Sarah is your project supervisor.",
        toolCalls: [],
        rawContent: null,
      }),
    } as unknown as GemmaClient;

    const orchestrator = new ConversationOrchestrator(
      mockGemma,
      taskService,
      userService,
      insightsService,
      undefined,
      undefined,
      memoryService
    );
    (orchestrator as unknown as { getRecentHistory: () => Promise<any[]> }).getRecentHistory = async () => [];
    (orchestrator as unknown as { persistTurn: () => Promise<void> }).persistTurn = async () => {};

    const provider = new MockVoiceTranscriptionProvider();
    provider.nextTranscript = "Remember that Sarah is my project supervisor";
    const audioService = new AudioIngestionService(provider);
    const adapter = new MockAudioAdapter();

    const audioRes = await audioService.processAudioMessage(adapter, {
      mediaId: "voice_mem_1",
      mimeType: "audio/ogg",
    });

    const reply = await orchestrator.handleMessage(mockUser, audioRes.transcript!);
    assert.match(reply, /Sarah/i);
    assert.equal(memories.length, 1);
    assert.equal(memories[0].key, "project_supervisor");
  });

  it("Scenario 5: Voice Project Summary — 'What's left in the Q3 proposal?'", async () => {
    const mockUser = createBaseUser("00000000-0000-0000-0000-000000000005", "Evan");

    const taskService = new TaskService();
    const userService = new UserService();
    const insightsService = new InsightsService();
    const projectService = new ProjectService();

    const sampleSummary: ProjectSummary = {
      project: {
        id: "proj-505",
        userId: mockUser.id,
        name: "Q3 Proposal",
        description: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      totalTasks: 2,
      completedTasks: 1,
      pendingTasks: 1,
      overdueTasks: 0,
      upcomingTasks: 1,
      commitmentsCount: 0,
      completionPercentage: 50,
      remainingTasks: [
        {
          id: "t2",
          title: "Review Budget Table",
          dueAt: new Date().toISOString(),
          priority: "high",
          status: "pending",
          isCommitment: false,
        },
      ],
      completedTasksList: [
        {
          id: "t1",
          title: "Draft Executive Summary",
          completedAt: new Date().toISOString(),
        },
      ],
    };

    projectService.getProjectSummary = async () => sampleSummary;

    const mockGemma = {
      converse: async (): Promise<GemmaResponse> => ({
        text: null,
        toolCalls: [
          {
            name: "get_project_summary",
            args: {
              project_name_or_id: "Q3 Proposal",
            },
          },
        ],
        rawContent: { role: "model", parts: [] },
      }),
      continueWithToolResults: async (): Promise<GemmaResponse> => ({
        text: "REPLY: In Q3 Proposal, you've completed 1 task (Draft Executive Summary) and have 1 pending task remaining: Review Budget Table (50% complete).",
        toolCalls: [],
        rawContent: null,
      }),
    } as unknown as GemmaClient;

    const orchestrator = new ConversationOrchestrator(
      mockGemma,
      taskService,
      userService,
      insightsService,
      undefined,
      undefined,
      undefined,
      projectService
    );
    (orchestrator as unknown as { getRecentHistory: () => Promise<any[]> }).getRecentHistory = async () => [];
    (orchestrator as unknown as { persistTurn: () => Promise<void> }).persistTurn = async () => {};

    const provider = new MockVoiceTranscriptionProvider();
    provider.nextTranscript = "What's left in the Q3 proposal?";
    const audioService = new AudioIngestionService(provider);
    const adapter = new MockAudioAdapter();

    const audioRes = await audioService.processAudioMessage(adapter, {
      mediaId: "voice_proj_1",
      mimeType: "audio/ogg",
    });

    const reply = await orchestrator.handleMessage(mockUser, audioRes.transcript!);
    assert.match(reply, /50%/);
    assert.match(reply, /Review Budget Table/);
  });

  it("Scenario 6: Voice Multi-Turn Context Resolution", async () => {
    const mockUser = createBaseUser("00000000-0000-0000-0000-000000000006", "Fiona");
    const tasks: Task[] = [];

    const taskService = new TaskService();
    taskService.createTask = async (_userId: string, input: any): Promise<Task> => {
      const task: Task = {
        id: "task-606",
        userId: mockUser.id,
        title: input.title,
        dueAt: input.dueDate,
        priority: "medium",
        status: "pending",
        taskType: "task",
        isSystemGenerated: false,
        parentTaskId: null,
        projectId: null,
        reminderOffsetMinutes: 15,
        reminderSentAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      tasks.push(task);
      return task;
    };

    const savedTurns: any[] = [];
    const userService = new UserService();
    const insightsService = new InsightsService();

    let turnCount = 0;
    const mockGemma = {
      converse: async (): Promise<GemmaResponse> => {
        turnCount++;
        if (turnCount === 1) {
          return {
            text: "REPLY: When would you like me to remind you about the proposal?",
            toolCalls: [],
            rawContent: null,
          };
        }
        return {
          text: null,
          toolCalls: [
            {
              name: "create_task",
              args: {
                title: "Submit Proposal",
                dueDate: "2026-08-25T08:00:00.000Z",
              },
            },
          ],
          rawContent: { role: "model", parts: [] },
        };
      },
      continueWithToolResults: async (): Promise<GemmaResponse> => ({
        text: "REPLY: Set a reminder for the proposal tomorrow at 9:00 AM.",
        toolCalls: [],
        rawContent: null,
      }),
    } as unknown as GemmaClient;

    const orchestrator = new ConversationOrchestrator(mockGemma, taskService, userService, insightsService);
    (orchestrator as unknown as { getRecentHistory: () => Promise<any[]> }).getRecentHistory = async () => savedTurns;
    (orchestrator as unknown as { persistTurn: (uid: string, r: string, t: string) => Promise<void> }).persistTurn = async (_uid, role, txt) => {
      savedTurns.push({ role, content: txt });
    };

    // Turn 1: User sends text
    const reply1 = await orchestrator.handleMessage(mockUser, "Remind me about the proposal");
    assert.match(reply1, /When/i);

    // Turn 2: User sends voice note
    const provider = new MockVoiceTranscriptionProvider();
    provider.nextTranscript = "Tomorrow morning at 9am";
    const audioService = new AudioIngestionService(provider);
    const adapter = new MockAudioAdapter();

    const audioRes = await audioService.processAudioMessage(adapter, {
      mediaId: "voice_context_2",
      mimeType: "audio/ogg",
    });

    const reply2 = await orchestrator.handleMessage(mockUser, audioRes.transcript!);
    assert.match(reply2, /proposal/i);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].title, "Submit Proposal");
  });
});
