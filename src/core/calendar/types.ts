/**
 * Domain types and provider contracts for external calendar integration.
 */

export type CalendarProviderType = "google" | "caldav";
export type CalendarAccountStatus =
  | "active"
  | "revoked"
  | "reauth_required"
  | "error"
  | "disconnected";
export type CalendarAccessRole = "owner" | "writer" | "reader";
export type CalendarSyncStatus =
  | "synced"
  | "pending_push"
  | "pending_pull"
  | "conflict"
  | "deleted";

export class ReauthRequiredError extends Error {
  readonly provider: CalendarProviderType;
  readonly accountId?: string;

  constructor(message: string, provider: CalendarProviderType, accountId?: string) {
    super(message);
    this.name = "ReauthRequiredError";
    this.provider = provider;
    this.accountId = accountId;
  }
}

export interface CalendarAccount {
  id: string;
  userId: string;
  provider: CalendarProviderType;
  accountEmail?: string | null;
  encryptedAccessToken?: string | null;
  encryptedRefreshToken?: string | null;
  tokenExpiresAt?: string | null;
  authMetadata?: Record<string, unknown>;
  status: CalendarAccountStatus;
  errorCode?: string | null;
  errorMessage?: string | null;
  lastSyncAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectedCalendar {
  id: string;
  accountId: string;
  userId: string;
  externalCalendarId: string;
  name: string;
  color?: string | null;
  isPrimary: boolean;
  isSelectedForSync: boolean;
  accessRole: CalendarAccessRole;
  syncToken?: string | null;
  lastSyncAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CalendarEvent {
  id: string;
  calendarId: string;
  title: string;
  description?: string | null;
  startAt: string; // ISO 8601 UTC
  endAt: string; // ISO 8601 UTC
  isAllDay: boolean;
  status: "confirmed" | "tentative" | "cancelled";
  location?: string | null;
  transparency?: "opaque" | "transparent"; // opaque = busy, transparent = free
  recurrenceRule?: string | null;
  recurringEventId?: string | null;
  etag?: string | null;
  htmlLink?: string | null;
}

export interface CalendarEventLink {
  id: string;
  userId: string;
  calendarId: string;
  taskId?: string | null;
  externalEventId: string;
  externalEventEtag?: string | null;
  syncStatus: CalendarSyncStatus;
  lastSyncedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface TimeSlot {
  startAt: string; // ISO 8601 UTC
  endAt: string; // ISO 8601 UTC
}

export interface CalendarAvailability {
  timeZone: string;
  busySlots: TimeSlot[];
  freeSlots: TimeSlot[];
  isFree: boolean;
  conflictingEvents?: Array<{ title: string; startAt: string; endAt: string }>;
}

export interface FindSlotsPreferences {
  bufferMinutes?: number; // e.g. 10 or 15 mins padding before/after meetings
  preferredHours?: {
    startHour: number; // e.g. 9 for 9:00 AM
    endHour: number; // e.g. 17 for 5:00 PM
  };
  respectQuietHours?: boolean; // default true
  maxSlots?: number; // default 5
}

export interface AvailabilityOptions {
  timeMin: string; // ISO 8601 UTC
  timeMax: string; // ISO 8601 UTC
  durationMinutes?: number; // default 30
  userTimezone?: string;
  preferences?: FindSlotsPreferences;
}

export interface DiscoveredCalendar {
  id: string;
  name: string;
  isPrimary: boolean;
  accessRole: CalendarAccessRole;
  color?: string;
}

export interface CalendarMetricEvent {
  eventType:
    | "calendar.sync.start"
    | "calendar.sync.success"
    | "calendar.sync.failure"
    | "calendar.provider.request"
    | "calendar.oauth.refresh"
    | "calendar.oauth.reauth_required"
    | "calendar.conflict_detected";
  userId?: string;
  provider?: CalendarProviderType;
  durationMs?: number;
  retryCount?: number;
  status?: string | number;
  metadata?: Record<string, unknown>;
}

export interface CalendarProvider {
  readonly providerName: CalendarProviderType;
  listCalendars(account: CalendarAccount): Promise<DiscoveredCalendar[]>;
  listEvents(
    account: CalendarAccount,
    calendarId: string,
    timeMin: string,
    timeMax: string,
    userTimezone?: string
  ): Promise<CalendarEvent[]>;
  createEvent(
    account: CalendarAccount,
    calendarId: string,
    event: Omit<CalendarEvent, "id">
  ): Promise<CalendarEvent>;
  updateEvent(
    account: CalendarAccount,
    calendarId: string,
    eventId: string,
    patch: Partial<CalendarEvent>
  ): Promise<CalendarEvent>;
  deleteEvent(
    account: CalendarAccount,
    calendarId: string,
    eventId: string
  ): Promise<boolean>;
  getAvailability?(
    account: CalendarAccount,
    calendarIds: string[],
    timeMin: string,
    timeMax: string
  ): Promise<TimeSlot[]>;
  incrementalSync?(
    account: CalendarAccount,
    calendarId: string,
    syncToken?: string,
    userTimezone?: string
  ): Promise<{ events: CalendarEvent[]; nextSyncToken?: string }>;
}
