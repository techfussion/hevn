import crypto from "crypto";
import { logger } from "../../utils/logger";
import { VoiceMetricsService } from "./VoiceMetricsService";
import type {
  AudioSynthesisProvider,
  AudioSynthesisOptions,
  AudioSynthesisResult,
  AudioSynthesisLimits,
  SynthesizedAudio,
} from "./types";
import { DEFAULT_SYNTHESIS_LIMITS } from "./types";

interface CacheEntry {
  audio: SynthesizedAudio;
  cachedAt: number;
}

export class AudioSynthesisService {
  private cache: Map<string, CacheEntry> = new Map();
  private metricsService: VoiceMetricsService;

  constructor(
    private provider: AudioSynthesisProvider,
    private limits: AudioSynthesisLimits = DEFAULT_SYNTHESIS_LIMITS,
    metricsService?: VoiceMetricsService
  ) {
    this.metricsService = metricsService || VoiceMetricsService.getInstance();
  }

  /**
   * Synthesizes text into outbound audio.
   * Handles text validation, in-memory caching/deduplication, timeout protection,
   * error normalization, and structured telemetry emission.
   */
  async synthesize(
    text: string,
    options?: AudioSynthesisOptions,
    userId?: string
  ): Promise<AudioSynthesisResult> {
    const correlationId = options?.correlationId;
    const trimmed = text.trim();

    // 1. Validation: Empty check
    if (!trimmed) {
      logger.warn({ correlationId, userId }, "Audio synthesis rejected: text is empty");
      return {
        success: false,
        error: "empty_text",
        errorMessage: "Cannot synthesize empty text",
      };
    }

    // 2. Validation: Maximum text length check
    if (trimmed.length > this.limits.maxTextLength) {
      logger.warn(
        { textLength: trimmed.length, max: this.limits.maxTextLength, correlationId, userId },
        "Audio synthesis rejected: text exceeds maximum length limit"
      );
      this.metricsService.emitEvent({
        eventType: "voice.synthesis.failure",
        userId,
        provider: this.provider.providerName,
        textLength: trimmed.length,
        error: "text_too_long",
        errorCategory: "validation",
        correlationId,
      });
      return {
        success: false,
        error: "text_too_long",
        errorMessage: `Text length (${trimmed.length}) exceeds maximum limit (${this.limits.maxTextLength})`,
      };
    }

    // 3. Cache lookup (deduplication)
    const cacheKey = this.computeCacheKey(trimmed, options);
    const cachedEntry = this.cache.get(cacheKey);
    const now = Date.now();

    if (cachedEntry && now - cachedEntry.cachedAt < this.limits.cacheTtlMs) {
      logger.debug({ correlationId, provider: this.provider.providerName }, "Audio synthesis cache hit");
      const cachedAudio: SynthesizedAudio = {
        ...cachedEntry.audio,
        cached: true,
      };

      this.metricsService.emitEvent({
        eventType: "voice.synthesis.success",
        userId,
        provider: this.provider.providerName,
        durationMs: 0,
        textLength: trimmed.length,
        audioSizeBytes: cachedAudio.buffer.length,
        cached: true,
        correlationId,
      });

      return {
        success: true,
        audio: cachedAudio,
      };
    }

    // 4. Perform synthesis with timeout and metrics
    const startTime = Date.now();
    this.metricsService.emitEvent({
      eventType: "voice.synthesis.started",
      userId,
      provider: this.provider.providerName,
      textLength: trimmed.length,
      correlationId,
    });

    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        const timer = setTimeout(() => {
          const timeoutErr = new Error(`Audio synthesis timed out after ${this.limits.timeoutMs}ms`);
          timeoutErr.name = "SynthesisTimeoutError";
          reject(timeoutErr);
        }, this.limits.timeoutMs);
        if (typeof timer.unref === "function") {
          timer.unref();
        }
      });

      const audio = await Promise.race([
        this.provider.synthesize(trimmed, options),
        timeoutPromise,
      ]);

      const durationMs = Date.now() - startTime;

      // 5. Store in LRU cache
      this.setCache(cacheKey, audio);

      this.metricsService.emitEvent({
        eventType: "voice.synthesis.success",
        userId,
        provider: this.provider.providerName,
        durationMs,
        textLength: trimmed.length,
        audioSizeBytes: audio.buffer.length,
        cached: false,
        correlationId,
      });

      return {
        success: true,
        audio,
      };
    } catch (err: unknown) {
      const durationMs = Date.now() - startTime;
      const isTimeout =
        (err instanceof Error && (err.name === "SynthesisTimeoutError" || err.name === "HttpTimeoutError" || err.message.includes("timed out")));

      const errorCategory = isTimeout ? "timeout" : "provider_error";
      const errorMessage = err instanceof Error ? err.message : String(err);

      logger.error(
        {
          err,
          provider: this.provider.providerName,
          durationMs,
          textLength: trimmed.length,
          isTimeout,
          correlationId,
        },
        "Audio synthesis failed in provider"
      );

      this.metricsService.emitEvent({
        eventType: "voice.synthesis.failure",
        userId,
        provider: this.provider.providerName,
        durationMs,
        textLength: trimmed.length,
        error: errorMessage,
        errorCategory,
        correlationId,
      });

      return {
        success: false,
        error: isTimeout ? "timeout" : "provider_error",
        errorMessage,
      };
    }
  }

  clearCache(): void {
    this.cache.clear();
  }

  private computeCacheKey(text: string, options?: AudioSynthesisOptions): string {
    const keyData = [
      text,
      options?.voiceId || options?.voiceName || "default",
      options?.language || "en",
      options?.outputFormat || "default",
      options?.speakingRate || 1.0,
    ].join("::");

    return crypto.createHash("sha256").update(keyData).digest("hex");
  }

  private setCache(key: string, audio: SynthesizedAudio): void {
    // Evict oldest entries if cache exceeds max size
    if (this.cache.size >= this.limits.maxCacheEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }
    this.cache.set(key, { audio, cachedAt: Date.now() });
  }
}
