import { GoogleGenAI } from "@google/genai";
import type { TranscriptionProvider, TranscriptionResult } from "./types";
import { logger } from "../../utils/logger";

/**
 * Production transcription provider using Google GenAI multimodal audio ingestion.
 */
export class GeminiTranscriptionProvider implements TranscriptionProvider {
  readonly providerName = "gemini" as const;
  private client: GoogleGenAI;
  private model: string;

  constructor(apiKey: string, model: string = "gemini-2.5-flash") {
    if (!apiKey) {
      throw new Error("API key is required for GeminiTranscriptionProvider.");
    }
    this.client = new GoogleGenAI({ apiKey });
    this.model = model;
  }

  async transcribe(audioBuffer: Buffer, mimeType: string): Promise<TranscriptionResult> {
    const startTime = Date.now();
    const normalizedMime = mimeType.split(";")[0].trim().toLowerCase() || "audio/ogg";
    const base64Audio = audioBuffer.toString("base64");

    try {
      const response = await this.client.models.generateContent({
        model: this.model,
        contents: [
          {
            inlineData: {
              data: base64Audio,
              mimeType: normalizedMime,
            },
          },
          "Transcribe this voice audio message verbatim into text. Return ONLY the transcribed text. Do not add markdown formatting, bullet points, commentary, or conversational replies.",
        ],
      });

      const transcript = response.text ? response.text.trim() : "";
      const latencyMs = Date.now() - startTime;
      logger.info(
        { provider: this.providerName, bytes: audioBuffer.length, mimeType: normalizedMime, latencyMs },
        "Audio transcription completed"
      );

      return {
        transcript,
        provider: this.providerName,
      };
    } catch (err) {
      logger.error({ err, provider: this.providerName, mimeType: normalizedMime }, "Transcription failed in provider");
      throw err;
    }
  }
}
