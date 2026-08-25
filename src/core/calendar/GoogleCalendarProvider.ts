import { decryptSecret, encryptSecret } from "../../utils/crypto";
import { fetchWithRetry } from "../../utils/http";
import { logger, sanitizeStringForLogging } from "../../utils/logger";
import {
  ReauthRequiredError,
  type CalendarAccount,
  type CalendarEvent,
  type CalendarProvider,
  type DiscoveredCalendar,
  type TimeSlot,
} from "./types";

export interface GoogleCalendarConfig {
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
}

/**
 * Normalizes all-day date bounds ("YYYY-MM-DD") into ISO 8601 UTC timestamps
 * that accurately reflect midnight-to-midnight in the user's localized timezone.
 */
export function normalizeAllDayBounds(
  dateStr: string,
  userTimezone: string = "UTC",
  isEnd: boolean = false
): string {
  if (!dateStr) {
    return new Date().toISOString();
  }

  if (userTimezone === "UTC" || !userTimezone) {
    return isEnd ? `${dateStr}T23:59:59.999Z` : `${dateStr}T00:00:00.000Z`;
  }

  try {
    const [y, m, d] = dateStr.split("-").map(Number);
    if (!y || !m || !d) {
      return isEnd ? `${dateStr}T23:59:59.999Z` : `${dateStr}T00:00:00.000Z`;
    }

    const targetHour = isEnd ? 23 : 0;
    const targetMin = isEnd ? 59 : 0;
    const targetSec = isEnd ? 59 : 0;
    const targetMs = isEnd ? 999 : 0;

    const utcDate = new Date(Date.UTC(y, m - 1, d, targetHour, targetMin, targetSec, targetMs));

    // Resolve exact timezone offset string (e.g. GMT+8, GMT-4, GMT+5:30)
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: userTimezone,
      timeZoneName: "shortOffset",
    });
    const parts = formatter.formatToParts(utcDate);
    const offsetPart = parts.find((p) => p.type === "timeZoneName")?.value || "GMT";

    let offsetMinutes = 0;
    const match = offsetPart.match(/GMT([+-])(\d+)(?::(\d+))?/);
    if (match) {
      const sign = match[1] === "+" ? 1 : -1;
      const hours = parseInt(match[2], 10);
      const minutes = match[3] ? parseInt(match[3], 10) : 0;
      offsetMinutes = sign * (hours * 60 + minutes);
    }

    const adjustedUtcMs = utcDate.getTime() - offsetMinutes * 60 * 1000;
    return new Date(adjustedUtcMs).toISOString();
  } catch {
    return isEnd ? `${dateStr}T23:59:59.999Z` : `${dateStr}T00:00:00.000Z`;
  }
}

export class GoogleCalendarProvider implements CalendarProvider {
  readonly providerName = "google" as const;
  private config: GoogleCalendarConfig;
  private onTokenRefreshed?: (
    accountId: string,
    encryptedAccessToken: string,
    expiresAt: string
  ) => Promise<void>;

  constructor(
    config?: GoogleCalendarConfig,
    onTokenRefreshed?: (
      accountId: string,
      encryptedAccessToken: string,
      expiresAt: string
    ) => Promise<void>
  ) {
    this.config = {
      clientId: config?.clientId || process.env.GOOGLE_CLIENT_ID || "",
      clientSecret: config?.clientSecret || process.env.GOOGLE_CLIENT_SECRET || "",
      redirectUri:
        config?.redirectUri ||
        process.env.GOOGLE_REDIRECT_URI ||
        "http://localhost:3000/auth/google/callback",
    };
    this.onTokenRefreshed = onTokenRefreshed;
  }

