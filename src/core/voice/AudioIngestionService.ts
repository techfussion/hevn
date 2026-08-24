import type { MessagingAdapter } from "../../adapters/MessagingAdapter";
import type {
  IncomingAudio,
  AudioProcessResult,
  AudioValidationLimits,
  TranscriptionProvider,
} from "./types";
import { DEFAULT_AUDIO_LIMITS } from "./types";
import { logger } from "../../utils/logger";

export class AudioIngestionService {
  constructor(
    private transcriptionProvider: TranscriptionProvider,
    private limits: AudioValidationLimits = DEFAULT_AUDIO_LIMITS
  ) {}

  /**
   * Validates, downloads, and transcribes an incoming audio message.
   * Returns a structured result with normalized user text or a conversational error.
   */
  async processAudioMessage(
    adapter: MessagingAdapter,
    audio: IncomingAudio
  ): Promise<AudioProcessResult> {
    // 1. Validate duration if provided by metadata
    if (audio.durationSeconds && audio.durationSeconds > this.limits.maxDurationSeconds) {
      logger.warn(
        { durationSeconds: audio.durationSeconds, max: this.limits.maxDurationSeconds },
        "Incoming audio exceeds maximum duration"
      );
      return {
        success: false,
        error: "too_long",
        userMessage: `That voice note is a little too long (${Math.round(audio.durationSeconds)}s). Please send a shorter one (under 3 minutes).`,
      };
    }

    // 2. Validate file size if provided by metadata
    if (audio.fileSizeBytes && audio.fileSizeBytes > this.limits.maxFileSizeBytes) {
      logger.warn(
        { fileSizeBytes: audio.fileSizeBytes, max: this.limits.maxFileSizeBytes },
        "Incoming audio exceeds maximum file size"
      );
      return {
        success: false,
        error: "too_large",
        userMessage: "That audio file is too large. Please send a shorter voice note.",
      };
    }

    // 3. Validate MIME type if provided
    if (audio.mimeType) {
      const baseMime = audio.mimeType.split(";")[0].trim().toLowerCase();
      const isSupported = this.limits.supportedMimeTypes.some(
        (t) => t.toLowerCase() === baseMime || baseMime.startsWith("audio/")
      );
      if (!isSupported) {
        logger.warn({ mimeType: audio.mimeType }, "Unsupported audio MIME type");
        return {
          success: false,
          error: "unsupported_format",
          userMessage: "I can't process that audio format yet.",
        };
      }
    }

    // 4. Download audio buffer via provider-authenticated retrieval
    if (!adapter.downloadAudio) {
      logger.error({ platform: adapter.platformName }, "Adapter does not implement downloadAudio");
      return {
        success: false,
        error: "download_error",
        userMessage: "Voice message processing is not configured on this channel yet.",
      };
    }

    let audioBuffer: Buffer;
    let effectiveMime = audio.mimeType || "audio/ogg";

    try {
      const downloaded = await adapter.downloadAudio(audio.mediaId);
      audioBuffer = downloaded.buffer;
      if (downloaded.mimeType) {
        effectiveMime = downloaded.mimeType;
      }
    } catch (err) {
      logger.error({ err, mediaId: audio.mediaId, platform: adapter.platformName }, "Failed to download audio from platform");
      return {
        success: false,
        error: "download_error",
        userMessage: "I couldn't download that voice note. Could you try sending it again?",
      };
    }

    // Double-check downloaded buffer size against limits
    if (audioBuffer.length > this.limits.maxFileSizeBytes) {
      return {
        success: false,
        error: "too_large",
        userMessage: "That audio file is too large. Please send a shorter voice note.",
      };
    }

    // 5. Transcribe with timeout
    try {
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Transcription timeout")), this.limits.transcriptionTimeoutMs)
      );

      const result = await Promise.race([
        this.transcriptionProvider.transcribe(audioBuffer, effectiveMime),
        timeoutPromise,
      ]);

      const transcript = result.transcript.trim();

      if (!transcript) {
        logger.info({ mediaId: audio.mediaId }, "Transcription produced empty transcript");
        return {
          success: false,
          error: "empty_transcript",
          userMessage: "I couldn't hear anything in that voice note. Could you try sending it again or type your message?",
        };
      }

      return {
        success: true,
        transcript,
      };
    } catch (err) {
      logger.error({ err, mediaId: audio.mediaId }, "Audio transcription failed or timed out");
      return {
        success: false,
        error: "transcription_error",
        userMessage: "I couldn't make out that voice note. Could you try sending it again?",
      };
    }
  }
}
