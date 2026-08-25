import { logger } from "../../utils/logger";
import type { VoiceTelemetryEvent, VoiceMetrics } from "./types";

export class VoiceMetricsService {
  private static instance: VoiceMetricsService;

  private synthesisRequests = 0;
  private synthesisSuccesses = 0;
  private synthesisFailures = 0;
  private deliverySuccesses = 0;
  private deliveryFailures = 0;
  private textFallbacks = 0;
  private totalSynthesisDurationMs = 0;
  private synthesisCountForAvg = 0;
  private timeoutCount = 0;

  private constructor() {}

  static getInstance(): VoiceMetricsService {
    if (!VoiceMetricsService.instance) {
      VoiceMetricsService.instance = new VoiceMetricsService();
    }
    return VoiceMetricsService.instance;
  }

  emitEvent(event: VoiceTelemetryEvent): void {
    const timestamp = event.timestamp || new Date().toISOString();
    const enrichedEvent = { ...event, timestamp };

    // Update internal deterministic metrics counters
    switch (event.eventType) {
      case "voice.synthesis.started":
        this.synthesisRequests++;
        break;

      case "voice.synthesis.success":
        this.synthesisSuccesses++;
        if (typeof event.durationMs === "number" && event.durationMs >= 0) {
          this.totalSynthesisDurationMs += event.durationMs;
          this.synthesisCountForAvg++;
        }
        break;

      case "voice.synthesis.failure":
        this.synthesisFailures++;
        if (event.errorCategory === "timeout") {
          this.timeoutCount++;
        }
        break;

      case "voice.delivery.success":
        this.deliverySuccesses++;
        break;

      case "voice.delivery.failure":
        this.deliveryFailures++;
        break;

      case "voice.delivery.fallback_text":
        this.textFallbacks++;
        break;
    }

    // Log safely without sensitive tokens or full audio content
    logger.info(
      {
        eventType: enrichedEvent.eventType,
        provider: enrichedEvent.provider,
        platform: enrichedEvent.platform,
        userId: enrichedEvent.userId,
        durationMs: enrichedEvent.durationMs,
        textLength: enrichedEvent.textLength,
        audioSizeBytes: enrichedEvent.audioSizeBytes,
        cached: enrichedEvent.cached,
        errorCategory: enrichedEvent.errorCategory,
        correlationId: enrichedEvent.correlationId,
      },
      `Voice telemetry event: ${enrichedEvent.eventType}`
    );
  }

  getMetrics(): VoiceMetrics {
    const averageSynthesisLatency =
      this.synthesisCountForAvg > 0
        ? Math.round(this.totalSynthesisDurationMs / this.synthesisCountForAvg)
        : 0;

    return {
      voiceSynthesisRequests: this.synthesisRequests,
      voiceSynthesisSuccesses: this.synthesisSuccesses,
      voiceSynthesisFailures: this.synthesisFailures,
      voiceDeliverySuccesses: this.deliverySuccesses,
      voiceDeliveryFailures: this.deliveryFailures,
      voiceTextFallbacks: this.textFallbacks,
      averageSynthesisLatency,
      synthesisTimeoutCount: this.timeoutCount,
    };
  }

  resetMetrics(): void {
    this.synthesisRequests = 0;
    this.synthesisSuccesses = 0;
    this.synthesisFailures = 0;
    this.deliverySuccesses = 0;
    this.deliveryFailures = 0;
    this.textFallbacks = 0;
    this.totalSynthesisDurationMs = 0;
    this.synthesisCountForAvg = 0;
    this.timeoutCount = 0;
  }
}
