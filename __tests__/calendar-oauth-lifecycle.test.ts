import test from "node:test";
import assert from "node:assert/strict";
import { GoogleCalendarProvider } from "../src/core/calendar/GoogleCalendarProvider";
import { CalendarService } from "../src/core/calendar/CalendarService";
import { encryptSecret } from "../src/utils/crypto";
import { ReauthRequiredError } from "../src/core/calendar/types";
import type { CalendarAccount } from "../src/core/calendar/types";

test("OAuth Lifecycle — invalid_grant error during token refresh triggers ReauthRequiredError", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response(
      JSON.stringify({ error: "invalid_grant", error_description: "Token has been expired or revoked." }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }) as any;

  try {
    const provider = new GoogleCalendarProvider();
    const expiredAccount: CalendarAccount = {
      id: "acc-expired-1",
      userId: "user-1",
      provider: "google",
      encryptedAccessToken: encryptSecret("old-access-token"),
      encryptedRefreshToken: encryptSecret("revoked-refresh-token"),
      tokenExpiresAt: new Date(Date.now() - 100000).toISOString(),
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await assert.rejects(
      async () => {
        await provider.listCalendars(expiredAccount);
      },
      (err: any) => err instanceof ReauthRequiredError && err.provider === "google"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OAuth Lifecycle — updateAccountStatus updates status to reauth_required and logs metric", async () => {
  let updatedStatus: string | null = null;
  let updatedErrorCode: string | null = null;

  const mockDbScope = async (_uId: string, fn: any) => {
    const mockClient = {
      query: async (sql: string, params: any[]) => {
        if (sql.includes("UPDATE calendar_accounts") && sql.includes("SET status = $1")) {
          updatedStatus = params[0];
          updatedErrorCode = params[1];
          return { rowCount: 1 };
        }
        return { rows: [] };
      },
    };
    return fn(mockClient);
  };

  const service = new CalendarService(mockDbScope);
  let metricEmitted = false;
  service.emitMetric = (event) => {
    if (event.eventType === "calendar.oauth.reauth_required") {
      metricEmitted = true;
    }
  };

  await service.updateAccountStatus(
    "user-1",
    "acc-1",
    "reauth_required",
    "INVALID_GRANT",
    "Token was revoked"
  );

  assert.equal(updatedStatus, "reauth_required");
  assert.equal(updatedErrorCode, "INVALID_GRANT");
  assert.equal(metricEmitted, true);
});

test("OAuth Lifecycle — listUpcomingEvents fast-fails with ReauthRequiredError when account is in reauth_required state", async () => {
  const reauthAccount: CalendarAccount = {
    id: "acc-reauth-1",
    userId: "user-reauth-1",
    provider: "google",
    status: "reauth_required",
    errorCode: "INVALID_GRANT",
    errorMessage: "Token was revoked",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const mockDbScope = async (_uId: string, fn: any) => {
    const mockClient = {
      query: async (sql: string) => {
        if (sql.includes("FROM calendar_accounts")) {
          return { rows: [reauthAccount] };
        }
        return { rows: [] };
      },
    };
    return fn(mockClient);
  };

  const service = new CalendarService(mockDbScope);

  await assert.rejects(
    async () => {
      await service.listUpcomingEvents(
        "user-reauth-1",
        "2026-08-25T00:00:00.000Z",
        "2026-08-25T23:59:59.000Z"
      );
    },
    (err: any) => err instanceof ReauthRequiredError && err.provider === "google"
  );
});
