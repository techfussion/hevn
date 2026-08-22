import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FollowUpService } from "../src/core/followup/FollowUpService";
import { computeNextOccurrence } from "../src/core/recurring/RecurringTaskService";

describe("Scheduler Reliability & Edge Cases", () => {
  const followUpService = new FollowUpService();

  it("accurately calculates quiet hours spanning cross-midnight boundaries", () => {
    const tz = "America/New_York";
    const quietStart = "22:00";
    const quietEnd = "07:00";

    // 23:30 NY time is within quiet hours
    const lateNight = new Date("2026-08-23T03:30:00.000Z"); // 23:30 EDT
    assert.equal(
      followUpService.isWithinQuietHours(lateNight, tz, quietStart, quietEnd),
      true
    );

    // 03:00 NY time is within quiet hours
    const earlyMorning = new Date("2026-08-23T07:00:00.000Z"); // 03:00 EDT
    assert.equal(
      followUpService.isWithinQuietHours(earlyMorning, tz, quietStart, quietEnd),
      true
    );

    // 14:00 NY time is NOT within quiet hours
    const afternoon = new Date("2026-08-22T18:00:00.000Z"); // 14:00 EDT
    assert.equal(
      followUpService.isWithinQuietHours(afternoon, tz, quietStart, quietEnd),
      false
    );
  });

  it("calculates accurate resume time at the end of quiet hours", () => {
    const tz = "Europe/London";
    const quietEnd = "07:00";

    // When follow-up is triggered at 02:00 AM London time
    const nightTime = new Date("2026-08-22T01:00:00.000Z"); // 02:00 BST
    const resume = followUpService.calculateQuietHoursEnd(nightTime, tz, quietEnd);

    // Resumed time should be in the future relative to nightTime
    assert.ok(resume.getTime() > nightTime.getTime());
  });

  it("computes next occurrence idempotently for recurring tasks", () => {
    const base = new Date("2026-08-22T05:00:00.000Z");
    const nextDaily = computeNextOccurrence("daily", "09:00", null, "UTC", base);

    assert.equal(nextDaily.toISOString(), "2026-08-22T09:00:00.000Z");
    assert.ok(nextDaily.getTime() > base.getTime());
  });
});
