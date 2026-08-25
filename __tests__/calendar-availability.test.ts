import test from "node:test";
import assert from "node:assert/strict";
import { CalendarService } from "../src/core/calendar/CalendarService";
import type { CalendarAccount, CalendarEvent, CalendarProvider, DiscoveredCalendar } from "../src/core/calendar/types";

test("Calendar Availability — Merging overlapping busy intervals and finding free slots", async () => {
  const service = new CalendarService();
  const userId = "test-user-avail-1";

  const mockProvider: CalendarProvider = {
    providerName: "google",
    async listCalendars(): Promise<DiscoveredCalendar[]> {
      return [{ id: "primary", name: "Primary", isPrimary: true, accessRole: "owner" }];
    },
    async listEvents(): Promise<CalendarEvent[]> {
      // Two overlapping/adjacent external meetings:
      // 1. 10:00 - 11:00 UTC
      // 2. 10:45 - 11:30 UTC
      // 3. 14:00 - 15:00 UTC
      return [
        {
          id: "ev-1",
          calendarId: "primary",
          title: "Meeting 1",
          startAt: "2026-08-25T10:00:00.000Z",
          endAt: "2026-08-25T11:00:00.000Z",
          isAllDay: false,
          status: "confirmed",
        },
        {
          id: "ev-2",
          calendarId: "primary",
          title: "Meeting 2",
          startAt: "2026-08-25T10:45:00.000Z",
          endAt: "2026-08-25T11:30:00.000Z",
          isAllDay: false,
          status: "confirmed",
        },
        {
          id: "ev-3",
          calendarId: "primary",
          title: "Meeting 3",
          startAt: "2026-08-25T14:00:00.000Z",
          endAt: "2026-08-25T15:00:00.000Z",
          isAllDay: false,
          status: "confirmed",
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

  // Mock getAccounts and getSelectedCalendars
  (service as any).getAccounts = async () => [
    { id: "acc-1", userId, provider: "google", status: "active" } as CalendarAccount,
  ];
  (service as any).getSelectedCalendars = async () => [
    {
      id: "cal-1",
      accountId: "acc-1",
      userId,
      externalCalendarId: "primary",
      name: "Primary",
      isPrimary: true,
      isSelectedForSync: true,
      accessRole: "owner",
    },
  ];

  // Inspect 09:00 to 17:00 UTC
  const availability = await service.checkAvailability(
    userId,
    "2026-08-25T09:00:00.000Z",
    "2026-08-25T17:00:00.000Z",
    30 // 30-minute min slot
  );

  assert.equal(availability.isFree, false);
  // Merged busy intervals:
  // Busy 1: 10:00 - 11:30
  // Busy 2: 14:00 - 15:00
  assert.equal(availability.busySlots.length, 2);
  assert.equal(availability.busySlots[0].startAt, "2026-08-25T10:00:00.000Z");
  assert.equal(availability.busySlots[0].endAt, "2026-08-25T11:30:00.000Z");

  // Free slots:
  // 1. 09:00 - 10:00 (60 min >= 30 min)
  // 2. 11:30 - 14:00 (150 min >= 30 min)
  // 3. 15:00 - 17:00 (120 min >= 30 min)
  assert.equal(availability.freeSlots.length, 3);
  assert.equal(availability.freeSlots[0].startAt, "2026-08-25T09:00:00.000Z");
  assert.equal(availability.freeSlots[0].endAt, "2026-08-25T10:00:00.000Z");
  assert.equal(availability.freeSlots[1].startAt, "2026-08-25T11:30:00.000Z");
  assert.equal(availability.freeSlots[1].endAt, "2026-08-25T14:00:00.000Z");
});

test("Calendar Availability — Entirely free window returns isFree=true", async () => {
  const service = new CalendarService();
  const userId = "test-user-avail-2";

  (service as any).getAccounts = async () => [];
  (service as any).getSelectedCalendars = async () => [];

  const availability = await service.checkAvailability(
    userId,
    "2026-08-25T13:00:00.000Z",
    "2026-08-25T15:00:00.000Z",
    30
  );

  assert.equal(availability.isFree, true);
  assert.equal(availability.busySlots.length, 0);
  assert.equal(availability.freeSlots.length, 1);
  assert.equal(availability.freeSlots[0].startAt, "2026-08-25T13:00:00.000Z");
  assert.equal(availability.freeSlots[0].endAt, "2026-08-25T15:00:00.000Z");
});
