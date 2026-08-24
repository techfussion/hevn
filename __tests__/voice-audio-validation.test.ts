import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AudioIngestionService } from "../src/core/voice/AudioIngestionService";
import type { TranscriptionProvider, TranscriptionResult } from "../src/core/voice/types";
import type { MessagingAdapter, IncomingMessage } from "../src/adapters/MessagingAdapter";
import type { OutboundMessage } from "../src/types/domain";

class MockTranscriptionProvider implements TranscriptionProvider {
  readonly providerName = "mock-provider";
  public mockTranscript = "Remind me to finish report";
  public shouldTimeout = false;
  public shouldThrow = false;
  public callCount = 0;

  async transcribe(_audioBuffer: Buffer, _mimeType: string): Promise<TranscriptionResult> {
    this.callCount++;
    if (this.shouldThrow) {
      throw new Error("Provider internal failure");
    }
    if (this.shouldTimeout) {
      await new Promise((r) => setTimeout(r, 100)); // wait past custom short timeout
    }
    return {
      transcript: this.mockTranscript,
      provider: this.providerName,
    };
  }
}

class MockAudioAdapter implements MessagingAdapter {
  readonly platformName = "telegram" as const;
  public downloadedBuffer: Buffer = Buffer.from("RIFF....WAVEfmt ");
  public shouldDownloadThrow = false;
  public lastDownloadedMediaId?: string;

  async sendMessage(_message: OutboundMessage): Promise<void> {}
  async sendTemplate(_userId: string, _template: string, _params: Record<string, string>): Promise<void> {}
  verifyWebhookSignature(_rawBody: string, _headers: Record<string, string | undefined>): boolean {
    return true;
  }
  parseIncomingWebhook(_payload: unknown): IncomingMessage | null {
    return null;
  }

  async downloadAudio(mediaId: string): Promise<{ buffer: Buffer; mimeType: string }> {
    this.lastDownloadedMediaId = mediaId;
    if (this.shouldDownloadThrow) {
      throw new Error("Network error downloading audio");
    }
    return {
      buffer: this.downloadedBuffer,
      mimeType: "audio/ogg",
    };
  }
}

describe("Voice Notes — Audio Ingestion & Validation", () => {
  it("rejects audio exceeding maximum duration limit (180 seconds)", async () => {
    const provider = new MockTranscriptionProvider();
    const service = new AudioIngestionService(provider);
    const adapter = new MockAudioAdapter();

    const result = await service.processAudioMessage(adapter, {
      mediaId: "voice_too_long_123",
      durationSeconds: 240, // 4 minutes
      mimeType: "audio/ogg",
    });

    assert.equal(result.success, false);
    assert.equal(result.error, "too_long");
    assert.match(result.userMessage ?? "", /too long/i);
    assert.equal(provider.callCount, 0); // provider should not be called
  });

  it("rejects audio exceeding maximum file size limit (20 MB)", async () => {
    const provider = new MockTranscriptionProvider();
    const service = new AudioIngestionService(provider);
    const adapter = new MockAudioAdapter();

    const result = await service.processAudioMessage(adapter, {
      mediaId: "voice_too_large_123",
      fileSizeBytes: 25 * 1024 * 1024, // 25 MB
      mimeType: "audio/ogg",
    });

    assert.equal(result.success, false);
    assert.equal(result.error, "too_large");
    assert.match(result.userMessage ?? "", /too large/i);
    assert.equal(provider.callCount, 0);
  });

  it("rejects unsupported MIME types", async () => {
    const provider = new MockTranscriptionProvider();
    const service = new AudioIngestionService(provider);
    const adapter = new MockAudioAdapter();

    const result = await service.processAudioMessage(adapter, {
      mediaId: "video_file_123",
      mimeType: "video/mp4",
    });

    assert.equal(result.success, false);
    assert.equal(result.error, "unsupported_format");
    assert.match(result.userMessage ?? "", /can't process that audio format/i);
    assert.equal(provider.callCount, 0);
  });

  it("handles platform download failures gracefully", async () => {
    const provider = new MockTranscriptionProvider();
    const service = new AudioIngestionService(provider);
    const adapter = new MockAudioAdapter();
    adapter.shouldDownloadThrow = true;

    const result = await service.processAudioMessage(adapter, {
      mediaId: "download_fail_123",
      mimeType: "audio/ogg",
    });

    assert.equal(result.success, false);
    assert.equal(result.error, "download_error");
    assert.match(result.userMessage ?? "", /couldn't download that voice note/i);
  });

  it("handles empty or inaudible audio transcripts gracefully", async () => {
    const provider = new MockTranscriptionProvider();
    provider.mockTranscript = "   "; // empty whitespace
    const service = new AudioIngestionService(provider);
    const adapter = new MockAudioAdapter();

    const result = await service.processAudioMessage(adapter, {
      mediaId: "silent_audio_123",
      mimeType: "audio/ogg",
    });

    assert.equal(result.success, false);
    assert.equal(result.error, "empty_transcript");
    assert.match(result.userMessage ?? "", /couldn't hear anything/i);
  });

  it("handles provider timeout gracefully", async () => {
    const provider = new MockTranscriptionProvider();
    provider.shouldTimeout = true;
    const service = new AudioIngestionService(provider, {
      maxDurationSeconds: 180,
      maxFileSizeBytes: 20 * 1024 * 1024,
      supportedMimeTypes: ["audio/ogg"],
      transcriptionTimeoutMs: 10, // short timeout for testing
    });
    const adapter = new MockAudioAdapter();

    const result = await service.processAudioMessage(adapter, {
      mediaId: "timeout_audio_123",
      mimeType: "audio/ogg",
    });

    assert.equal(result.success, false);
    assert.equal(result.error, "transcription_error");
    assert.match(result.userMessage ?? "", /couldn't make out that voice note/i);
  });

  it("successfully ingests and transcribes valid audio note", async () => {
    const provider = new MockTranscriptionProvider();
    provider.mockTranscript = "Remind me to study chapter four tomorrow at 2pm";
    const service = new AudioIngestionService(provider);
    const adapter = new MockAudioAdapter();

    const result = await service.processAudioMessage(adapter, {
      mediaId: "valid_voice_123",
      durationSeconds: 15,
      mimeType: "audio/ogg; codecs=opus",
      fileSizeBytes: 45000,
    });

    assert.equal(result.success, true);
    assert.equal(result.transcript, "Remind me to study chapter four tomorrow at 2pm");
    assert.equal(adapter.lastDownloadedMediaId, "valid_voice_123");
  });
});
