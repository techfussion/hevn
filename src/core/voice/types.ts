/**
 * Domain types and contracts for voice ingestion and transcription.
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
  error?: "too_long" | "too_large" | "unsupported_format" | "empty_transcript" | "download_error" | "transcription_error";
  userMessage?: string;
}
