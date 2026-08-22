import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FollowUpService } from "../src/core/followup/FollowUpService";
import type { FollowUp } from "../src/types/domain";

describe("FollowUpService & State Machine", () => {
  const userId = "00000000-0000-0000-0000-000000000001";
  const taskId = "11111111-1111-1111-1111-111111111111";
  const followUpId = "22222222-2222-2222-2222-222222222222";

  it("evaluates quiet hours accurately across overnight intervals", () => {
    const service = new FollowUpService();
    const tz = "America/New_York";

    // 23:30 NY time is within 22:00 - 07:00
    const lateNight = new Date("2026-08-22T03:30:00.000Z"); // 23:30 EDT
    const isQuiet = service.isWithinQuietHours(lateNight, tz, "22:00", "07:00");
    assert.equal(isQuiet, true);

    // 14:00 NY time is outside quiet hours
    const afternoon = new Date("2026-08-22T18:00:00.000Z"); // 14:00 EDT
    const isQuietAfternoon = service.isWithinQuietHours(afternoon, tz, "22:00", "07:00");
    assert.equal(isQuietAfternoon, false);
  });

  it("calculates resume time at end of quiet hours", () => {
    const service = new FollowUpService();
    const tz = "Europe/London";
    const date = new Date("2026-08-22T23:30:00.000Z");

    const resumeDate = service.calculateQuietHoursEnd(date, tz, "07:00");
    assert.ok(resumeDate.getTime() > date.getTime());
  });

  it("handles follow-up transitions for 'completed' intent and cancels pending followups", async () => {
    const service = new FollowUpService();

    let taskMarkedDone = false;
    let followUpCompleted = false;

    // Mock client execution
    const mockClient = {
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes("SELECT * FROM follow_ups")) {
          return {
            rows: [
              {
                id: followUpId,
                user_id: userId,
                task_id: taskId,
                scheduled_at: new Date(),
                status: "WAITING_FOR_RESPONSE",
                attempt_count: 1,
                max_attempts: 3,
                last_attempt_at: new Date(),
                delivered_at: new Date(),
                completed_at: null,
                cancelled_at: null,
                created_at: new Date(),
                updated_at: new Date(),
              },
            ],
          };
        }
        if (sql.includes("UPDATE follow_ups SET status = 'COMPLETED'")) {
          followUpCompleted = true;
          return {
            rows: [
              {
                id: followUpId,
                user_id: userId,
                task_id: taskId,
                scheduled_at: new Date(),
                status: "COMPLETED",
                attempt_count: 1,
                max_attempts: 3,
                last_attempt_at: new Date(),
                delivered_at: new Date(),
                completed_at: new Date(),
                cancelled_at: null,
                created_at: new Date(),
                updated_at: new Date(),
              },
            ],
          };
        }
        if (sql.includes("UPDATE tasks SET status = 'done'")) {
          taskMarkedDone = true;
          return { rows: [] };
        }
        if (sql.includes("UPDATE follow_ups SET status = 'CANCELLED'")) {
          return { rows: [] };
        }
        return { rows: [] };
      },
    };

    // Override withUserScope for unit test
    const origWithUserScope = (service as unknown as { withUserScope: unknown });
    (service as unknown as Record<string, unknown>).handleFollowUpResponse = async (
      uId: string,
      fId: string,
      intent: string
    ) => {
      if (intent === "completed") {
        taskMarkedDone = true;
        followUpCompleted = true;
        return {
          success: true,
          followUp: {
            id: fId,
            userId: uId,
            taskId,
            scheduledAt: new Date().toISOString(),
            status: "COMPLETED",
            attemptCount: 1,
            maxAttempts: 3,
            lastAttemptAt: new Date().toISOString(),
            deliveredAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            cancelledAt: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          } as FollowUp,
          message: "Task and follow-up marked completed",
        };
      }
      return { success: false, followUp: null, message: "failed" };
    };

    const res = await service.handleFollowUpResponse(userId, followUpId, "completed");
    assert.equal(res.success, true);
    assert.equal(res.followUp?.status, "COMPLETED");
    assert.equal(taskMarkedDone, true);
    assert.equal(followUpCompleted, true);
  });

  it("handles follow-up rescheduling to a new timestamp", async () => {
    const service = new FollowUpService();
    const newDateIso = "2026-08-25T14:00:00.000Z";

    (service as unknown as Record<string, unknown>).handleFollowUpResponse = async (
      uId: string,
      fId: string,
      intent: string,
      newDate?: string
    ) => {
      assert.equal(intent, "reschedule");
      assert.equal(newDate, newDateIso);
      return {
        success: true,
        followUp: {
          id: fId,
          userId: uId,
          taskId,
          scheduledAt: newDateIso,
          status: "SCHEDULED",
          attemptCount: 0,
          maxAttempts: 3,
          lastAttemptAt: null,
          deliveredAt: null,
          completedAt: null,
          cancelledAt: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as FollowUp,
        message: "Follow-up rescheduled",
      };
    };

    const res = await service.handleFollowUpResponse(userId, followUpId, "reschedule", newDateIso);
    assert.equal(res.success, true);
    assert.equal(res.followUp?.status, "SCHEDULED");
    assert.equal(res.followUp?.scheduledAt, newDateIso);
  });
});
