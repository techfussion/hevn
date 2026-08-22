import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeNextOccurrence, RecurringTaskService } from "../src/core/recurring/RecurringTaskService";

describe("Recurring Tasks & Schedule Computation", () => {
  it("computes next daily occurrence in user's timezone correctly", () => {
    // Current time: 2026-08-22 05:00 UTC
    const base = new Date("2026-08-22T05:00:00.000Z");

    // Target: daily at 09:00 UTC
    const nextDaily = computeNextOccurrence("daily", "09:00", null, "UTC", base);
    assert.equal(nextDaily.toISOString(), "2026-08-22T09:00:00.000Z");

    // Target: daily at 04:00 UTC (already passed today -> should be tomorrow 04:00)
    const nextDailyTomorrow = computeNextOccurrence("daily", "04:00", null, "UTC", base);
    assert.equal(nextDailyTomorrow.toISOString(), "2026-08-23T04:00:00.000Z");
  });

  it("computes next weekdays occurrence skipping weekends", () => {
    // 2026-08-21 is a Friday.
    const fridayEvening = new Date("2026-08-21T20:00:00.000Z");

    // Target: weekdays at 08:00 UTC -> next should be Monday 2026-08-24 08:00
    const nextWeekday = computeNextOccurrence("weekdays", "08:00", null, "UTC", fridayEvening);
    const dayOfWeek = nextWeekday.getUTCDay(); // 1 = Monday
    assert.equal(dayOfWeek, 1);
    assert.equal(nextWeekday.getUTCDate(), 24);
  });

  it("computes next weekly occurrence on specified day", () => {
    // 2026-08-22 is Saturday (day 6).
    const saturday = new Date("2026-08-22T10:00:00.000Z");

    // Target: weekly on Wednesday (day 3) at 15:00 UTC -> 2026-08-26
    const nextWed = computeNextOccurrence("weekly", "15:00", [3], "UTC", saturday);
    assert.equal(nextWed.getUTCDay(), 3);
    assert.equal(nextWed.getUTCDate(), 26);
  });
});
