/**
 * Domain types and contracts for voice ingestion, transcription, outbound synthesis, and response policy.
 */

export interface IncomingAudio {
  mediaId: string;
  mimeType?: string;
  durationSeconds?: number;
  fileSizeBytes?: number;
}

export interface TranscriptionResult {
  transcript: string;
  language?: string;
  durationSeconds?: number;
  provider: string;
}

export interface AudioValidationLimits {
  maxDurationSeconds: number;
  maxFileSizeBytes: number;
  supportedMimeTypes: string[];
  transcriptionTimeoutMs: number;
}

export const DEFAULT_AUDIO_LIMITS: AudioValidationLimits = {
  maxDurationSeconds: 180, // 3 minutes maximum
  maxFileSizeBytes: 20 * 1024 * 1024, // 20 MB maximum
  supportedMimeTypes: [
    "audio/ogg",
    "audio/oga",
    "audio/opus",
    "audio/mp3",
    "audio/mpeg",
    "audio/wav",
    "audio/x-wav",
    "audio/m4a",
    "audio/x-m4a",
    "audio/aac",
    "audio/mp4",
    "audio/webm",
  ],
  transcriptionTimeoutMs: 15000, // 15 seconds timeout
};

export interface TranscriptionProvider {
  readonly providerName: string;
  transcribe(audioBuffer: Buffer, mimeType: string): Promise<TranscriptionResult>;
}

export interface AudioProcessResult {
  success: boolean;
  transcript?: string;
  error?:
    | "too_long"
    | "too_large"
    | "unsupported_format"
    | "empty_transcript"
    | "download_error"
    | "transcription_error";
  userMessage?: string;
}

// -------------------------------------------------------------
// Outbound Audio Synthesis (TTS) Contracts & Options
// -------------------------------------------------------------

export interface AudioSynthesisOptions {
  voiceId?: string;
  voiceName?: string;
  language?: string;
  speakingRate?: number;
  outputFormat?: "mp3" | "opus" | "ogg" | "wav";
  correlationId?: string;
}

export interface SynthesizedAudio {
  buffer: Buffer;
  mimeType: string;
  durationSeconds?: number;
  provider: string;
  cached?: boolean;
}

export interface AudioSynthesisLimits {
  maxTextLength: number; // Hard max text characters allowed for any synthesis (e.g. 1500)
  maxAutoVoiceLength: number; // Max text characters for automatic voice replies in auto mode (e.g. 500)
  timeoutMs: number; // Timeout per provider request
  maxRetries: number; // Max retries for transient provider failures
  cacheTtlMs: number; // Cache TTL for identical text synthesis
  maxCacheEntries: number; // Max LRU cache entries
}

export const DEFAULT_SYNTHESIS_LIMITS: AudioSynthesisLimits = {
  maxTextLength: 1500,
  maxAutoVoiceLength: 500,
  timeoutMs: 10000, // 10s
  maxRetries: 2,
  cacheTtlMs: 10 * 60 * 1000, // 10 minutes
  maxCacheEntries: 100,
};

export interface AudioSynthesisProvider {
  readonly providerName: string;
  synthesize(text: string, options?: AudioSynthesisOptions): Promise<SynthesizedAudio>;
}

export interface AudioSynthesisResult {
  success: boolean;
  audio?: SynthesizedAudio;
  error?: "text_too_long" | "empty_text" | "timeout" | "provider_error" | "rate_limited" | "unsupported";
  errorMessage?: string;
}

// -------------------------------------------------------------
// Response Policy & Telemetry Types
// -------------------------------------------------------------

export type VoiceTelemetryEventType =
  | "voice.synthesis.started"
  | "voice.synthesis.success"
  | "voice.synthesis.failure"
  | "voice.delivery.started"
  | "voice.delivery.success"
  | "voice.delivery.failure"
  | "voice.delivery.fallback_text";

export interface VoiceTelemetryEvent {
  eventType: VoiceTelemetryEventType;
  userId?: string;
  provider?: string;
  platform?: "telegram" | "whatsapp" | string;
  durationMs?: number;
  textLength?: number;
  audioSizeBytes?: number;
  cached?: boolean;
  error?: string;
  errorCategory?: string;
  correlationId?: string;
  timestamp?: string;
}

export interface VoiceMetrics {
  voiceSynthesisRequests: number;
  voiceSynthesisSuccesses: number;
  voiceSynthesisFailures: number;
  voiceDeliverySuccesses: number;
  voiceDeliveryFailures: number;
  voiceTextFallbacks: number;
  averageSynthesisLatency: number;
  synthesisTimeoutCount: number;
}

