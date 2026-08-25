import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ConversationOrchestrator } from "../src/orchestrator/ConversationOrchestrator";
import { AudioIngestionService } from "../src/core/voice/AudioIngestionService";
import { AudioSynthesisService } from "../src/core/voice/AudioSynthesisService";
import { ResponsePolicyService } from "../src/core/voice/ResponsePolicyService";
import { TaskService } from "../src/core/tasks/TaskService";
import { UserService } from "../src/core/tasks/UserService";
import { InsightsService } from "../src/core/insights/InsightsService";
import { FollowUpService } from "../src/core/followup/FollowUpService";
import { ProjectService } from "../src/core/projects/ProjectService";
import { MemoryService } from "../src/core/memory/MemoryService";
import { RecurringTaskService } from "../src/core/recurring/RecurringTaskService";
import { CalendarService } from "../src/core/calendar/CalendarService";
import type { GemmaClient, ModelResponse } from "../src/core/gemma/GemmaClient";
import type { TranscriptionProvider, TranscriptionResult, AudioSynthesisProvider, AudioSynthesisOptions, SynthesizedAudio } from "../src/core/voice/types";
import type { MessagingAdapter, IncomingMessage, ChannelCapabilities, OutboundAudio } from "../src/adapters/MessagingAdapter";
import type { User, OutboundMessage } from "../src/types/domain";

class MockTranscriptionProvider implements TranscriptionProvider {
  readonly providerName = "mock-whisper";
  public transcriptToReturn = "Remind me tomorrow at 3pm to call Sarah";

  async transcribe(_buffer: Buffer, _mimeType: string): Promise<TranscriptionResult> {
    return {
      transcript: this.transcriptToReturn,
      provider: this.providerName,
    };
  }
}

class MockAudioSynthesisProvider implements AudioSynthesisProvider {
  readonly providerName = "mock-tts";
  public callCount = 0;
  public lastSynthesizedText?: string;

  async synthesize(text: string, _options?: AudioSynthesisOptions): Promise<SynthesizedAudio> {
    this.callCount++;
    this.lastSynthesizedText = text;
    return {
      buffer: Buffer.from("SYNTHESIZED_AUDIO_BUFFER_DATA"),
      mimeType: "audio/ogg",
      durationSeconds: 3.2,
      provider: this.providerName,
    };
  }
}

class MockFullAdapter implements MessagingAdapter {
  readonly platformName = "telegram" as const;
  readonly capabilities: ChannelCapabilities = {
    textInput: true,
    audioInput: true,
    textOutput: true,
    audioOutput: true,
    interactiveButtons: true,
  };

  public sentMessages: OutboundMessage[] = [];
  public sentAudios: OutboundAudio[] = [];

  async sendMessage(message: OutboundMessage): Promise<void> {
    this.sentMessages.push(message);
  }

  async sendAudio(audio: OutboundAudio): Promise<void> {
    this.sentAudios.push(audio);
  }

  async downloadAudio(_mediaId: string): Promise<{ buffer: Buffer; mimeType: string }> {
    return { buffer: Buffer.from("FAKE_VOICE_NOTE_INCOMING"), mimeType: "audio/ogg" };
  }

  async sendTemplate(_userId: string, _template: string, _params: Record<string, string>): Promise<void> {}
  verifyWebhookSignature(_rawBody: string, _headers: Record<string, string | undefined>): boolean {
    return true;
  }
  parseIncomingWebhook(_payload: unknown): IncomingMessage | null {
    return null;
  }
}

class MockGemmaClient {
  public responseText = "REPLY: Done. I will remind you tomorrow at 3 PM.";
  public toolCalls: Array<{ name: string; args: Record<string, any> }> = [];

  async converse(): Promise<ModelResponse> {
    return {
      text: this.responseText,
      toolCalls: this.toolCalls,
      rawContent: {},
    };
  }

  async continueWithToolResults(): Promise<ModelResponse> {
    return {
      text: this.responseText,
      toolCalls: [],
      rawContent: {},
    };
  }
}

