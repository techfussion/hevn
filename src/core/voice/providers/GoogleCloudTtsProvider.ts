import { fetchWithRetry } from "../../../utils/http";
import { logger } from "../../../utils/logger";
import type { AudioSynthesisProvider, AudioSynthesisOptions, SynthesizedAudio } from "../types";

export interface GoogleCloudTtsOptions {
  apiKey: string;
  defaultLanguageCode?: string;
  defaultVoiceName?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

export class GoogleCloudTtsProvider implements AudioSynthesisProvider {
  readonly providerName = "google-cloud-tts" as const;
  private apiKey: string;
  private defaultLanguageCode: string;
  private defaultVoiceName: string;
  private timeoutMs: number;
  private maxRetries: number;

  constructor(options: GoogleCloudTtsOptions) {
    if (!options.apiKey) {
      throw new Error("API key is required for GoogleCloudTtsProvider.");
    }
    this.apiKey = options.apiKey;
    this.defaultLanguageCode = options.defaultLanguageCode || "en-US";
    this.defaultVoiceName = options.defaultVoiceName || "en-US-Journey-F";
    this.timeoutMs = options.timeoutMs ?? 10000;
    this.maxRetries = options.maxRetries ?? 2;
  }

  async synthesize(text: string, options?: AudioSynthesisOptions): Promise<SynthesizedAudio> {
    const url = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(this.apiKey)}`;

    const audioEncoding = options?.outputFormat === "opus" || options?.outputFormat === "ogg" ? "OGG_OPUS" : "MP3";
    const languageCode = options?.language || this.defaultLanguageCode;
    const voiceName = options?.voiceId || options?.voiceName || this.defaultVoiceName;

    const payload = {
      input: { text },
      voice: {
        languageCode,
        name: voiceName,
      },
      audioConfig: {
        audioEncoding,
        speakingRate: options?.speakingRate ?? 1.0,
      },
    };

    const res = await fetchWithRetry(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      timeoutMs: this.timeoutMs,
      maxRetries: this.maxRetries,
    });

    if (!res.ok) {
      const errText = await res.text();
      logger.error(
        { status: res.status, provider: this.providerName },
        "Google Cloud TTS request failed"
      );
      throw new Error(`Google Cloud TTS synthesis failed (${res.status}): ${errText.slice(0, 200)}`);
    }

    const data = (await res.json()) as { audioContent?: string };
    if (!data.audioContent) {
      throw new Error("Google Cloud TTS returned no audio content");
    }

    const buffer = Buffer.from(data.audioContent, "base64");
    const mimeType = audioEncoding === "OGG_OPUS" ? "audio/ogg; codecs=opus" : "audio/mpeg";

    return {
      buffer,
      mimeType,
      provider: this.providerName,
    };
  }
}
