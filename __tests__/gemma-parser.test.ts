import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractReply } from "../src/core/gemma/GemmaClient";

describe("Gemma Response & Reply Extraction", () => {
  it("extracts clean reply after REPLY: marker", () => {
    const raw = `The student asked about their exam.
I should remind them to prepare their notes.
REPLY: You've got this! Don't forget to review your summary sheets tonight.`;

    const extracted = extractReply(raw);
    assert.equal(extracted, "You've got this! Don't forget to review your summary sheets tonight.");
  });

  it("handles multiple REPLY: markers by taking the last one", () => {
    const raw = `Drafting first thought:
REPLY: Old thought
Actually refining:
REPLY: Final clean reply for student.`;

    const extracted = extractReply(raw);
    assert.equal(extracted, "Final clean reply for student.");
  });

  it("preserves conversational response if model omitted REPLY: marker and no CoT leaked", () => {
    const raw = "Good morning! Hope your study session went well.";
    const extracted = extractReply(raw);
    assert.equal(extracted, "Good morning! Hope your study session went well.");
  });

  it("returns null if model omitted REPLY: marker but leaked chain of thought reasoning", () => {
    const raw = "Thinking: I need to call the create_task tool for this user.";
    const extracted = extractReply(raw);
    assert.equal(extracted, null);
  });

  it("handles null or empty raw text gracefully", () => {
    assert.equal(extractReply(null), null);
    assert.equal(extractReply(""), null);
    assert.equal(extractReply("   "), null);
  });
});
