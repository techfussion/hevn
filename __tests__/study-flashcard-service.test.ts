import test from "node:test";
import assert from "node:assert/strict";
import { FlashcardService } from "../src/core/study/FlashcardService";
import type { GemmaClient } from "../src/core/gemma/GemmaClient";
import type { Flashcard } from "../src/types/domain";

test("FlashcardService — High-Yield Flashcard Deck Generation & Formatting", async (t) => {
  const mockCards: Flashcard[] = [
    {
      front: "What is Boyce-Codd Normal Form (BCNF)?",
      back: "A relation is in BCNF if for every functional dependency X -> Y, X is a superkey.",
      topic: "Database Normalization",
      difficulty: "medium",
    },
    {
      front: "What anomaly does Third Normal Form (3NF) prevent?",
      back: "Transitive functional dependencies on non-prime attributes.",
      topic: "Database Normalization",
      difficulty: "medium",
    },
  ];

  const mockGemma: GemmaClient = {
    async converse() {
      return {
        text: `\`\`\`json\n${JSON.stringify(mockCards, null, 2)}\n\`\`\``,
        toolCalls: [],
        rawContent: null,
      };
    },
  } as unknown as GemmaClient;

  const service = new FlashcardService(mockGemma);

  await t.test("generates structured flashcard deck for topic", async () => {
    const cards = await service.generateFlashcards({
      topic: "Database Normalization",
      difficulty: "medium",
      cardCount: 2,
    });

    assert.strictEqual(cards.length, 2);
    assert.strictEqual(cards[0].front, "What is Boyce-Codd Normal Form (BCNF)?");
    assert.ok(cards[0].back.includes("superkey"));
    assert.strictEqual(cards[1].front, "What anomaly does Third Normal Form (3NF) prevent?");
    assert.strictEqual(cards[0].difficulty, "medium");
  });

  await t.test("formats flashcard deck for conversational study delivery", () => {
    const formatted = service.formatDeckForChat(mockCards);
    assert.ok(formatted.includes("🗂️ Flashcards: Database Normalization"));
    assert.ok(formatted.includes("Card 1/2"));
    assert.ok(formatted.includes("Q: What is Boyce-Codd Normal Form"));
    assert.ok(formatted.includes("A: A relation is in BCNF"));
  });

  await t.test("provides fallback flashcards when model returns malformed response", async () => {
    const failingGemma: GemmaClient = {
      async converse() {
        return { text: "Random text without json", toolCalls: [], rawContent: null };
      },
    } as unknown as GemmaClient;

    const fallbackService = new FlashcardService(failingGemma);
    const cards = await fallbackService.generateFlashcards({ topic: "Recursion" });

    assert.strictEqual(cards.length, 1);
    assert.ok(cards[0].front.includes("Recursion"));
    assert.ok(cards[0].back.length > 0);
  });
});
