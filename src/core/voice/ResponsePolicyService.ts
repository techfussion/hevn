import { logger } from "../../utils/logger";
import { VoiceMetricsService } from "./VoiceMetricsService";
import { AudioSynthesisService } from "./AudioSynthesisService";
import type { MessagingAdapter, OutboundAudio } from "../../adapters/MessagingAdapter";
import type { User, OutboundMessage } from "../../types/domain";
import type { AudioSynthesisLimits } from "./types";
import { DEFAULT_SYNTHESIS_LIMITS } from "./types";

export interface DeliveryContext {
  inputWasAudio?: boolean;
  correlationId?: string;
  forceVoice?: boolean;
  forceText?: boolean;
}

export interface DeliveryResult {
  deliveredAs: "text" | "voice";
  fallbackUsed: boolean;
  error?: string;
}

export class ResponsePolicyService {
  private metricsService: VoiceMetricsService;

  constructor(
    private audioSynthesisService?: AudioSynthesisService,
    private limits: AudioSynthesisLimits = DEFAULT_SYNTHESIS_LIMITS,
    metricsService?: VoiceMetricsService
  ) {
    this.metricsService = metricsService || VoiceMetricsService.getInstance();
  }

  /**
   * Evaluates the response policy and delivers either audio or text through the adapter.
   * Handles channel capability checks, user preferences, synthesis, and automatic text fallback.
   */
  async deliverResponse(
    adapter: MessagingAdapter,
    user: User,
    message: OutboundMessage,
    context?: DeliveryContext
  ): Promise<DeliveryResult> {
    const correlationId = context?.correlationId;
    const shouldAttemptVoice = this.shouldAttemptVoiceOutput(adapter, user, message.text, context);

    if (!shouldAttemptVoice || !this.audioSynthesisService || !adapter.sendAudio) {
      await adapter.sendMessage(message);
      return { deliveredAs: "text", fallbackUsed: false };
    }

    // Attempt voice synthesis
    const synthesisResult = await this.audioSynthesisService.synthesize(
      message.text,
      {
        voiceId: user.voiceName || undefined,
        language: user.voiceLanguage || undefined,
        correlationId,
      },
      user.id
    );

    if (!synthesisResult.success || !synthesisResult.audio) {
      logger.warn(
        {
          userId: user.id,
          platform: adapter.platformName,
          error: synthesisResult.error,
          correlationId,
        },
        "Voice synthesis failed or skipped — falling back to text message"
      );

      this.metricsService.emitEvent({
        eventType: "voice.delivery.fallback_text",
        userId: user.id,
        platform: adapter.platformName,
        error: synthesisResult.errorMessage,
        errorCategory: synthesisResult.error,
        correlationId,
      });

      await adapter.sendMessage(message);
      return {
        deliveredAs: "text",
        fallbackUsed: true,
        error: synthesisResult.errorMessage,
      };
    }

    // Prepare outbound audio payload
    const outboundAudio: OutboundAudio = {
      userId: message.userId,
      buffer: synthesisResult.audio.buffer,
      mimeType: synthesisResult.audio.mimeType,
      durationSeconds: synthesisResult.audio.durationSeconds,
      caption: message.text.length <= 200 ? message.text : undefined,
      buttons: message.buttons,
      correlationId,
    };

    // Attempt audio delivery to channel adapter
    this.metricsService.emitEvent({
      eventType: "voice.delivery.started",
      userId: user.id,
      platform: adapter.platformName,
      audioSizeBytes: outboundAudio.buffer.length,
      correlationId,
    });

    try {
      await adapter.sendAudio(outboundAudio);

      this.metricsService.emitEvent({
        eventType: "voice.delivery.success",
        userId: user.id,
        platform: adapter.platformName,
        audioSizeBytes: outboundAudio.buffer.length,
        correlationId,
      });

      return { deliveredAs: "voice", fallbackUsed: false };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(
        { err, userId: user.id, platform: adapter.platformName, correlationId },
        "Channel audio delivery failed — falling back to text delivery"
      );

      this.metricsService.emitEvent({
        eventType: "voice.delivery.failure",
        userId: user.id,
        platform: adapter.platformName,
        error: errMsg,
        correlationId,
      });

      this.metricsService.emitEvent({
        eventType: "voice.delivery.fallback_text",
        userId: user.id,
        platform: adapter.platformName,
        error: errMsg,
        correlationId,
      });

      await adapter.sendMessage(message);
      return {
        deliveredAs: "text",
        fallbackUsed: true,
        error: errMsg,
      };
    }
  }

  /**
   * Deterministic decision function for whether outbound voice should be attempted.
   */
  shouldAttemptVoiceOutput(
    adapter: MessagingAdapter,
    user: User,
    text: string,
    context?: DeliveryContext
  ): boolean {
    if (context?.forceText) return false;
    if (context?.forceVoice) {
      return Boolean(adapter.capabilities?.audioOutput && adapter.sendAudio);
    }

    // 1. Channel capability check
    if (!adapter.capabilities?.audioOutput || typeof adapter.sendAudio !== "function") {
      return false;
    }

    // 2. User preference check
    if (!user.voiceEnabled) {
      return false;
    }

    const mode = user.responseMode || "auto";

    if (mode === "text") {
      return false;
    }

    const textLength = text.trim().length;

    if (mode === "voice") {
      // In explicit voice mode, attempt voice unless message exceeds hard maximum length
      return textLength <= this.limits.maxTextLength;
    }

    // 3. Auto mode: deliver voice if incoming message was audio AND length is within auto threshold
    if (mode === "auto") {
      const inputWasAudio = Boolean(context?.inputWasAudio);
      return inputWasAudio && textLength <= this.limits.maxAutoVoiceLength;
    }

    return false;
  }
}
