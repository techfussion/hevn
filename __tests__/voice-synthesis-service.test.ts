import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AudioSynthesisService } from "../src/core/voice/AudioSynthesisService";
import { VoiceMetricsService } from "../src/core/voice/VoiceMetricsService";
import type { AudioSynthesisProvider, AudioSynthesisOptions, SynthesizedAudio } from "../src/core/voice/types";

class MockAudioSynthesisProvider implements AudioSynthesisProvider {
  readonly providerName = "mock-tts";
  public callCount = 0;
  public lastText?: string;
  public lastOptions?: AudioSynthesisOptions;
  public shouldThrow = false;
  public shouldTimeout = false;
  public mockAudioBuffer = Buffer.from("RIFF_WAV_AUDIO_BYTES");
  public mockMimeType = "audio/mpeg";

  async synthesize(text: string, options?: AudioSynthesisOptions): Promise<SynthesizedAudio> {
    this.callCount++;
    this.lastText = text;
    this.lastOptions = options;

    if (this.shouldThrow) {
      throw new Error("Provider rate limit / internal error");
    }

    if (this.shouldTimeout) {
      await new Promise((r) => setTimeout(r, 150)); // simulate delay exceeding short timeout
    }

    return {
      buffer: this.mockAudioBuffer,
      mimeType: this.mockMimeType,
      durationSeconds: 3.5,
      provider: this.providerName,
    };
  }
}

describe("Voice Synthesis — AudioSynthesisService", () => {
  it("successfully synthesizes valid text and emits telemetry events", async () => {
    const provider = new MockAudioSynthesisProvider();
    const metrics = VoiceMetricsService.getInstance();
    metrics.resetMetrics();

    const service = new AudioSynthesisService(provider, undefined, metrics);

    const result = await service.synthesize("Done. I will remind you tomorrow at 3 PM.", {
      voiceId: "rachel_preset",
      language: "en",
    }, "user-123");

    assert.equal(result.success, true);
    assert.ok(result.audio);
    assert.equal(result.audio.provider, "mock-tts");
    assert.equal(result.audio.mimeType, "audio/mpeg");
    assert.equal(provider.callCount, 1);
    assert.equal(provider.lastText, "Done. I will remind you tomorrow at 3 PM.");

    const metricValues = metrics.getMetrics();
    assert.equal(metricValues.voiceSynthesisRequests, 1);
    assert.equal(metricValues.voiceSynthesisSuccesses, 1);
    assert.equal(metricValues.voiceSynthesisFailures, 0);
  });

  it("rejects empty or whitespace-only text without calling provider", async () => {
    const provider = new MockAudioSynthesisProvider();
    const service = new AudioSynthesisService(provider);

    const result = await service.synthesize("    \n\t   ");
    assert.equal(result.success, false);
    assert.equal(result.error, "empty_text");
    assert.equal(provider.callCount, 0);
  });

  it("rejects text exceeding maximum allowed text length limit (1500 chars)", async () => {
    const provider = new MockAudioSynthesisProvider();
    const metrics = VoiceMetricsService.getInstance();
    metrics.resetMetrics();
    const service = new AudioSynthesisService(provider, {
      maxTextLength: 100,
      maxAutoVoiceLength: 50,
      timeoutMs: 5000,
      maxRetries: 2,
      cacheTtlMs: 60000,
      maxCacheEntries: 50,
    }, metrics);

    const longText = "a".repeat(150);
    const result = await service.synthesize(longText);

    assert.equal(result.success, false);
    assert.equal(result.error, "text_too_long");
    assert.match(result.errorMessage ?? "", /exceeds maximum limit/i);
    assert.equal(provider.callCount, 0);

    const metricValues = metrics.getMetrics();
    assert.equal(metricValues.voiceSynthesisFailures, 1);
  });

  it("handles provider failure gracefully and emits failure metric", async () => {
    const provider = new MockAudioSynthesisProvider();
    provider.shouldThrow = true;
    const metrics = VoiceMetricsService.getInstance();
    metrics.resetMetrics();
    const service = new AudioSynthesisService(provider, undefined, metrics);

    const result = await service.synthesize("Meeting summary for tomorrow.");

    assert.equal(result.success, false);
    assert.equal(result.error, "provider_error");
    assert.match(result.errorMessage ?? "", /rate limit \/ internal error/i);

    const metricValues = metrics.getMetrics();
    assert.equal(metricValues.voiceSynthesisRequests, 1);
    assert.equal(metricValues.voiceSynthesisSuccesses, 0);
    assert.equal(metricValues.voiceSynthesisFailures, 1);
  });

  it("handles synthesis timeout gracefully and updates timeout metrics", async () => {
    const provider = new MockAudioSynthesisProvider();
    provider.shouldTimeout = true;
    const metrics = VoiceMetricsService.getInstance();
    metrics.resetMetrics();

    const service = new AudioSynthesisService(provider, {
      maxTextLength: 1500,
      maxAutoVoiceLength: 500,
      timeoutMs: 20, // 20ms timeout for test
      maxRetries: 2,
      cacheTtlMs: 60000,
      maxCacheEntries: 50,
    }, metrics);

    const result = await service.synthesize("Check on project report.");

    assert.equal(result.success, false);
    assert.equal(result.error, "timeout");

    const metricValues = metrics.getMetrics();
    assert.equal(metricValues.voiceSynthesisFailures, 1);
    assert.equal(metricValues.synthesisTimeoutCount, 1);
  });

  it("caches synthesized audio in-memory and avoids repeated provider calls for identical input", async () => {
    const provider = new MockAudioSynthesisProvider();
    const service = new AudioSynthesisService(provider);

    const text = "Welcome back! What are we working on today?";

    // First call: calls provider
    const res1 = await service.synthesize(text, { voiceId: "claire" });
    assert.equal(res1.success, true);
    assert.equal(provider.callCount, 1);
    assert.equal(res1.audio?.cached, undefined);

    // Second call: served from in-memory cache
    const res2 = await service.synthesize(text, { voiceId: "claire" });
    assert.equal(res2.success, true);
    assert.equal(provider.callCount, 1); // call count does not increment!
    assert.equal(res2.audio?.cached, true);

    // Third call with different voiceId: calls provider
    const res3 = await service.synthesize(text, { voiceId: "scott" });
    assert.equal(res3.success, true);
    assert.equal(provider.callCount, 2);
  });
});
