import test from "node:test";
import assert from "node:assert/strict";
import { NotificationPolicyService } from "../src/core/notifications/NotificationPolicyService";
import type { NotificationDeduplicationService } from "../src/core/notifications/NotificationDeduplicationService";
import type { User, NotificationDigest } from "../src/types/domain";

test("NotificationPolicyService — Quiet Hours, Anti-Nagging, Rate Limiting & Digest Consolidation", async (t) => {
  const mockUser: User = {
    id: "user-policy-1",
    platform: "telegram",
    platformUserId: "tg-999",
    displayName: "Maya",
    timezone: "America/New_York",
    onboarded: true,
    onboardingState: "COMPLETED",
    assistantName: "Hevn",
    botPersona: "Hevn",
    persona: "student",
    preferredCheckinTime: "07:00",
    preferredCheckinHour: 7,
    plan: "free",
    followupPreference: "active",
    quietHoursStart: "22:00",
    quietHoursEnd: "07:00",
    responseMode: "auto",
    voiceEnabled: true,
    voiceName: null,
    voiceLanguage: "en",
    createdAt: new Date().toISOString(),
  };

  const mockDedupService = {
    async getRecentNotificationCount(userId: string): Promise<number> {
      return userId === "spammed-user" ? 6 : 1;
    },
    async getLastNotificationTimestamp(userId: string, prefix: string): Promise<Date | null> {
      if (prefix.includes("nagged-task")) {
        // 5 minutes prior to daytime test date
        return new Date(new Date("2026-08-26T14:00:00-04:00").getTime() - 5 * 60 * 1000);
      }
      return null;
    },
  } as unknown as NotificationDeduplicationService;

  const policyService = new NotificationPolicyService(mockDedupService, {
    maxNotificationsPerHour: 5,
    minFollowUpGapMinutes: 15,
  });

  await t.test("defers notifications during quiet hours unless priority is urgent", async () => {
    // 11:30 PM (23:30) is inside quiet hours (22:00 - 07:00)
    const midnightTime = new Date("2026-08-26T23:30:00-04:00");

    // Standard reminder -> deferred
    const standardDecision = await policyService.evaluate(
      mockUser,
      {
        id: "task-1",
        category: "reminder",
        title: "Read Chapter 4",
        text: "Reminder to read Chapter 4",
        channelCapabilities: { textInput: true, audioInput: true, textOutput: true, audioOutput: true, interactiveButtons: true },
      },
      midnightTime
    );

    assert.strictEqual(standardDecision.eligible, false);
    assert.strictEqual(standardDecision.action, "defer");
    assert.strictEqual(standardDecision.reason, "quiet_hours");
    assert.ok(standardDecision.deferredUntil !== undefined);

    // Urgent notification -> allowed immediately
    const urgentDecision = await policyService.evaluate(
      mockUser,
      {
        id: "task-urgent",
        category: "reminder",
        priority: "urgent",
        title: "Exam Room Changed!",
        text: "Urgent: Exam room changed to Hall B",
        channelCapabilities: { textInput: true, audioInput: true, textOutput: true, audioOutput: true, interactiveButtons: true },
      },
      midnightTime
    );

    assert.strictEqual(urgentDecision.eligible, true);
    assert.strictEqual(urgentDecision.action, "deliver");
  });

  await t.test("enforces anti-nagging gap and hourly rate limits", async () => {
    const daytime = new Date("2026-08-26T14:00:00-04:00");

    // Anti-nagging: recent follow-up within 15 minutes -> deferred
    const naggedDecision = await policyService.evaluate(
      mockUser,
      {
        id: "fu-1",
        taskId: "nagged-task",
        category: "follow_up",
        title: "Submit Project Proposal",
        text: "Following up on project proposal",
        channelCapabilities: { textInput: true, audioInput: true, textOutput: true, audioOutput: true, interactiveButtons: true },
      },
      daytime
    );

    assert.strictEqual(naggedDecision.eligible, false);
    assert.strictEqual(naggedDecision.action, "defer");
    assert.strictEqual(naggedDecision.reason, "anti_nagging_gap");

    // Rate limit exceeded user -> deferred
    const spammedUser: User = { ...mockUser, id: "spammed-user" };
    const rateLimitedDecision = await policyService.evaluate(
      spammedUser,
      {
        id: "task-spam",
        category: "reminder",
        title: "Review Notes",
        text: "Reminder: Review notes",
        channelCapabilities: { textInput: true, audioInput: true, textOutput: true, audioOutput: true, interactiveButtons: true },
      },
      daytime
    );

    assert.strictEqual(rateLimitedDecision.eligible, false);
    assert.strictEqual(rateLimitedDecision.action, "defer");
    assert.strictEqual(rateLimitedDecision.reason, "rate_limit_exceeded");
  });

  await t.test("formats consolidated notification digest cleanly", () => {
    const digest: NotificationDigest = {
      userId: mockUser.id,
      channel: "telegram",
      items: [
        { id: "1", type: "reminder", title: "Math Assignment", dueAt: "2026-08-26T15:00:00Z" },
        { id: "2", type: "study_session", title: "Algorithms Practice", dueAt: "2026-08-26T16:30:00Z" },
        { id: "3", type: "follow_up", title: "Email Professor" },
      ],
      formattedText: "",
    };

    const formatted = policyService.formatDigest(digest);
    assert.ok(formatted.text.includes("You have 3 updates:"));
    assert.ok(formatted.text.includes("[Reminder] Math Assignment"));
    assert.ok(formatted.text.includes("[Study Session] Algorithms Practice"));
    assert.ok(formatted.text.includes("[Follow-Up] Email Professor"));
  });
});
