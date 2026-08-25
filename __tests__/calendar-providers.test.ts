import test from "node:test";
import assert from "node:assert/strict";
import { GoogleCalendarProvider } from "../src/core/calendar/GoogleCalendarProvider";
import { CalDavCalendarProvider } from "../src/core/calendar/CalDavCalendarProvider";
import { encryptSecret } from "../src/utils/crypto";
import type { CalendarAccount } from "../src/core/calendar/types";

test("GoogleCalendarProvider — listCalendars & listEvents with mocked Google API", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const mockAccount: CalendarAccount = {
      id: "acc-google-1",
      userId: "user-1",
      provider: "google",
      accountEmail: "student@example.com",
      encryptedAccessToken: encryptSecret("valid_google_token_123"),
      encryptedRefreshToken: encryptSecret("valid_refresh_token_456"),
      tokenExpiresAt: new Date(Date.now() + 3600000).toISOString(),
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    globalThis.fetch = async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const urlStr = url.toString();

      if (urlStr.includes("/users/me/calendarList")) {
        return new Response(
          JSON.stringify({
            items: [
              { id: "primary", summary: "Personal", primary: true, accessRole: "owner" },
              { id: "work_cal_id", summary: "Work", primary: false, accessRole: "writer" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      if (urlStr.includes("/events")) {
        return new Response(
          JSON.stringify({
            items: [
              {
                id: "ev-1",
                summary: "Database Lecture",
                description: "Room 402",
                start: { dateTime: "2026-08-25T10:00:00Z" },
                end: { dateTime: "2026-08-25T11:30:00Z" },
                status: "confirmed",
                transparency: "opaque",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      return new Response("Not found", { status: 404 });
    };

    const provider = new GoogleCalendarProvider();
    const calendars = await provider.listCalendars(mockAccount);
    assert.equal(calendars.length, 2);
    assert.equal(calendars[0].name, "Personal");
    assert.equal(calendars[0].isPrimary, true);

    const events = await provider.listEvents(
      mockAccount,
      "primary",
      "2026-08-25T00:00:00Z",
      "2026-08-25T23:59:59Z"
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].title, "Database Lecture");
    assert.equal(events[0].startAt, "2026-08-25T10:00:00.000Z");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GoogleCalendarProvider — Token refresh on expired access token", async () => {
  const originalFetch = globalThis.fetch;
  let tokenRefreshedCalled = false;

  try {
    const expiredAccount: CalendarAccount = {
      id: "acc-google-expired",
      userId: "user-1",
      provider: "google",
      accountEmail: "student@example.com",
      encryptedAccessToken: encryptSecret("old_expired_token"),
      encryptedRefreshToken: encryptSecret("valid_refresh_token"),
      tokenExpiresAt: new Date(Date.now() - 3600000).toISOString(), // Expired 1 hr ago
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    globalThis.fetch = async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const urlStr = url.toString();

      if (urlStr.includes("oauth2.googleapis.com/token")) {
        return new Response(
          JSON.stringify({
            access_token: "new_refreshed_access_token_789",
            expires_in: 3600,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      if (urlStr.includes("/calendarList")) {
        // Ensure the Authorization header uses the newly refreshed token
        const authHeader = (init?.headers as Record<string, string>)?.Authorization;
        assert.equal(authHeader, "Bearer new_refreshed_access_token_789");
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }

      return new Response("Not found", { status: 404 });
    };

    const provider = new GoogleCalendarProvider(
      { clientId: "mock_client_id", clientSecret: "mock_secret" },
      async (accountId, encryptedToken, expiresAt) => {
        tokenRefreshedCalled = true;
        assert.equal(accountId, "acc-google-expired");
        assert.ok(encryptedToken);
        assert.ok(expiresAt);
      }
    );

    await provider.listCalendars(expiredAccount);
    assert.equal(tokenRefreshedCalled, true, "onTokenRefreshed callback should have been invoked");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("CalDavCalendarProvider — iCalendar event parsing & generation", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const mockAccount: CalendarAccount = {
      id: "acc-caldav-1",
      userId: "user-2",
      provider: "caldav",
      accountEmail: "user@icloud.com",
      encryptedAccessToken: encryptSecret("app_specific_pwd"),
      authMetadata: { serverUrl: "https://caldav.icloud.com", username: "user@icloud.com" },
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const mockIcsResponse = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Apple Inc.//Mac OS X 10.15.7//EN
BEGIN:VEVENT
UID:icloud_event_998877
DTSTAMP:20260824T120000Z
DTSTART:20260826T140000Z
DTEND:20260826T150000Z
SUMMARY:Thesis Committee Review
DESCRIPTION:Review chapter 3 with supervisor
LOCATION:Hall A
STATUS:CONFIRMED
END:VEVENT
END:VCALENDAR`;

    globalThis.fetch = async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const method = init?.method;
      if (method === "REPORT") {
        return new Response(mockIcsResponse, { status: 200 });
      }
      if (method === "PUT") {
        return new Response(null, { status: 201 });
      }
      return new Response("Not found", { status: 404 });
    };

    const provider = new CalDavCalendarProvider();
    const events = await provider.listEvents(
      mockAccount,
      "/calendars/work/",
      "2026-08-26T00:00:00Z",
      "2026-08-26T23:59:59Z"
    );

    assert.equal(events.length, 1);
    assert.equal(events[0].id, "icloud_event_998877");
    assert.equal(events[0].title, "Thesis Committee Review");
    assert.equal(events[0].location, "Hall A");

    const created = await provider.createEvent(mockAccount, "/calendars/work/", {
      calendarId: "/calendars/work/",
      title: "New CalDAV Meeting",
      startAt: "2026-08-27T09:00:00.000Z",
      endAt: "2026-08-27T10:00:00.000Z",
      isAllDay: false,
      status: "confirmed",
    });

    assert.equal(created.title, "New CalDAV Meeting");
    assert.ok(created.id.startsWith("hevn_"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
