import { fetchWithRetry } from "../../../utils/http";
import { logger } from "../../../utils/logger";
import type { AudioSynthesisProvider, AudioSynthesisOptions, SynthesizedAudio } from "../types";

export interface ElevenLabsConfig {
  apiKey: string;
  defaultVoiceId?: string;
  modelId?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

export class ElevenLabsSynthesisProvider implements AudioSynthesisProvider {
  readonly providerName = "elevenlabs" as const;
  private apiKey: string;
  private defaultVoiceId: string;
  private modelId: string;
  private timeoutMs: number;
  private maxRetries: number;

  constructor(config: ElevenLabsConfig) {
    if (!config.apiKey) {
      throw new Error("API key is required for ElevenLabsSynthesisProvider.");
    }
    this.apiKey = config.apiKey;
    this.defaultVoiceId = config.defaultVoiceId || "21m00Tcm4TlvDq8ikWAM"; // Rachel / standard default
    this.modelId = config.modelId || "eleven_multilingual_v2";
    this.timeoutMs = config.timeoutMs ?? 10000;
    this.maxRetries = config.maxRetries ?? 2;
  }

  async synthesize(text: string, options?: AudioSynthesisOptions): Promise<SynthesizedAudio> {
    const voiceId = options?.voiceId || this.defaultVoiceId;
    const outputFormat = options?.outputFormat === "opus" ? "opus_16000" : "mp3_44100_128";
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${outputFormat}`;

    const body = {
      text,
      model_id: this.modelId,
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
      },
    };

    const res = await fetchWithRetry(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "xi-api-key": this.apiKey,
        Accept: options?.outputFormat === "opus" ? "audio/opus" : "audio/mpeg",
      },
      body: JSON.stringify(body),
      timeoutMs: this.timeoutMs,
      maxRetries: this.maxRetries,
    });

    if (!res.ok) {
      const errText = await res.text();
      logger.error(
        { status: res.status, provider: this.providerName, voiceId },
        "ElevenLabs synthesis request returned non-OK status"
      );
      throw new Error(`ElevenLabs synthesis failed (${res.status}): ${errText.slice(0, 200)}`);
    }

    const arrayBuffer = await res.arrayBuffer();
    const mimeType = options?.outputFormat === "opus" ? "audio/opus" : "audio/mpeg";

    return {
      buffer: Buffer.from(arrayBuffer),
      mimeType,
      provider: this.providerName,
    };
  }
}
