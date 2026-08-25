import test from "node:test";
import assert from "node:assert/strict";
import { ConversationOrchestrator } from "../src/orchestrator/ConversationOrchestrator";
import { GemmaClient } from "../src/core/gemma/GemmaClient";
import { TaskService } from "../src/core/tasks/TaskService";
import { UserService } from "../src/core/tasks/UserService";
import { InsightsService } from "../src/core/insights/InsightsService";
import { CalendarService } from "../src/core/calendar/CalendarService";
import type { User } from "../src/types/domain";
import type { CalendarAccount, CalendarEvent, CalendarProvider, DiscoveredCalendar } from "../src/core/calendar/types";

const testUser: User = {
  id: "user-cal-e2e-1",
  platform: "telegram",
  platformUserId: "1122334455",
  displayName: "Alex",
  timezone: "UTC",
  onboarded: true,
  onboardingState: "COMPLETED",
  assistantName: "Hevn",
  botPersona: "Hevn",
  persona: "professional",
  preferredCheckinTime: "08:00",
  preferredCheckinHour: 8,
  plan: "free",
  followupPreference: "active",
  quietHoursStart: null,
  quietHoursEnd: null,
  createdAt: new Date().toISOString(),
};

test("Calendar E2E — 'Am I free tomorrow afternoon?' invokes check_calendar_availability", async () => {
  const calendarService = new CalendarService();

  const mockProvider: CalendarProvider = {
    providerName: "google",
    async listCalendars(): Promise<DiscoveredCalendar[]> {
      return [{ id: "primary", name: "Primary", isPrimary: true, accessRole: "owner" }];
    },
    async listEvents(): Promise<CalendarEvent[]> {
      return [
        {
          id: "ev-1",
          calendarId: "primary",
          title: "Quarterly Planning",
          startAt: "2026-08-25T14:00:00.000Z",
          endAt: "2026-08-25T15:30:00.000Z",
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

  calendarService.registerProvider("google", mockProvider);
  (calendarService as any).getAccounts = async () => [
    { id: "acc-1", userId: testUser.id, provider: "google", status: "active" } as CalendarAccount,
  ];
  (calendarService as any).getSelectedCalendars = async () => [
    { id: "cal-1", accountId: "acc-1", userId: testUser.id, externalCalendarId: "primary", isSelectedForSync: true } as any,
  ];

  let toolCalled = false;
  const mockGemma = {
    async converse() {
      toolCalled = true;
      return {
        text: null,
        toolCalls: [
          {
            name: "check_calendar_availability",
            args: {
              time_min_iso: "2026-08-25T12:00:00.000Z",
              time_max_iso: "2026-08-25T18:00:00.000Z",
              duration_minutes: 30,
            },
          },
        ],
        rawContent: { role: "model", parts: [] },
      };
    },
    async continueWithToolResults(_sysPrompt: any, _hist: any, _userMsg: any, _rawContent: any, results: any[]) {
      const avail = results[0].response.availability;
      assert.ok(avail);
      assert.equal(avail.isFree, false);
      return {
        text: "REPLY: You have a meeting from 2:00 to 3:30 PM, but you're free from 12:00 to 2:00 PM and after 3:30 PM!",
        toolCalls: [],
        rawContent: null,
      };
    },
  } as unknown as GemmaClient;

  const orchestrator = new ConversationOrchestrator(
    mockGemma,
    new TaskService(),
    new UserService(),
    new InsightsService(),
    undefined,
    undefined,
    undefined,
    undefined,
    calendarService
  );

  (orchestrator as any).getRecentHistory = async () => [];
  (orchestrator as any).persistTurn = async () => {};

  const reply = await orchestrator.handleMessage(testUser, "Am I free tomorrow afternoon?");
  assert.equal(toolCalled, true);
  assert.match(reply, /free from 12:00 to 2:00 PM/);
});

test("Calendar E2E — 'What is on my calendar Thursday?' invokes list_calendar_events", async () => {
  const calendarService = new CalendarService();

  const mockProvider: CalendarProvider = {
    providerName: "google",
    async listCalendars(): Promise<DiscoveredCalendar[]> {
      return [{ id: "primary", name: "Primary", isPrimary: true, accessRole: "owner" }];
    },
    async listEvents(): Promise<CalendarEvent[]> {
      return [
        {
          id: "ev-thurs-1",
          calendarId: "primary",
          title: "Architecture Review",
          startAt: "2026-08-27T10:00:00.000Z",
          endAt: "2026-08-27T11:00:00.000Z",
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

  calendarService.registerProvider("google", mockProvider);
  (calendarService as any).getAccounts = async () => [
    { id: "acc-1", userId: testUser.id, provider: "google", status: "active" } as CalendarAccount,
  ];
  (calendarService as any).getSelectedCalendars = async () => [
    { id: "cal-1", accountId: "acc-1", userId: testUser.id, externalCalendarId: "primary", isSelectedForSync: true } as any,
  ];

  let toolCalled = false;
  const mockGemma = {
    async converse() {
      toolCalled = true;
      return {
        text: null,
        toolCalls: [
          {
            name: "list_calendar_events",
            args: {
              time_min_iso: "2026-08-27T00:00:00.000Z",
              time_max_iso: "2026-08-27T23:59:59.000Z",
            },
          },
        ],
        rawContent: { role: "model", parts: [] },
      };
    },
    async continueWithToolResults(_sysPrompt: any, _hist: any, _userMsg: any, _rawContent: any, results: any[]) {
      assert.equal(results[0].response.events.length, 1);
      assert.equal(results[0].response.events[0].title, "Architecture Review");
      return {
        text: "REPLY: You have one event on Thursday: Architecture Review from 10:00 to 11:00 AM.",
        toolCalls: [],
        rawContent: null,
      };
    },
  } as unknown as GemmaClient;

  const orchestrator = new ConversationOrchestrator(
    mockGemma,
    new TaskService(),
    new UserService(),
    new InsightsService(),
    undefined,
    undefined,
    undefined,
    undefined,
    calendarService
  );

  (orchestrator as any).getRecentHistory = async () => [];
  (orchestrator as any).persistTurn = async () => {};

  const reply = await orchestrator.handleMessage(testUser, "What's on my calendar Thursday?");
  assert.equal(toolCalled, true);
  assert.match(reply, /Architecture Review from 10:00 to 11:00 AM/);
});

test("Calendar E2E — 'Connect my Google Calendar' invokes connect_calendar_instructions", async () => {
  const calendarService = new CalendarService();

  let toolCalled = false;
  const mockGemma = {
    async converse() {
      toolCalled = true;
      return {
        text: null,
        toolCalls: [
          {
            name: "connect_calendar_instructions",
            args: { provider: "google" },
          },
        ],
        rawContent: { role: "model", parts: [] },
      };
    },
    async continueWithToolResults(_sysPrompt: any, _hist: any, _userMsg: any, _rawContent: any, results: any[]) {
      assert.equal(results[0].response.provider, "google");
      assert.ok(results[0].response.connectUrl.includes("accounts.google.com"));
      return {
        text: `REPLY: Here is the secure link to connect your Google Calendar: ${results[0].response.connectUrl}`,
        toolCalls: [],
        rawContent: null,
      };
    },
  } as unknown as GemmaClient;

  const orchestrator = new ConversationOrchestrator(
    mockGemma,
    new TaskService(),
    new UserService(),
    new InsightsService(),
    undefined,
    undefined,
    undefined,
    undefined,
    calendarService
  );

  (orchestrator as any).getRecentHistory = async () => [];
  (orchestrator as any).persistTurn = async () => {};

  const reply = await orchestrator.handleMessage(testUser, "Connect my Google Calendar");
  assert.equal(toolCalled, true);
  assert.match(reply, /accounts\.google\.com/);
});
