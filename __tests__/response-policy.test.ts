import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ResponsePolicyService } from "../src/core/voice/ResponsePolicyService";
import { AudioSynthesisService } from "../src/core/voice/AudioSynthesisService";
import { VoiceMetricsService } from "../src/core/voice/VoiceMetricsService";
import type { AudioSynthesisProvider, AudioSynthesisOptions, SynthesizedAudio } from "../src/core/voice/types";
import type { MessagingAdapter, IncomingMessage, ChannelCapabilities, OutboundAudio } from "../src/adapters/MessagingAdapter";
import type { User, OutboundMessage } from "../src/types/domain";

class MockTtsProvider implements AudioSynthesisProvider {
  readonly providerName = "mock-tts";
  public shouldFail = false;
  public callCount = 0;

  async synthesize(_text: string, _options?: AudioSynthesisOptions): Promise<SynthesizedAudio> {
    this.callCount++;
    if (this.shouldFail) {
      throw new Error("TTS provider network drop");
    }
    return {
      buffer: Buffer.from("SYNTHESIZED_VOICE_OGG"),
      mimeType: "audio/ogg",
      durationSeconds: 2.0,
      provider: this.providerName,
    };
  }
}

class MockChannelAdapter implements MessagingAdapter {
  readonly platformName = "telegram" as const;
  public capabilities: ChannelCapabilities = {
    textInput: true,
    audioInput: true,
    textOutput: true,
    audioOutput: true,
    interactiveButtons: true,
  };

  public sentMessages: OutboundMessage[] = [];
  public sentAudios: OutboundAudio[] = [];
  public shouldSendAudioFail = false;

  async sendMessage(message: OutboundMessage): Promise<void> {
    this.sentMessages.push(message);
  }

  async sendAudio(audio: OutboundAudio): Promise<void> {
    if (this.shouldSendAudioFail) {
      throw new Error("Telegram sendVoice network failure");
    }
    this.sentAudios.push(audio);
  }

  async sendTemplate(_userId: string, _template: string, _params: Record<string, string>): Promise<void> {}
  verifyWebhookSignature(_rawBody: string, _headers: Record<string, string | undefined>): boolean {
    return true;
  }
  parseIncomingWebhook(_payload: unknown): IncomingMessage | null {
    return null;
  }
}