function createE2EUser(overrides: Partial<User> = {}): User {
  return {
    id: "user-e2e-1",
    platform: "telegram",
    platformUserId: "tg-chat-e2e-1",
    displayName: "Jane",
    timezone: "UTC",
    onboarded: true,
    onboardingState: "COMPLETED",
    assistantName: "Hevn",
    botPersona: "Hevn",
    persona: "student",
    preferredCheckinTime: "06:00",
    preferredCheckinHour: 6,
    plan: "free",
    followupPreference: "active",
    quietHoursStart: null,
    quietHoursEnd: null,
    responseMode: "auto",
    voiceEnabled: true,
    voiceName: null,
    voiceLanguage: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("Voice Notes — End-to-End Multimodal Round-Trip Workflows", () => {
  it("Workflow 1: Voice Input -> Transcription -> Orchestrator Tool -> Outbound Voice Reply", async () => {
    const adapter = new MockFullAdapter();
    const transcription = new MockTranscriptionProvider();
    transcription.transcriptToReturn = "Remind me tomorrow at 3pm to call Sarah";

    const ingestionService = new AudioIngestionService(transcription);
    const synthesisProvider = new MockAudioSynthesisProvider();
    const synthesisService = new AudioSynthesisService(synthesisProvider);
    const responsePolicy = new ResponsePolicyService(synthesisService);

    const mockGemma = new MockGemmaClient();
    mockGemma.toolCalls = [
      {
        name: "create_task",
        args: {
          title: "Call Sarah",
          due_at_iso: "2026-08-26T15:00:00Z",
          priority: "medium",
          task_type: "reminder",
        },
      },
    ];
    mockGemma.responseText = "REPLY: Done. I will remind you tomorrow at 3 PM.";

    const taskService = new TaskService();
    taskService.createTask = async () => ({
      id: "task-1",
      userId: "user-e2e-1",
      title: "Call Sarah",
      dueAt: "2026-08-26T15:00:00Z",
      priority: "medium",
      status: "pending",
      taskType: "reminder",
      isSystemGenerated: false,
      reminderOffsetMinutes: null,
      reminderSentAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const userService = new UserService();
    const insightsService = new InsightsService();
    const followUpService = new FollowUpService();
    const recurringService = new RecurringTaskService();
    const memoryService = new MemoryService();
    const projectService = new ProjectService();
    const calendarService = new CalendarService();

    const orchestrator = new ConversationOrchestrator(
      mockGemma as unknown as GemmaClient,
      taskService,
      userService,
      insightsService,
      followUpService,
      recurringService,
      memoryService,
      projectService,
      calendarService
    );
    (orchestrator as unknown as { getRecentHistory: () => Promise<any[]> }).getRecentHistory = async () => [];
    (orchestrator as unknown as { persistTurn: () => Promise<void> }).persistTurn = async () => {};

    // 1. Ingest audio message
    const audioResult = await ingestionService.processAudioMessage(adapter, {
      mediaId: "voice_note_msg_1",
      mimeType: "audio/ogg",
    });

    assert.equal(audioResult.success, true);
    assert.equal(audioResult.transcript, "Remind me tomorrow at 3pm to call Sarah");

    // 2. Orchestrate conversation
    const user = createE2EUser({ responseMode: "auto" });
    const replyText = await orchestrator.handleMessage(user, audioResult.transcript!);

    assert.equal(replyText, "Done. I will remind you tomorrow at 3 PM.");

    // 3. Deliver reply through Response Policy
    const deliveryResult = await responsePolicy.deliverResponse(
      adapter,
      user,
      { userId: user.platformUserId, text: replyText },
      { inputWasAudio: true }
    );

    // Since input was audio and responseMode was 'auto', output is synthesized audio
    assert.equal(deliveryResult.deliveredAs, "voice");
    assert.equal(adapter.sentAudios.length, 1);
    assert.equal(adapter.sentAudios[0].userId, "tg-chat-e2e-1");
    assert.equal(synthesisProvider.callCount, 1);
    assert.equal(synthesisProvider.lastSynthesizedText, "Done. I will remind you tomorrow at 3 PM.");
  });

  it("Workflow 2: Voice Follow-Up Delivery with Interactive Inline Buttons", async () => {
    const adapter = new MockFullAdapter();
    const synthesisProvider = new MockAudioSynthesisProvider();
    const synthesisService = new AudioSynthesisService(synthesisProvider);
    const responsePolicy = new ResponsePolicyService(synthesisService);

    const user = createE2EUser({ responseMode: "voice" }); // user requested voice mode

    const followUpMessage: OutboundMessage = {
      userId: user.platformUserId,
      text: "Following up on your proposal — have you managed to get this done?",
      buttons: [
        { label: "Done", action: "fu:followup_1:done" },
        { label: "Not Yet", action: "fu:followup_1:not_yet" },
        { label: "+1 Hour", action: "fu:followup_1:snooze_60" },
      ],
    };

    const deliveryResult = await responsePolicy.deliverResponse(
      adapter,
      user,
      followUpMessage
    );

    assert.equal(deliveryResult.deliveredAs, "voice");
    assert.equal(adapter.sentAudios.length, 1);
    assert.equal(adapter.sentAudios[0].caption, "Following up on your proposal — have you managed to get this done?");
    assert.equal(adapter.sentAudios[0].buttons?.length, 3);
    assert.equal(adapter.sentAudios[0].buttons?.[0].label, "Done");
    assert.equal(synthesisProvider.callCount, 1);
  });

  it("Workflow 3: Voice Query for Project Summary -> Synthesized Audio Reply", async () => {
    const adapter = new MockFullAdapter();
    const synthesisProvider = new MockAudioSynthesisProvider();
    const synthesisService = new AudioSynthesisService(synthesisProvider);
    const responsePolicy = new ResponsePolicyService(synthesisService);

    const user = createE2EUser({ responseMode: "auto" });
    const replyText = "Project \"Q3 Proposal\": 3 of 5 tasks completed (60%). Remaining: Final Review (due Friday).";

    const deliveryResult = await responsePolicy.deliverResponse(
      adapter,
      user,
      { userId: user.platformUserId, text: replyText },
      { inputWasAudio: true }
    );

    assert.equal(deliveryResult.deliveredAs, "voice");
    assert.equal(adapter.sentAudios.length, 1);
    assert.equal(synthesisProvider.lastSynthesizedText, replyText);
  });
});
