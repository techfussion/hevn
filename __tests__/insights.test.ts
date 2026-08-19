import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("Insights & Productivity Summary Heuristics", () => {
  it("calculates accurate completion rate and handles 0% vs null cleanly", () => {
    const calculateRate = (completed: number, totalDue: number): number | null =>
      totalDue > 0 ? Math.round((completed / totalDue) * 100) : null;

    assert.equal(calculateRate(4, 5), 80);
    assert.equal(calculateRate(0, 3), 0);
    assert.equal(calculateRate(0, 0), null); // Avoid misleading 0% when no tasks were due
  });

  it("requires at least 3 completed tasks to establish a best day trend", () => {
    const computeBestDay = (
      completedTasks: Array<{ due_at: Date }>,
      timezone: string
    ): string | null => {
      if (completedTasks.length < 3) return null;

      const counts = new Map<string, number>();
      for (const t of completedTasks) {
        const day = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: timezone }).format(
          new Date(t.due_at)
        );
        counts.set(day, (counts.get(day) ?? 0) + 1);
      }

      let best: string | null = null;
      let bestCount = 0;
      for (const [day, count] of counts) {
        if (count > bestCount) {
          best = day;
          bestCount = count;
        }
      }
      return best;
    };

    // 2 tasks on Tuesday -> not enough data (null)
    const twoTasks = [
      { due_at: new Date("2026-08-18T10:00:00Z") },
      { due_at: new Date("2026-08-18T14:00:00Z") },
    ];
    assert.equal(computeBestDay(twoTasks, "UTC"), null);

    // 3 tasks on Tuesday -> identifies Tuesday as best day
    const threeTasks = [
      { due_at: new Date("2026-08-18T10:00:00Z") },
      { due_at: new Date("2026-08-18T14:00:00Z") },
      { due_at: new Date("2026-08-18T18:00:00Z") },
    ];
    assert.equal(computeBestDay(threeTasks, "UTC"), "Tuesday");
  });

  it("generates appropriate supportive suggestions based on metrics", () => {
    const buildSuggestions = (
      completionRate: number | null,
      missedCount: number,
      totalDue: number
    ): string[] => {
      const suggestions: string[] = [];
      if (totalDue === 0) {
        suggestions.push("No tasks due yet this week — nothing to report on. Add a few and check back!");
        return suggestions;
      }
      if (completionRate !== null && completionRate < 50) {
        suggestions.push("Completion rate is under half this week — consider breaking larger tasks into smaller ones.");
      }
      if (missedCount >= 3) {
        suggestions.push(`You've missed ${missedCount} tasks this week — want to review what's realistic for next week?`);
      }
      if (completionRate !== null && completionRate >= 80) {
        suggestions.push("Strong completion rate this week — keep it up.");
      }
      return suggestions;
    };

    const strong = buildSuggestions(90, 0, 10);
    assert.ok(strong[0].includes("Strong completion rate"));

    const struggling = buildSuggestions(30, 4, 10);
    assert.equal(struggling.length, 2);
    assert.ok(struggling[0].includes("under half"));
    assert.ok(struggling[1].includes("missed 4 tasks"));
  });
});