function createDummyUser(overrides: Partial<User> = {}): User {
  return {
    id: "user-456",
    platform: "telegram",
    platformUserId: "tg-chat-456",
    displayName: "Alex",
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

describe("Response Policy — Channel Capability & Mode Selection", () => {
  it("delivers text when user responseMode is 'text'", async () => {
    const provider = new MockTtsProvider();
    const tts = new AudioSynthesisService(provider);
    const policy = new ResponsePolicyService(tts);
    const adapter = new MockChannelAdapter();
    const user = createDummyUser({ responseMode: "text" });

    const result = await policy.deliverResponse(
      adapter,
      user,
      { userId: user.platformUserId, text: "Done. I have scheduled your task." },
      { inputWasAudio: true } // even if user sent voice, preference says text
    );

    assert.equal(result.deliveredAs, "text");
    assert.equal(result.fallbackUsed, false);
    assert.equal(adapter.sentMessages.length, 1);
    assert.equal(adapter.sentAudios.length, 0);
    assert.equal(provider.callCount, 0); // never calls TTS
  });

  it("delivers text when channel does not support audio output", async () => {
    const provider = new MockTtsProvider();
    const tts = new AudioSynthesisService(provider);
    const policy = new ResponsePolicyService(tts);
    const adapter = new MockChannelAdapter();
    adapter.capabilities = {
      textInput: true,
      audioInput: false,
      textOutput: true,
      audioOutput: false, // audio output disabled
      interactiveButtons: false,
    };
    const user = createDummyUser({ responseMode: "voice" });

    const result = await policy.deliverResponse(
      adapter,
      user,
      { userId: user.platformUserId, text: "Meeting scheduled." }
    );

    assert.equal(result.deliveredAs, "text");
    assert.equal(adapter.sentMessages.length, 1);
    assert.equal(adapter.sentAudios.length, 0);
    assert.equal(provider.callCount, 0);
  });

  it("delivers voice in auto mode when input was audio and text length is within auto threshold", async () => {
    const provider = new MockTtsProvider();
    const tts = new AudioSynthesisService(provider);
    const policy = new ResponsePolicyService(tts);
    const adapter = new MockChannelAdapter();
    const user = createDummyUser({ responseMode: "auto" });

    const result = await policy.deliverResponse(
      adapter,
      user,
      { userId: user.platformUserId, text: "Done! I've noted that Sarah is your project manager." },
      { inputWasAudio: true }
    );

    assert.equal(result.deliveredAs, "voice");
    assert.equal(result.fallbackUsed, false);
    assert.equal(adapter.sentAudios.length, 1);
    assert.equal(adapter.sentMessages.length, 0);
    assert.equal(provider.callCount, 1);
  });

  it("delivers text in auto mode when input was text", async () => {
    const provider = new MockTtsProvider();
    const tts = new AudioSynthesisService(provider);
    const policy = new ResponsePolicyService(tts);
    const adapter = new MockChannelAdapter();
    const user = createDummyUser({ responseMode: "auto" });

    const result = await policy.deliverResponse(
      adapter,
      user,
      { userId: user.platformUserId, text: "Task created." },
      { inputWasAudio: false }
    );

    assert.equal(result.deliveredAs, "text");
    assert.equal(adapter.sentMessages.length, 1);
    assert.equal(adapter.sentAudios.length, 0);
    assert.equal(provider.callCount, 0);
  });

  it("delivers text in auto mode when response is overly long", async () => {
    const provider = new MockTtsProvider();
    const tts = new AudioSynthesisService(provider);
    const policy = new ResponsePolicyService(tts, {
      maxTextLength: 1500,
      maxAutoVoiceLength: 100, // short auto limit
      timeoutMs: 5000,
      maxRetries: 2,
      cacheTtlMs: 60000,
      maxCacheEntries: 50,
    });
    const adapter = new MockChannelAdapter();
    const user = createDummyUser({ responseMode: "auto" });

    const longText = "This is a detailed 5-part project plan with many bullet points that would be too tedious as a long audio note: " + "step... ".repeat(30);

    const result = await policy.deliverResponse(
      adapter,
      user,
      { userId: user.platformUserId, text: longText },
      { inputWasAudio: true }
    );

    assert.equal(result.deliveredAs, "text");
    assert.equal(adapter.sentMessages.length, 1);
    assert.equal(adapter.sentAudios.length, 0);
    assert.equal(provider.callCount, 0);
  });

  it("falls back gracefully to text when TTS provider fails", async () => {
    const provider = new MockTtsProvider();
    provider.shouldFail = true;
    const metrics = VoiceMetricsService.getInstance();
    metrics.resetMetrics();
    const tts = new AudioSynthesisService(provider, undefined, metrics);
    const policy = new ResponsePolicyService(tts, undefined, metrics);
    const adapter = new MockChannelAdapter();
    const user = createDummyUser({ responseMode: "voice" });

    const result = await policy.deliverResponse(
      adapter,
      user,
      { userId: user.platformUserId, text: "Done, marked as completed." }
    );

    assert.equal(result.deliveredAs, "text");
    assert.equal(result.fallbackUsed, true);
    assert.equal(adapter.sentMessages.length, 1);
    assert.equal(adapter.sentAudios.length, 0);

    const metricValues = metrics.getMetrics();
    assert.equal(metricValues.voiceTextFallbacks, 1);
  });

  it("falls back gracefully to text when channel adapter sendAudio throws", async () => {
    const provider = new MockTtsProvider();
    const metrics = VoiceMetricsService.getInstance();
    metrics.resetMetrics();
    const tts = new AudioSynthesisService(provider, undefined, metrics);
    const policy = new ResponsePolicyService(tts, undefined, metrics);
    const adapter = new MockChannelAdapter();
    adapter.shouldSendAudioFail = true;
    const user = createDummyUser({ responseMode: "voice" });

    const result = await policy.deliverResponse(
      adapter,
      user,
      { userId: user.platformUserId, text: "All tasks completed!" }
    );

    assert.equal(result.deliveredAs, "text");
    assert.equal(result.fallbackUsed, true);
    assert.equal(adapter.sentMessages.length, 1); // sent via text fallback
    assert.equal(adapter.sentMessages[0].text, "All tasks completed!");

    const metricValues = metrics.getMetrics();
    assert.equal(metricValues.voiceDeliveryFailures, 1);
    assert.equal(metricValues.voiceTextFallbacks, 1);
  });
});
