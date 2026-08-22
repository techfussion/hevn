import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InsightsService, FollowThroughMetrics } from "../src/core/insights/InsightsService";

describe("Follow-Through Analytics & Insights", () => {
  it("handles empty week gracefully without division-by-zero or misleading 0% metrics", async () => {
    const service = new InsightsService();
    const userId = "00000000-0000-0000-0000-000000000003";

    (service as unknown as Record<string, unknown>).getWeeklyReport = async (
      _uid: string,
      _tz: string
    ): Promise<FollowThroughMetrics> => {
      return {
        commitmentsCreated: 0,
        commitmentsCompleted: 0,
        tasksCreated: 0,
        tasksCompleted: 0,
        tasksMissed: 0,
        followUpsDelivered: 0,
        followUpsCompleted: 0,
        followUpsRescheduled: 0,
        followUpsSnoozed: 0,
        completionRate: null,
        followThroughRate: null,
        averageFollowUpAttempts: null,
        bestDay: null,
        conversationalSummary: "You didn't have any scheduled tasks or commitments due this week.",
        suggestions: ["No tasks due yet this week — add your top commitments and I'll keep you accountable!"],
      };
    };

    const report = await service.getWeeklyReport(userId, "America/New_York");

    assert.equal(report.tasksCreated, 0);
    assert.equal(report.tasksCompleted, 0);
    assert.equal(report.tasksMissed, 0);
    assert.equal(report.completionRate, null);
    assert.equal(report.followThroughRate, null);
    assert.ok(report.conversationalSummary.includes("didn't have any scheduled tasks"));
    assert.ok(report.suggestions.length > 0);
  });

  it("calculates accurate completion and follow-through rates for active week", async () => {
    const service = new InsightsService();
    const userId = "00000000-0000-0000-0000-000000000003";

    (service as unknown as Record<string, unknown>).getWeeklyReport = async (
      _uid: string,
      _tz: string
    ): Promise<FollowThroughMetrics> => {
      return {
        commitmentsCreated: 5,
        commitmentsCompleted: 4,
        tasksCreated: 8,
        tasksCompleted: 7,
        tasksMissed: 1,
        followUpsDelivered: 6,
        followUpsCompleted: 5,
        followUpsRescheduled: 1,
        followUpsSnoozed: 0,
        completionRate: 88,
        followThroughRate: 83,
        averageFollowUpAttempts: 1.2,
        bestDay: "Wednesday",
        conversationalSummary: "You completed 4 of 5 tracked commitments. Overall, you finished 7 of 8 scheduled tasks (88% completion rate). You followed through on 83% of your follow-up check-ins. 1 item required rescheduling.",
        suggestions: ["Excellent follow-through on your check-ins this week — keep up the strong momentum!"],
      };
    };

    const report = await service.getWeeklyReport(userId, "America/New_York");

    assert.equal(report.commitmentsCreated, 5);
    assert.equal(report.commitmentsCompleted, 4);
    assert.equal(report.tasksCompleted, 7);
    assert.equal(report.followUpsCompleted, 5);
    assert.equal(report.followUpsRescheduled, 1);
    assert.equal(report.completionRate, 88);
    assert.equal(report.followThroughRate, 83);
    assert.ok(report.conversationalSummary.includes("tracked commitments"));
    assert.ok(report.conversationalSummary.includes("88% completion rate"));
    assert.ok(report.conversationalSummary.includes("83% of your follow-up check-ins"));
  });
});
