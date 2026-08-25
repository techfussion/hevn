import { logger } from "../../utils/logger";
import type { Flashcard, QuizDifficulty } from "../../types/domain";
import type { GemmaClient } from "../gemma/GemmaClient";

export interface GenerateFlashcardsOptions {
  topic: string;
  difficulty?: QuizDifficulty;
  cardCount?: number; // default 5
}

export class FlashcardService {
  constructor(private gemma: GemmaClient) {}

  /**
   * Formats a flashcard deck into a readable conversational chat output.
   */
  formatDeckForChat(cards: Flashcard[]): string {
    if (!cards.length) return "No flashcards available.";
    const topic = cards[0].topic || "Study Topic";
    const lines = [`🗂️ Flashcards: ${topic} (${cards.length} cards)\n`];
    cards.forEach((card, idx) => {
      lines.push(`Card ${idx + 1}/${cards.length}:`);
      lines.push(`Q: ${card.front}`);
      lines.push(`A: ${card.back}\n`);
    });
    return lines.join("\n").trim();
  }

  /**
   * Generates a structured flashcard deck using Gemma.
   */
  async generateFlashcards(options: GenerateFlashcardsOptions): Promise<Flashcard[]> {
    const cardCount = Math.max(1, Math.min(10, options.cardCount ?? 5));
    const difficulty = options.difficulty || "medium";
    const topic = options.topic.trim();

    const prompt = `You are a study card generator.
Generate a structured deck of ${cardCount} concise, high-yield study flashcards for the topic "${topic}" with difficulty level "${difficulty}".

Return ONLY a valid JSON array of objects matching this exact schema:
[
  {
    "front": "string (clear question or prompt)",
    "back": "string (concise, memorable answer)",
    "topic": "${topic}",
    "difficulty": "${difficulty}"
  }
]

JSON Response:`;

    try {
      const response = await this.gemma.converse(prompt, [], "", []);

      const parsed = this.extractJsonArray(response.text || "");
      if (parsed && parsed.length > 0) {
        return parsed.map((item: Record<string, unknown>) => ({
          front: String(item.front || "Question").trim(),
          back: String(item.back || "Answer").trim(),
          topic: String(item.topic || topic).trim(),
          difficulty: (item.difficulty as QuizDifficulty) || difficulty,
        }));
      }

      // Fallback default cards if generation did not return valid array
      return [
        {
          front: `What is the core definition of ${topic}?`,
          back: `The fundamental concept and underlying mechanism governing ${topic}.`,
          topic,
          difficulty,
        },
      ];
    } catch (err: unknown) {
      logger.error({ err, topic }, "Flashcard generation failed");
      return [
        {
          front: `What is ${topic}?`,
          back: `Key principles and techniques in ${topic}.`,
          topic,
          difficulty,
        },
      ];
    }
  }

  private extractJsonArray(text: string): Record<string, unknown>[] | null {
    const cleaned = text
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    try {
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed)) return parsed as Record<string, unknown>[];
      if (parsed && Array.isArray(parsed.flashcards)) return parsed.flashcards as Record<string, unknown>[];
    } catch {
      // attempt regex extraction
      const match = cleaned.match(/\[\s*\{[\s\S]*\}\s*\]/);
      if (match) {
        try {
          const parsed = JSON.parse(match[0]);
          if (Array.isArray(parsed)) return parsed as Record<string, unknown>[];
        } catch {
          // ignore
        }
      }
    }
    return null;
  }
}
