import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { UserIdentityService } from "../src/core/users/UserIdentityService";

describe("User Identity & Conversational Name Resolution", () => {
  it("prioritizes preferred_name above display_name, username, and full_name", () => {
    const name = UserIdentityService.resolveConversationalName({
      preferredName: "Raj",
      displayName: "Raji Abdulmumin",
      username: "abdulmumin_r",
      fullName: "Raji Abdulmumin Legal",
      namelessMode: false,
    });
    assert.strictEqual(name, "Raj");
  });

  it("extracts first name from display_name when preferred_name is missing", () => {
    const name = UserIdentityService.resolveConversationalName({
      displayName: "Raji Abdulmumin",
      username: "raji_a",
      fullName: "Raji Abdulmumin Full",
    });
    assert.strictEqual(name, "Raji");
  });

  it("resolves cleaned username when preferred_name and display_name are absent", () => {
    const name = UserIdentityService.resolveConversationalName({
      username: "@raj_sec",
    });
    assert.strictEqual(name, "raj_sec");
  });

  it("extracts first name from full_name as fallback", () => {
    const name = UserIdentityService.resolveConversationalName({
      fullName: "Sarah Connor",
    });
    assert.strictEqual(name, "Sarah");
  });

  it("returns null when nameless_mode is enabled even if names exist", () => {
    const name = UserIdentityService.resolveConversationalName({
      preferredName: "Raj",
      displayName: "Raji Abdulmumin",
      username: "raji",
      namelessMode: true,
    });
    assert.strictEqual(name, null);
  });

  it("returns null when all fields are empty or whitespace", () => {
    const name = UserIdentityService.resolveConversationalName({
      preferredName: "   ",
      displayName: "",
      username: null,
    });
    assert.strictEqual(name, null);
  });

  it("validates and normalizes valid usernames", () => {
    const res1 = UserIdentityService.validateAndNormalizeUsername("@Raj_99");
    assert.strictEqual(res1.valid, true);
    assert.strictEqual(res1.normalized, "raj_99");

    const res2 = UserIdentityService.validateAndNormalizeUsername("claire_dev");
    assert.strictEqual(res2.valid, true);
    assert.strictEqual(res2.normalized, "claire_dev");
  });

  it("rejects invalid usernames (too short, too long, special characters)", () => {
    const shortRes = UserIdentityService.validateAndNormalizeUsername("ab");
    assert.strictEqual(shortRes.valid, false);

    const longRes = UserIdentityService.validateAndNormalizeUsername("a".repeat(35));
    assert.strictEqual(longRes.valid, false);

    const invalidChar = UserIdentityService.validateAndNormalizeUsername("raj!@#");
    assert.strictEqual(invalidChar.valid, false);
  });

  it("composes natural greetings with and without names", () => {
    const morning = UserIdentityService.composeGreeting({ preferredName: "Raj" }, "morning");
    assert.strictEqual(morning, "Morning, Raj.");

    const namelessMorning = UserIdentityService.composeGreeting({ namelessMode: true }, "morning");
    assert.strictEqual(namelessMorning, "Good morning.");
  });
});
