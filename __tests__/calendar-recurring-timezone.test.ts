import test from "node:test";
import assert from "node:assert/strict";
import { normalizeAllDayBounds, GoogleCalendarProvider } from "../src/core/calendar/GoogleCalendarProvider";
import { CalDavCalendarProvider } from "../src/core/calendar/CalDavCalendarProvider";
import { CalendarService } from "../src/core/calendar/CalendarService";
import type { CalendarAccount, CalendarEvent, DiscoveredCalendar } from "../src/core/calendar/types";

test("Recurring & Timezones — normalizeAllDayBounds handles UTC, UTC+8 (Singapore), and UTC-4 (New York)", () => {
  // UTC
  const utcStart = normalizeAllDayBounds("2026-08-25", "UTC", false);
  const utcEnd = normalizeAllDayBounds("2026-08-25", "UTC", true);
  assert.equal(utcStart, "2026-08-25T00:00:00.000Z");
  assert.equal(utcEnd, "2026-08-25T23:59:59.999Z");

  // Asia/Singapore (UTC+8) -> Midnight 2026-08-25 in SGT is 16:00:00 UTC on 2026-08-24
  const sgtStart = normalizeAllDayBounds("2026-08-25", "Asia/Singapore", false);
  assert.ok(sgtStart.startsWith("2026-08-24T16:00:00") || sgtStart.startsWith("2026-08-24T15:00:00"));

  // America/New_York (EDT / UTC-4 in August) -> Midnight 2026-08-25 in NYC is 04:00:00 UTC on 2026-08-25
  const nycStart = normalizeAllDayBounds("2026-08-25", "America/New_York", false);
  assert.ok(nycStart.startsWith("2026-08-25T04:00:00") || nycStart.startsWith("2026-08-25T05:00:00"));
});

test("Recurring & Timezones — GoogleCalendarProvider parses recurring instance with recurringEventId and modified status", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response(
      JSON.stringify({
        items: [
          {
            id: "recurring_instance_1",
            summary: "Weekly Team Standup",
            start: { dateTime: "2026-08-25T10:00:00Z" },
            end: { dateTime: "2026-08-25T10:30:00Z" },
            status: "confirmed",
            recurringEventId: "standup_parent_123",
          },
          {
            id: "recurring_instance_cancelled",
            summary: "Weekly Team Standup (Cancelled)",
            start: { dateTime: "2026-08-26T10:00:00Z" },
            end: { dateTime: "2026-08-26T10:30:00Z" },
            status: "cancelled",
            recurringEventId: "standup_parent_123",
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as any;

  try {
    const provider = new GoogleCalendarProvider();
    const account: CalendarAccount = {
      id: "acc-1",
      userId: "user-1",
      provider: "google",
      encryptedAccessToken: "valid-token",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    (provider as any).getValidAccessToken = async () => "mock-access-token";

    const events = await provider.listEvents(
      account,
      "primary",
      "2026-08-25T00:00:00Z",
      "2026-08-27T00:00:00Z"
    );

    assert.equal(events.length, 2);
    assert.equal(events[0].recurringEventId, "standup_parent_123");
    assert.equal(events[0].status, "confirmed");
    assert.equal(events[1].status, "cancelled");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Recurring & Timezones — CalDavCalendarProvider parses iCalendar with RECURRENCE-ID and all-day DTSTART", async () => {
  const icsResponse = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:caldav_event_1
RECURRENCE-ID:20260825T090000Z
SUMMARY:1-on-1 with Manager
DTSTART:20260825T090000Z
DTEND:20260825T093000Z
STATUS:CONFIRMED
TRANSP:OPAQUE
END:VEVENT
BEGIN:VEVENT
UID:caldav_allday_2
SUMMARY:Company Holiday
DTSTART;VALUE=DATE:20260828
DTEND;VALUE=DATE:20260828
STATUS:CONFIRMED
TRANSP:OPAQUE
END:VEVENT
END:VCALENDAR`;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response(icsResponse, { status: 200 });
  }) as any;

  try {
    const provider = new CalDavCalendarProvider();
    const account: CalendarAccount = {
      id: "acc-caldav-1",
      userId: "user-1",
      provider: "caldav",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const events = await provider.listEvents(
      account,
      "/calendars/work/",
      "2026-08-25T00:00:00Z",
      "2026-08-30T00:00:00Z",
      "UTC"
    );

    assert.equal(events.length, 2);
    assert.equal(events[0].recurringEventId, "20260825T090000Z");
    assert.equal(events[0].title, "1-on-1 with Manager");
    assert.equal(events[1].isAllDay, true);
    assert.equal(events[1].title, "Company Holiday");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Recurring & Timezones — CalendarService filters cancelled events from checkAvailability", async () => {
  const service = new CalendarService();
  const mockProvider = {
    providerName: "google" as const,
    async listCalendars(): Promise<DiscoveredCalendar[]> {
      return [{ id: "primary", name: "Primary", isPrimary: true, accessRole: "owner" }];
    },
    async listEvents(): Promise<CalendarEvent[]> {
      return [
        {
          id: "ev-cancelled",
          calendarId: "primary",
          title: "Cancelled All Hands",
          startAt: "2026-08-25T14:00:00.000Z",
          endAt: "2026-08-25T15:00:00.000Z",
          isAllDay: false,
          status: "cancelled",
        },
      ];
    },
    async createEvent(): Promise<CalendarEvent> {
      throw new Error("Not implemented");
    },
    async updateEvent(): Promise<CalendarEvent> {
      throw new Error("Not implemented");
    },
    async deleteEvent(): Promise<boolean> {
      return true;
    },
  };

  service.registerProvider("google", mockProvider);
  (service as any).getAccounts = async () => [
    { id: "acc-1", userId: "u1", provider: "google", status: "active" } as CalendarAccount,
  ];
  (service as any).getSelectedCalendars = async () => [
    { id: "cal-1", accountId: "acc-1", userId: "u1", externalCalendarId: "primary", isSelectedForSync: true } as any,
  ];

  const avail = await service.checkAvailability(
    "u1",
    "2026-08-25T12:00:00.000Z",
    "2026-08-25T18:00:00.000Z",
    30
  );

  assert.equal(avail.isFree, true, "Cancelled event should not block availability");
  assert.equal(avail.busySlots.length, 0);
});
