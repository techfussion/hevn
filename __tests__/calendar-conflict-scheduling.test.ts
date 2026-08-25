import test from "node:test";
import assert from "node:assert/strict";
import { CalendarService } from "../src/core/calendar/CalendarService";
import type { CalendarAccount, CalendarEvent, DiscoveredCalendar } from "../src/core/calendar/types";

test("Conflict Scheduling — findAvailableSlots finds free windows avoiding external busy blocks", async () => {
  const service = new CalendarService();
  const userId = "user-sched-1";

  const mockProvider = {
    providerName: "google" as const,
    async listCalendars(): Promise<DiscoveredCalendar[]> {
      return [{ id: "primary", name: "Primary", isPrimary: true, accessRole: "owner" }];
    },
    async listEvents(): Promise<CalendarEvent[]> {
      return [
        {
          id: "ev-meeting-1",
          calendarId: "primary",
          title: "Team Sync",
          startAt: "2026-08-25T14:00:00.000Z",
          endAt: "2026-08-25T15:00:00.000Z",
          isAllDay: false,
          status: "confirmed",
          transparency: "opaque",
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
    { id: "acc-1", userId, provider: "google", status: "active" } as CalendarAccount,
  ];
  (service as any).getSelectedCalendars = async () => [
    { id: "cal-1", accountId: "acc-1", userId, externalCalendarId: "primary", isSelectedForSync: true } as any,
  ];

  // Search window 13:00 to 17:00 UTC (4 hours) with 30 min duration
  const slots = await service.findAvailableSlots(userId, {
    timeMin: "2026-08-25T13:00:00.000Z",
    timeMax: "2026-08-25T17:00:00.000Z",
    durationMinutes: 30,
    preferences: { respectQuietHours: false, maxSlots: 4 },
  });

  assert.ok(slots.length > 0);
  // Verify no slot overlaps with 14:00 to 15:00
  for (const s of slots) {
    const sStart = new Date(s.startAt).getTime();
    const sEnd = new Date(s.endAt).getTime();
    const busyStart = new Date("2026-08-25T14:00:00.000Z").getTime();
    const busyEnd = new Date("2026-08-25T15:00:00.000Z").getTime();
    const overlap = sStart < busyEnd && sEnd > busyStart;
    assert.equal(overlap, false, `Slot ${s.startAt} - ${s.endAt} must not overlap with busy meeting`);
  }
});

test("Conflict Scheduling — findAvailableSlots applies buffer padding before/after meetings", async () => {
  const service = new CalendarService();
  const userId = "user-sched-2";

  const mockProvider = {
    providerName: "google" as const,
    async listCalendars(): Promise<DiscoveredCalendar[]> {
      return [{ id: "primary", name: "Primary", isPrimary: true, accessRole: "owner" }];
    },
    async listEvents(): Promise<CalendarEvent[]> {
      return [
        {
          id: "ev-meeting-buffered",
          calendarId: "primary",
          title: "Executive Review",
          startAt: "2026-08-25T14:00:00.000Z",
          endAt: "2026-08-25T15:00:00.000Z",
          isAllDay: false,
          status: "confirmed",
          transparency: "opaque",
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
    { id: "acc-1", userId, provider: "google", status: "active" } as CalendarAccount,
  ];
  (service as any).getSelectedCalendars = async () => [
    { id: "cal-1", accountId: "acc-1", userId, externalCalendarId: "primary", isSelectedForSync: true } as any,
  ];

  // 15 min buffer -> Effective busy window is 13:45 to 15:15
  const slots = await service.findAvailableSlots(userId, {
    timeMin: "2026-08-25T13:00:00.000Z",
    timeMax: "2026-08-25T16:00:00.000Z",
    durationMinutes: 30,
    preferences: { bufferMinutes: 15, respectQuietHours: false, maxSlots: 5 },
  });

  for (const s of slots) {
    const sStart = new Date(s.startAt).getTime();
    const sEnd = new Date(s.endAt).getTime();
    const bufferedBusyStart = new Date("2026-08-25T13:45:00.000Z").getTime();
    const bufferedBusyEnd = new Date("2026-08-25T15:15:00.000Z").getTime();
    const overlap = sStart < bufferedBusyEnd && sEnd > bufferedBusyStart;
    assert.equal(overlap, false, `Slot ${s.startAt} - ${s.endAt} must not overlap with buffered interval`);
  }
});

test("Conflict Scheduling — findAvailableSlots filters out quiet hours", async () => {
  const mockDbScope = async (_uId: string, fn: any) => {
    const mockClient = {
      query: async (sql: string) => {
        if (sql.includes("SELECT timezone, quiet_hours_start, quiet_hours_end FROM users")) {
          return {
            rows: [
              {
                timezone: "UTC",
                quiet_hours_start: "22:00",
                quiet_hours_end: "07:00",
              },
            ],
          };
        }
        return { rows: [] };
      },
    };
    return fn(mockClient);
  };

  const service = new CalendarService(mockDbScope);
  const userId = "user-sched-quiet-1";

  (service as any).getAccounts = async () => [];
  (service as any).getSelectedCalendars = async () => [];

  // Search window across night: 20:00 to 23:59 UTC
  const slots = await service.findAvailableSlots(userId, {
    timeMin: "2026-08-25T20:00:00.000Z",
    timeMax: "2026-08-25T23:59:59.000Z",
    durationMinutes: 30,
    preferences: { respectQuietHours: true, maxSlots: 10 },
  });

  // All slots should be strictly before 22:00
  for (const s of slots) {
    const sEnd = new Date(s.endAt).getTime();
    const quietStart = new Date("2026-08-25T22:00:00.000Z").getTime();
    assert.ok(sEnd <= quietStart, `Slot ending at ${s.endAt} should not extend into quiet hours (>= 22:00)`);
  }
});
