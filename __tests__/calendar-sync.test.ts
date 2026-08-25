import test from "node:test";
import assert from "node:assert/strict";
import { CalendarService } from "../src/core/calendar/CalendarService";
import type { Task } from "../src/types/domain";
import type { CalendarAccount, CalendarEvent, CalendarProvider, DiscoveredCalendar } from "../src/core/calendar/types";

test("Calendar Sync — syncCommitmentToCalendar creates event idempotently", async () => {
  const userId = "test-user-sync-1";
  let linkRecord: any = null;

  const mockDbScope = async (_uId: string, fn: any) => {
    const mockClient = {
      query: async (sql: string, params: any[]) => {
        if (sql.includes("SELECT * FROM calendar_event_links")) {
          return { rows: linkRecord ? [linkRecord] : [] };
        }
        if (sql.includes("INSERT INTO calendar_event_links")) {
          linkRecord = {
            id: "link-1",
            user_id: userId,
            calendar_id: params[1],
            task_id: params[2],
            external_event_id: params[3],
            external_event_etag: params[4],
            sync_status: "synced",
            created_at: new Date().toISOString(),
          };
          return {
            rows: [
              {
                id: "link-1",
                userId,
                calendarId: params[1],
                taskId: params[2],
                externalEventId: params[3],
                externalEventEtag: params[4],
                syncStatus: "synced",
                lastSyncedAt: new Date().toISOString(),
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
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

  let createdEventsCount = 0;
  const createdEvents: CalendarEvent[] = [];

  const mockProvider: CalendarProvider = {
    providerName: "google",
    async listCalendars(): Promise<DiscoveredCalendar[]> {
      return [{ id: "primary", name: "Primary", isPrimary: true, accessRole: "owner" }];
    },
    async listEvents(): Promise<CalendarEvent[]> {
      return [];
    },
    async createEvent(_acc, _calId, event): Promise<CalendarEvent> {
      createdEventsCount++;
      const created: CalendarEvent = {
        id: `ext-ev-${createdEventsCount}`,
        calendarId: "primary",
        title: event.title,
        description: event.description || null,
        startAt: event.startAt,
        endAt: event.endAt,
        isAllDay: false,
        status: "confirmed",
        etag: "etag_123",
      };
      createdEvents.push(created);
      return created;
    },
    async updateEvent(_acc, _calId, eventId, patch): Promise<CalendarEvent> {
      return {
        id: eventId,
        calendarId: "primary",
        title: patch.title || "Updated",
        startAt: patch.startAt || new Date().toISOString(),
        endAt: patch.endAt || new Date().toISOString(),
        isAllDay: false,
        status: "confirmed",
        etag: "etag_updated_456",
      };
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

  const commitmentTask: Task = {
    id: "task-commitment-100",
    userId,
    title: "Meeting with Department Head",
    dueAt: "2026-08-28T14:00:00.000Z",
    priority: "high",
    status: "pending",
    taskType: "commitment",
    isSystemGenerated: false,
    reminderOffsetMinutes: 60,
    reminderSentAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  // Initial sync call -> creates event
  const result1 = await service.syncCommitmentToCalendar(userId, commitmentTask);
  assert.ok(result1);
  assert.equal(result1.externalEventId, "ext-ev-1");
  assert.equal(createdEventsCount, 1);

  // Subsequent sync call -> updates existing event rather than creating duplicate
  const result2 = await service.syncCommitmentToCalendar(userId, commitmentTask);
  assert.ok(result2);
  assert.equal(result2.externalEventId, "ext-ev-1");
  assert.equal(createdEventsCount, 1, "Duplicate event must not be created on repeated sync");
});