  /**
   * Get valid decrypted access token, automatically refreshing if expired or expiring within 60s.
   * Handles invalid_grant / revoked credentials with ReauthRequiredError.
   */
  private async getValidAccessToken(account: CalendarAccount): Promise<string> {
    if (!account.encryptedAccessToken) {
      throw new ReauthRequiredError(
        "Calendar account has no access token. Reauthorization is required.",
        "google",
        account.id
      );
    }

    const now = Date.now();
    const expiresAt = account.tokenExpiresAt ? new Date(account.tokenExpiresAt).getTime() : 0;
    const isExpired = expiresAt > 0 && expiresAt - now < 60000;

    if (!isExpired) {
      return decryptSecret(account.encryptedAccessToken);
    }

    if (!account.encryptedRefreshToken) {
      return decryptSecret(account.encryptedAccessToken);
    }

    // Refresh token with retry
    const refreshToken = decryptSecret(account.encryptedRefreshToken);
    const tokenUrl = "https://oauth2.googleapis.com/token";

    try {
      const res = await fetchWithRetry(tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: this.config.clientId || "",
          client_secret: this.config.clientSecret || "",
          refresh_token: refreshToken,
          grant_type: "refresh_token",
        }).toString(),
        timeoutMs: 8000,
        maxRetries: 2,
      });

      if (!res.ok) {
        const errText = await res.text();
        const sanitizedErr = sanitizeStringForLogging(errText);
        logger.error(
          { status: res.status, provider: "google", accountId: account.id },
          "Google token refresh failed"
        );

        if (
          res.status === 400 ||
          res.status === 401 ||
          sanitizedErr.includes("invalid_grant") ||
          sanitizedErr.includes("revoked")
        ) {
          throw new ReauthRequiredError(
            `Google OAuth refresh token expired or was revoked (HTTP ${res.status}). Reauthorization required.`,
            "google",
            account.id
          );
        }

        throw new Error(`Google token refresh failed with status ${res.status}`);
      }

      const data = (await res.json()) as { access_token: string; expires_in: number };
      const newAccessToken = data.access_token;
      const newExpiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();
      const newEncryptedToken = encryptSecret(newAccessToken);

      if (this.onTokenRefreshed) {
        try {
          await this.onTokenRefreshed(account.id, newEncryptedToken, newExpiresAt);
        } catch (err) {
          logger.warn({ err }, "Failed to persist refreshed Google access token");
        }
      }

      return newAccessToken;
    } catch (err: unknown) {
      if (err instanceof ReauthRequiredError) throw err;
      throw err;
    }
  }

  async listCalendars(account: CalendarAccount): Promise<DiscoveredCalendar[]> {
    const accessToken = await this.getValidAccessToken(account);
    const url = "https://www.googleapis.com/calendar/v3/users/me/calendarList";

    const res = await fetchWithRetry(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeoutMs: 10000,
    });

    if (!res.ok) {
      if (res.status === 401) {
        throw new ReauthRequiredError(
          "Google credentials rejected (HTTP 401). Reauthorization required.",
          "google",
          account.id
        );
      }
      throw new Error(`Google listCalendars failed with status ${res.status}`);
    }

    const data = (await res.json()) as {
      items?: Array<{
        id: string;
        summary: string;
        primary?: boolean;
        accessRole?: string;
        backgroundColor?: string;
      }>;
    };

    return (data.items || []).map((item) => ({
      id: item.id,
      name: item.summary,
      isPrimary: Boolean(item.primary),
      accessRole: (item.accessRole === "owner" || item.accessRole === "writer"
        ? item.accessRole
        : "reader") as "owner" | "writer" | "reader",
      color: item.backgroundColor,
    }));
  }

  async listEvents(
    account: CalendarAccount,
    calendarId: string,
    timeMin: string,
    timeMax: string,
    userTimezone?: string
  ): Promise<CalendarEvent[]> {
    const accessToken = await this.getValidAccessToken(account);
    const params = new URLSearchParams({
      timeMin: new Date(timeMin).toISOString(),
      timeMax: new Date(timeMax).toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "250",
    });

    if (userTimezone) {
      params.set("timeZone", userTimezone);
    }

    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
      calendarId
    )}/events?${params.toString()}`;

    const res = await fetchWithRetry(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeoutMs: 10000,
    });

    if (!res.ok) {
      if (res.status === 401) {
        throw new ReauthRequiredError(
          "Google credentials rejected (HTTP 401). Reauthorization required.",
          "google",
          account.id
        );
      }
      throw new Error(`Google listEvents failed with status ${res.status}`);
    }

    const data = (await res.json()) as {
      items?: Array<{
        id: string;
        summary?: string;
        description?: string;
        start?: { dateTime?: string; date?: string };
        end?: { dateTime?: string; date?: string };
        status?: string;
        location?: string;
        transparency?: string;
        recurringEventId?: string;
        etag?: string;
        htmlLink?: string;
      }>;
    };

    return (data.items || []).map((item) => {
      const isAllDay = !item.start?.dateTime && Boolean(item.start?.date);
      const startAt = item.start?.dateTime
        ? new Date(item.start.dateTime).toISOString()
        : isAllDay && item.start?.date
        ? normalizeAllDayBounds(item.start.date, userTimezone, false)
        : timeMin;

      const endAt = item.end?.dateTime
        ? new Date(item.end.dateTime).toISOString()
        : isAllDay && item.end?.date
        ? normalizeAllDayBounds(item.end.date, userTimezone, true)
        : timeMax;

      return {
        id: item.id,
        calendarId,
        title: item.summary || "(No title)",
        description: item.description || null,
        startAt,
        endAt,
        isAllDay,
        status: (item.status === "cancelled"
          ? "cancelled"
          : item.status === "tentative"
          ? "tentative"
          : "confirmed") as "confirmed" | "tentative" | "cancelled",
        location: item.location || null,
        transparency: (item.transparency === "transparent"
          ? "transparent"
          : "opaque") as "opaque" | "transparent",
        recurringEventId: item.recurringEventId || null,
        etag: item.etag || null,
        htmlLink: item.htmlLink || null,
      };
    });
  }

  async createEvent(
    account: CalendarAccount,
    calendarId: string,
    event: Omit<CalendarEvent, "id">
  ): Promise<CalendarEvent> {
    const accessToken = await this.getValidAccessToken(account);
    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
      calendarId
    )}/events`;

    const bodyPayload: Record<string, unknown> = {
      summary: event.title,
      description: event.description || undefined,
      location: event.location || undefined,
      start: event.isAllDay
        ? { date: event.startAt.split("T")[0] }
        : { dateTime: new Date(event.startAt).toISOString() },
      end: event.isAllDay
        ? { date: event.endAt.split("T")[0] }
        : { dateTime: new Date(event.endAt).toISOString() },
    };

    const res = await fetchWithRetry(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(bodyPayload),
      timeoutMs: 10000,
    });

    if (!res.ok) {
      if (res.status === 401) {
        throw new ReauthRequiredError(
          "Google credentials rejected (HTTP 401). Reauthorization required.",
          "google",
          account.id
        );
      }
      const errText = await res.text();
      const sanitized = sanitizeStringForLogging(errText);
      throw new Error(`Google createEvent failed with status ${res.status}: ${sanitized}`);
    }

    const created = (await res.json()) as {
      id: string;
      summary?: string;
      description?: string;
      start?: { dateTime?: string; date?: string };
      end?: { dateTime?: string; date?: string };
      status?: string;
      etag?: string;
      htmlLink?: string;
    };

    return {
      id: created.id,
      calendarId,
      title: created.summary || event.title,
      description: created.description || event.description || null,
      startAt: created.start?.dateTime || event.startAt,
      endAt: created.end?.dateTime || event.endAt,
      isAllDay: event.isAllDay,
      status: (created.status === "cancelled"
        ? "cancelled"
        : "confirmed") as "confirmed" | "tentative" | "cancelled",
      etag: created.etag || null,
      htmlLink: created.htmlLink || null,
    };
  }

  async updateEvent(
    account: CalendarAccount,
    calendarId: string,
    eventId: string,
    patch: Partial<CalendarEvent>
  ): Promise<CalendarEvent> {
    const accessToken = await this.getValidAccessToken(account);
    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
      calendarId
    )}/events/${encodeURIComponent(eventId)}`;

    const bodyPayload: Record<string, unknown> = {};
    if (patch.title !== undefined) bodyPayload.summary = patch.title;
    if (patch.description !== undefined) bodyPayload.description = patch.description;
    if (patch.location !== undefined) bodyPayload.location = patch.location;
    if (patch.startAt) {
      bodyPayload.start = patch.isAllDay
        ? { date: patch.startAt.split("T")[0] }
        : { dateTime: new Date(patch.startAt).toISOString() };
    }
    if (patch.endAt) {
      bodyPayload.end = patch.isAllDay
        ? { date: patch.endAt.split("T")[0] }
        : { dateTime: new Date(patch.endAt).toISOString() };
    }

    const res = await fetchWithRetry(url, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(bodyPayload),
      timeoutMs: 10000,
    });

    if (!res.ok) {
      if (res.status === 401) {
        throw new ReauthRequiredError(
          "Google credentials rejected (HTTP 401). Reauthorization required.",
          "google",
          account.id
        );
      }
      const errText = await res.text();
      const sanitized = sanitizeStringForLogging(errText);
      throw new Error(`Google updateEvent failed with status ${res.status}: ${sanitized}`);
    }

    const updated = (await res.json()) as {
      id: string;
      summary?: string;
      description?: string;
      start?: { dateTime?: string; date?: string };
      end?: { dateTime?: string; date?: string };
      status?: string;
      etag?: string;
      htmlLink?: string;
    };

    return {
      id: updated.id,
      calendarId,
      title: updated.summary || patch.title || "",
      description: updated.description || patch.description || null,
      startAt: updated.start?.dateTime || patch.startAt || new Date().toISOString(),
      endAt: updated.end?.dateTime || patch.endAt || new Date().toISOString(),
      isAllDay: Boolean(patch.isAllDay),
      status: "confirmed",
      etag: updated.etag || null,
      htmlLink: updated.htmlLink || null,
    };
  }

  async deleteEvent(
    account: CalendarAccount,
    calendarId: string,
    eventId: string
  ): Promise<boolean> {
    const accessToken = await this.getValidAccessToken(account);
    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
      calendarId
    )}/events/${encodeURIComponent(eventId)}`;

    const res = await fetchWithRetry(url, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
      timeoutMs: 10000,
    });

    if (res.status === 404 || res.status === 410) {
      return true; // Idempotent: already deleted
    }

    if (!res.ok) {
      if (res.status === 401) {
        throw new ReauthRequiredError(
          "Google credentials rejected (HTTP 401). Reauthorization required.",
          "google",
          account.id
        );
      }
      throw new Error(`Google deleteEvent failed with status ${res.status}`);
    }

    return true;
  }

  async getAvailability(
    account: CalendarAccount,
    calendarIds: string[],
    timeMin: string,
    timeMax: string
  ): Promise<TimeSlot[]> {
    const accessToken = await this.getValidAccessToken(account);
    const url = "https://www.googleapis.com/calendar/v3/freeBusy";

    const res = await fetchWithRetry(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        timeMin: new Date(timeMin).toISOString(),
        timeMax: new Date(timeMax).toISOString(),
        items: calendarIds.map((id) => ({ id })),
      }),
      timeoutMs: 10000,
    });

    if (!res.ok) {
      if (res.status === 401) {
        throw new ReauthRequiredError(
          "Google credentials rejected (HTTP 401). Reauthorization required.",
          "google",
          account.id
        );
      }
      throw new Error(`Google freeBusy failed with status ${res.status}`);
    }

    const data = (await res.json()) as {
      calendars?: Record<string, { busy?: Array<{ start: string; end: string }> }>;
    };

    const busySlots: TimeSlot[] = [];
    if (data.calendars) {
      for (const calId of Object.keys(data.calendars)) {
        const calBusy = data.calendars[calId]?.busy || [];
        for (const slot of calBusy) {
          busySlots.push({
            startAt: new Date(slot.start).toISOString(),
            endAt: new Date(slot.end).toISOString(),
          });
        }
      }
    }

    return busySlots;
  }

  async incrementalSync(
    account: CalendarAccount,
    calendarId: string,
    syncToken?: string,
    userTimezone?: string
  ): Promise<{ events: CalendarEvent[]; nextSyncToken?: string }> {
    const accessToken = await this.getValidAccessToken(account);
    const params = new URLSearchParams({
      singleEvents: "true",
      maxResults: "250",
    });

    if (syncToken) {
      params.set("syncToken", syncToken);
    } else {
      params.set("timeMin", new Date(Date.now() - 7 * 86400000).toISOString());
      params.set("timeMax", new Date(Date.now() + 60 * 86400000).toISOString());
    }

    if (userTimezone) {
      params.set("timeZone", userTimezone);
    }

    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
      calendarId
    )}/events?${params.toString()}`;

    const res = await fetchWithRetry(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeoutMs: 12000,
    });

    if (res.status === 410) {
      // 410 Gone = Sync token invalidated; perform clean recovery full sync
      logger.warn({ calendarId }, "Google sync token expired (410 Gone); falling back to full sync");
      return this.incrementalSync(account, calendarId, undefined, userTimezone);
    }

    if (!res.ok) {
      if (res.status === 401) {
        throw new ReauthRequiredError(
          "Google credentials rejected (HTTP 401). Reauthorization required.",
          "google",
          account.id
        );
      }
      throw new Error(`Google incrementalSync failed with status ${res.status}`);
    }

    const data = (await res.json()) as {
      items?: Array<{
        id: string;
        summary?: string;
        description?: string;
        start?: { dateTime?: string; date?: string };
        end?: { dateTime?: string; date?: string };
        status?: string;
        location?: string;
        transparency?: string;
        recurringEventId?: string;
        etag?: string;
      }>;
      nextSyncToken?: string;
    };

    const events: CalendarEvent[] = (data.items || []).map((item) => {
      const isAllDay = !item.start?.dateTime && Boolean(item.start?.date);
      const startAt = item.start?.dateTime
        ? new Date(item.start.dateTime).toISOString()
        : isAllDay && item.start?.date
        ? normalizeAllDayBounds(item.start.date, userTimezone, false)
        : new Date().toISOString();

      const endAt = item.end?.dateTime
        ? new Date(item.end.dateTime).toISOString()
        : isAllDay && item.end?.date
        ? normalizeAllDayBounds(item.end.date, userTimezone, true)
        : new Date().toISOString();

      return {
        id: item.id,
        calendarId,
        title: item.summary || "(No title)",
        description: item.description || null,
        startAt,
        endAt,
        isAllDay,
        status: (item.status === "cancelled"
          ? "cancelled"
          : item.status === "tentative"
          ? "tentative"
          : "confirmed") as "confirmed" | "tentative" | "cancelled",
        location: item.location || null,
        transparency: (item.transparency === "transparent"
          ? "transparent"
          : "opaque") as "opaque" | "transparent",
        recurringEventId: item.recurringEventId || null,
        etag: item.etag || null,
      };
    });

    return {
      events,
      nextSyncToken: data.nextSyncToken,
    };
  }
}
