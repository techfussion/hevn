import test from "node:test";
import assert from "node:assert/strict";
import { CalendarReconciliationService } from "../src/core/calendar/CalendarReconciliationService";
import { CalendarService } from "../src/core/calendar/CalendarService";
import { ReauthRequiredError } from "../src/core/calendar/types";
import type { CalendarAccount, ConnectedCalendar, CalendarEvent } from "../src/core/calendar/types";
import type { Task, StudySession } from "../src/types/domain";

test("CalendarReconciliationService — Source-of-Truth Sync, Conflict Detection & OAuth Revocation", async (t) => {
  const userId = "user-cal-sync";
  const accountId = "acc-google-1";

  const mockAccount: CalendarAccount = {
    id: accountId,
    userId,
    provider: "google",
    accountEmail: "student@university.edu",
    status: "active",
    statusReason: null,
    encryptedAccessToken: "enc_tok",
    encryptedRefreshToken: "enc_ref",
    tokenExpiresAt: new Date(Date.now() + 3600000).toISOString(),
    lastSyncAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const mockCalendar: ConnectedCalendar = {
    id: "cal-primary-1",
    accountId,
    userId,
    externalCalendarId: "primary",
    name: "Primary Calendar",
    isPrimary: true,
    isSelectedForSync: true,
    accessRole: "owner",
    syncToken: "sync_tok_v1",
    lastSyncAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  let updatedAccountStatus: { status: string; reason: string } | null = null;

  const mockCalendarService = {
    async getAccounts(uId: string) {
      return [mockAccount];
    },
    async getSelectedCalendars(uId: string) {
      return [mockCalendar];
    },
    getProvider(name: string) {
      return {
        providerName: "google",
        async incrementalSync(account: CalendarAccount, calendarId: string, syncToken?: string) {
          if (syncToken === "revoked_tok") {
            throw new ReauthRequiredError("OAuth token has been revoked by user");
          }

          return {
            events: [
              {
                id: "ev-meeting-1",
                summary: "Lab Meeting with Advisor",
                startTime: "2026-08-26T14:00:00.000Z",
                endTime: "2026-08-26T15:00:00.000Z",
                isAllDay: false,
                status: "confirmed",
              },
              {
                id: "ev-cancelled-1",
                summary: "Cancelled Tutorial",
                startTime: "2026-08-26T16:00:00.000Z",
                endTime: "2026-08-26T17:00:00.000Z",
                isAllDay: false,
                status: "cancelled",
              },
            ],
            nextSyncToken: "sync_tok_v2",
          };
        },
      };
    },
    async updateAccountStatus(uId: string, accId: string, status: string, reasonCode: string, reason: string) {
      updatedAccountStatus = { status, reason };
    },
    emitMetric() {},
  } as unknown as CalendarService;

  const reconciliationService = new CalendarReconciliationService(mockCalendarService);

  // Stub internal schedule queries for conflict detection
  const internalStudySession: StudySession = {
    id: "session-clash-1",
    userId,
    studyPlanId: "plan-1",
    courseId: "course-1",
    topicId: "topic-1",
    taskId: "task-session-1",
    title: "Algorithms Revision",
    scheduledStart: "2026-08-26T14:15:00.000Z", // Overlaps with Lab Meeting (14:00 - 15:00)
    scheduledEnd: "2026-08-26T15:15:00.000Z",
    plannedMinutes: 60,
    actualMinutes: null,
    status: "scheduled",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  (reconciliationService as any).fetchInternalSchedule = async () => {
    return {
      internalTasks: [],
      studySessions: [internalStudySession],
    };
  };

  (reconciliationService as any).handleDeletedExternalEvent = async () => {};
  (reconciliationService as any).updateSyncToken = async () => {};
  (reconciliationService as any).updateAccountLastSync = async () => {};

  await t.test("reconciles events, detects study session schedule conflict and handles event deletions", async () => {
    const result = await reconciliationService.reconcileAccount(userId, accountId);

    assert.strictEqual(result.accountId, accountId);
    assert.strictEqual(result.syncedEventsCount, 2);
    assert.strictEqual(result.updatedCount, 1);
    assert.strictEqual(result.deletedCount, 1);

    // Schedule conflict detected non-destructively
    assert.strictEqual(result.conflicts.length, 1);
    assert.strictEqual(result.conflicts[0].externalEventTitle, "Lab Meeting with Advisor");
    assert.strictEqual(result.conflicts[0].conflictingType, "study_session");
    assert.strictEqual(result.conflicts[0].conflictingTitle, "Algorithms Revision");
    assert.strictEqual(result.conflicts[0].severity, "high");
  });

  await t.test("catches revoked OAuth tokens and transitions account to reauth_required", async () => {
    mockCalendar.syncToken = "revoked_tok";

    const result = await reconciliationService.reconcileAccount(userId, accountId);

    assert.strictEqual(result.reauthRequired, true);
    assert.strictEqual(updatedAccountStatus?.status, "reauth_required");
    assert.ok(updatedAccountStatus?.reason.includes("OAuth token has been revoked"));
  });
});
