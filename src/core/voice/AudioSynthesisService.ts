import crypto from "crypto";
import { logger } from "../../utils/logger";
import { VoiceMetricsService } from "./VoiceMetricsService";
import { CircuitBreaker } from "./CircuitBreaker";
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

export interface ProviderHealthMetrics {
  providerName: string;
  circuitState: "CLOSED" | "OPEN" | "HALF_OPEN";
  totalRequests: number;
  successCount: number;
  failureCount: number;
  lastFailureTimestamp: number | null;
  lastError: string | null;
  averageLatencyMs: number;
}

export class AudioSynthesisService {
  private cache: Map<string, CacheEntry> = new Map();
  private metricsService: VoiceMetricsService;
  private providers: AudioSynthesisProvider[] = [];
  private circuitBreakers: Map<string, CircuitBreaker> = new Map();
  private healthStats: Map<
    string,
    {
      totalRequests: number;
      successCount: number;
      failureCount: number;
      totalLatencyMs: number;
      lastFailureTimestamp: number | null;
      lastError: string | null;
    }
  > = new Map();

  constructor(
    providers: AudioSynthesisProvider | AudioSynthesisProvider[],
    private limits: AudioSynthesisLimits = DEFAULT_SYNTHESIS_LIMITS,
    metricsService?: VoiceMetricsService
  ) {
    this.providers = Array.isArray(providers) ? providers : [providers];
    this.metricsService = metricsService || VoiceMetricsService.getInstance();

    for (const provider of this.providers) {
      this.circuitBreakers.set(
        provider.providerName,
        new CircuitBreaker({
          name: provider.providerName,
          failureThreshold: 3,
          coolDownMs: 30000,
        })
      );
      this.healthStats.set(provider.providerName, {
        totalRequests: 0,
        successCount: 0,
        failureCount: 0,
        totalLatencyMs: 0,
        lastFailureTimestamp: null,
        lastError: null,
      });
    }
  }

  /**
   * Synthesizes text into outbound audio with multi-provider pool failover,
   * per-provider circuit breaking, in-memory caching/deduplication, timeout protection,
   * and structured telemetry emission.
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
        provider: this.providers[0]?.providerName || "unknown",
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
      logger.debug({ correlationId, provider: cachedEntry.audio.provider }, "Audio synthesis cache hit");
      const cachedAudio: SynthesizedAudio = {
        ...cachedEntry.audio,
        cached: true,
      };

      this.metricsService.emitEvent({
        eventType: "voice.synthesis.success",
        userId,
        provider: cachedAudio.provider,
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

    if (this.providers.length === 0) {
      return {
        success: false,
        error: "unsupported",
        errorMessage: "No audio synthesis providers configured",
      };
    }

    // 4. Iterate through provider pool with circuit breaking & failover
    const errors: string[] = [];

    for (let i = 0; i < this.providers.length; i++) {
      const provider = this.providers[i];
      const cb = this.circuitBreakers.get(provider.providerName)!;
      const stats = this.healthStats.get(provider.providerName)!;

      // Check circuit breaker status
      if (cb.getState() === "OPEN") {
        logger.warn(
          { provider: provider.providerName, correlationId },
          "Skipping audio provider: circuit breaker is OPEN"
        );
        errors.push(`${provider.providerName}: circuit breaker is OPEN`);
        continue;
      }

      const startTime = Date.now();
      stats.totalRequests += 1;

      this.metricsService.emitEvent({
        eventType: "voice.synthesis.started",
        userId,
        provider: provider.providerName,
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

        // Execute provider with CircuitBreaker wrapper
        const audio = await cb.execute(() =>
          Promise.race([
            provider.synthesize(trimmed, options),
            timeoutPromise,
          ])
        );

        const durationMs = Date.now() - startTime;
        stats.successCount += 1;
        stats.totalLatencyMs += durationMs;

        // Store in LRU cache
        this.setCache(cacheKey, audio);

        this.metricsService.emitEvent({
          eventType: "voice.synthesis.success",
          userId,
          provider: provider.providerName,
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
          err instanceof Error &&
          (err.name === "SynthesisTimeoutError" ||
            err.name === "HttpTimeoutError" ||
            err.message.includes("timed out"));

        const errorMessage = err instanceof Error ? err.message : String(err);
        stats.failureCount += 1;
        stats.lastFailureTimestamp = Date.now();
        stats.lastError = errorMessage;
        errors.push(`${provider.providerName}: ${errorMessage}`);

        logger.warn(
          {
            err,
            provider: provider.providerName,
            durationMs,
            poolIndex: i,
            poolSize: this.providers.length,
            isTimeout,
            correlationId,
          },
          "Audio synthesis failed in provider — attempting failover"
        );

        const nextProvider = this.providers[i + 1];
        if (nextProvider) {
          this.metricsService.emitEvent({
            eventType: "voice.provider.failover",
            userId,
            provider: provider.providerName,
            error: errorMessage,
            correlationId,
          });
        }
      }
    }

    // All providers exhausted in pool
    const combinedError = errors.join(" | ");
    const isTimeout = errors.some(
      (e) =>
        e.includes("timed out") ||
        e.includes("SynthesisTimeoutError") ||
        e.includes("HttpTimeoutError")
    );
    const errorCategory = isTimeout ? "timeout" : "provider_error";

    logger.error(
      { errors, textLength: trimmed.length, correlationId, userId, isTimeout },
      "All audio synthesis providers in pool failed — degrading to text fallback"
    );

    this.metricsService.emitEvent({
      eventType: "voice.synthesis.failure",
      userId,
      provider: this.providers.length === 1 ? this.providers[0].providerName : "pool_exhausted",
      durationMs: 0,
      textLength: trimmed.length,
      error: combinedError,
      errorCategory,
      correlationId,
    });

    return {
      success: false,
      error: errorCategory,
      errorMessage: `All audio synthesis providers failed: ${combinedError}`,
    };
  }

  /**
   * Returns current health statistics and circuit breaker states for all providers.
   */
  getProviderHealth(): ProviderHealthMetrics[] {
    return this.providers.map((p) => {
      const cb = this.circuitBreakers.get(p.providerName)!;
      const stats = this.healthStats.get(p.providerName)!;
      const avgLatency =
        stats.successCount > 0
          ? Math.round(stats.totalLatencyMs / stats.successCount)
          : 0;

      return {
        providerName: p.providerName,
        circuitState: cb.getState(),
        totalRequests: stats.totalRequests,
        successCount: stats.successCount,
        failureCount: stats.failureCount,
        lastFailureTimestamp: stats.lastFailureTimestamp,
        lastError: stats.lastError,
        averageLatencyMs: avgLatency,
      };
    });
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
    if (this.cache.size >= this.limits.maxCacheEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }
    this.cache.set(key, { audio, cachedAt: Date.now() });
  }
}
