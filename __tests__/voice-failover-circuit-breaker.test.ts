import test from "node:test";
import assert from "node:assert/strict";
import { CircuitBreaker } from "../src/core/voice/CircuitBreaker";
import { AudioSynthesisService } from "../src/core/voice/AudioSynthesisService";
import { ResponsePolicyService } from "../src/core/voice/ResponsePolicyService";
import type { AudioSynthesisProvider, SynthesizedAudio } from "../src/core/voice/types";
import type { MessagingAdapter, OutboundMessage } from "../src/adapters/MessagingAdapter";
import type { User } from "../src/types/domain";

test("Voice Failover & Circuit Breaker — Multi-Provider Pool Resilience & Text Fallback", async (t) => {
  await t.test("CircuitBreaker transitions CLOSED -> OPEN after failure threshold, and HALF_OPEN probe recovers to CLOSED", async () => {
    const cb = new CircuitBreaker({
      name: "mock-tts",
      failureThreshold: 3,
      coolDownMs: 50, // 50ms for fast unit testing
    });

    assert.strictEqual(cb.getState(), "CLOSED");

    // 1. First 2 failures: stays CLOSED
    cb.recordFailure(new Error("Transient error 1"));
    assert.strictEqual(cb.getState(), "CLOSED");
    cb.recordFailure(new Error("Transient error 2"));
    assert.strictEqual(cb.getState(), "CLOSED");

    // 2. Third failure: trips to OPEN
    cb.recordFailure(new Error("Transient error 3"));
    assert.strictEqual(cb.getState(), "OPEN");

    // 3. While OPEN: execute() fails fast
    await assert.rejects(
      async () => cb.execute(async () => "ok"),
      /is OPEN/
    );

    // 4. Wait for coolDownMs -> transitions to HALF_OPEN
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.strictEqual(cb.getState(), "HALF_OPEN");

    // 5. Successful probe execution recovers to CLOSED
    const result = await cb.execute(async () => "probe-success");
    assert.strictEqual(result, "probe-success");
    assert.strictEqual(cb.getState(), "CLOSED");
  });

  await t.test("AudioSynthesisService fails over from broken primary provider to healthy secondary provider in pool", async () => {
    let primaryAttempts = 0;
    let secondaryAttempts = 0;

    const brokenPrimaryProvider: AudioSynthesisProvider = {
      providerName: "elevenlabs-primary",
      async synthesize(): Promise<SynthesizedAudio> {
        primaryAttempts++;
        throw new Error("ElevenLabs 429 Quota Exceeded");
      },
    };

    const healthySecondaryProvider: AudioSynthesisProvider = {
      providerName: "google-tts-secondary",
      async synthesize(text: string): Promise<SynthesizedAudio> {
        secondaryAttempts++;
        return {
          buffer: Buffer.from("google-audio-data"),
          mimeType: "audio/ogg",
          durationSeconds: 2.5,
          provider: "google-tts-secondary",
        };
      },
    };

    const synthService = new AudioSynthesisService([
      brokenPrimaryProvider,
      healthySecondaryProvider,
    ]);

    const result = await synthService.synthesize("Hello student, your study session starts in 15 minutes.");

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.audio?.provider, "google-tts-secondary");
    assert.strictEqual(primaryAttempts, 1);
    assert.strictEqual(secondaryAttempts, 1);

    const health = synthService.getProviderHealth();
    assert.strictEqual(health.length, 2);
    assert.strictEqual(health[0].providerName, "elevenlabs-primary");
    assert.strictEqual(health[0].failureCount, 1);
    assert.strictEqual(health[1].providerName, "google-tts-secondary");
    assert.strictEqual(health[1].successCount, 1);
  });

  await t.test("ResponsePolicyService automatically falls back to text when all TTS providers in pool fail", async () => {
    const failingProvider1: AudioSynthesisProvider = {
      providerName: "failing-1",
      async synthesize(): Promise<SynthesizedAudio> {
        throw new Error("Provider 1 socket hangup");
      },
    };
    const failingProvider2: AudioSynthesisProvider = {
      providerName: "failing-2",
      async synthesize(): Promise<SynthesizedAudio> {
        throw new Error("Provider 2 503 Service Unavailable");
      },
    };

    const synthService = new AudioSynthesisService([failingProvider1, failingProvider2]);
    const responsePolicyService = new ResponsePolicyService(synthService);

    const deliveredMessages: OutboundMessage[] = [];
    const mockAdapter: MessagingAdapter = {
      platform: "telegram",
      capabilities: {
        textInput: true,
        audioInput: true,
        textOutput: true,
        audioOutput: true,
        interactiveButtons: true,
      },
      async sendMessage(msg: OutboundMessage): Promise<void> {
        deliveredMessages.push(msg);
      },
      async sendAudio(): Promise<void> {
        throw new Error("Should not be called when synthesis fails");
      },
    };

    const mockUser: User = {
      id: "user-test",
      platform: "telegram",
      platformUserId: "tg-12345",
      displayName: "Alex",
      timezone: "UTC",
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
      responseMode: "voice", // user explicitly requested voice
      voiceEnabled: true,
      voiceName: null,
      voiceLanguage: "en",
      createdAt: new Date().toISOString(),
    };

    const deliveryResult = await responsePolicyService.deliverResponse(
      mockAdapter,
      mockUser,
      {
        userId: "tg-12345",
        text: "Your exam is tomorrow at 9 AM.",
      },
      "voice"
    );

    assert.strictEqual(deliveryResult.deliveredAs, "text");
    assert.strictEqual(deliveryResult.fallbackUsed, true);
    assert.strictEqual(deliveredMessages.length, 1);
    assert.strictEqual(deliveredMessages[0].text, "Your exam is tomorrow at 9 AM.");
  });
});
