import { decryptSecret } from "../../utils/crypto";
import { fetchWithRetry } from "../../utils/http";
import { logger } from "../../utils/logger";
import { normalizeAllDayBounds } from "./GoogleCalendarProvider";
import {
  ReauthRequiredError,
  type CalendarAccount,
  type CalendarEvent,
  type CalendarProvider,
  type DiscoveredCalendar,
  type TimeSlot,
} from "./types";

/**
 * CalDAV Provider implementing standard RFC 4791 / RFC 5545 CalDAV protocol.
 * Compatible with Apple iCloud Calendar, Nextcloud, Fastmail, and self-hosted CalDAV servers.
 */
export class CalDavCalendarProvider implements CalendarProvider {
  readonly providerName = "caldav" as const;

  private getAuthHeaders(account: CalendarAccount): Record<string, string> {
    const meta = (account.authMetadata || {}) as { username?: string; serverUrl?: string };
    const username = meta.username || account.accountEmail || "";
    const password = account.encryptedAccessToken ? decryptSecret(account.encryptedAccessToken) : "";

    const basicAuth = Buffer.from(`${username}:${password}`).toString("base64");
    return {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/xml; charset=utf-8",
    };
  }

  private getServerUrl(account: CalendarAccount): string {
    const meta = (account.authMetadata || {}) as { serverUrl?: string };
    return meta.serverUrl || "https://caldav.icloud.com";
  }

  /**
   * Parser for iCalendar (RFC 5545) VEVENT text with timezone and all-day awareness.
   */
  private parseIcsEvents(
    icsText: string,
    calendarId: string,
    userTimezone?: string
  ): CalendarEvent[] {
    const events: CalendarEvent[] = [];
    const veventBlocks = icsText.split("BEGIN:VEVENT");

    for (let i = 1; i < veventBlocks.length; i++) {
      const block = veventBlocks[i].split("END:VEVENT")[0];
      if (!block) continue;

      const getField = (name: string): string | null => {
        const regex = new RegExp(`^${name}(?:;[^:]*)?:(.*)$`, "m");
        const match = block.match(regex);
        return match ? match[1].trim() : null;
      };

      const uid = getField("UID") || `caldav_${Math.random().toString(36).substring(2)}`;
      const summary = getField("SUMMARY") || "(No title)";
      const description = getField("DESCRIPTION");
      const location = getField("LOCATION");
      const statusRaw = getField("STATUS")?.toLowerCase();
      const transpRaw = getField("TRANSP")?.toUpperCase();
      const recurrenceId = getField("RECURRENCE-ID");

      const dtStartRaw = getField("DTSTART");
      const dtEndRaw = getField("DTEND");

      const parseIcsDate = (
        val: string | null,
        isEnd: boolean
      ): { iso: string; isAllDay: boolean } => {
        if (!val) return { iso: new Date().toISOString(), isAllDay: false };
        if (val.length === 8) {
          // YYYYMMDD (all-day)
          const y = val.substring(0, 4);
          const m = val.substring(4, 6);
          const d = val.substring(6, 8);
          const dateStr = `${y}-${m}-${d}`;
          return {
            iso: normalizeAllDayBounds(dateStr, userTimezone, isEnd),
            isAllDay: true,
          };
        }
        // YYYYMMDDTHHMMSSZ or YYYYMMDDTHHMMSS
        const clean = val.replace(/[-:]/g, "");
        const y = clean.substring(0, 4);
        const m = clean.substring(4, 6);
        const d = clean.substring(6, 8);
        const h = clean.substring(9, 11) || "00";
        const min = clean.substring(11, 13) || "00";
        const s = clean.substring(13, 15) || "00";
        return { iso: `${y}-${m}-${d}T${h}:${min}:${s}.000Z`, isAllDay: false };
      };

      const start = parseIcsDate(dtStartRaw, false);
      const end = parseIcsDate(dtEndRaw, true);

      events.push({
        id: uid,
        calendarId,
        title: summary,
        description: description || null,
        startAt: start.iso,
        endAt: end.iso,
        isAllDay: start.isAllDay,
        status:
          statusRaw === "cancelled"
            ? "cancelled"
            : statusRaw === "tentative"
            ? "tentative"
            : "confirmed",
        location: location || null,
        transparency: transpRaw === "TRANSPARENT" ? "transparent" : "opaque",
        recurringEventId: recurrenceId || null,
      });
    }

    return events;
  }

  /**
   * Generate RFC 5545 iCalendar VCALENDAR string.
   */
  private generateIcsEvent(event: Omit<CalendarEvent, "id">, uid: string): string {
    const formatIcsDate = (iso: string, isAllDay: boolean): string => {
      const d = new Date(iso);
      if (isAllDay) {
        return d.toISOString().split("T")[0].replace(/-/g, "");
      }
      return d.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
    };

    const dtStart = formatIcsDate(event.startAt, event.isAllDay);
    const dtEnd = formatIcsDate(event.endAt, event.isAllDay);
    const dtStamp = new Date().toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";

    return [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Hevn AI//CalendarSync 1.0//EN",
      "BEGIN:VEVENT",
      `UID:${uid}`,
      `DTSTAMP:${dtStamp}`,
      event.isAllDay ? `DTSTART;VALUE=DATE:${dtStart}` : `DTSTART:${dtStart}`,
      event.isAllDay ? `DTEND;VALUE=DATE:${dtEnd}` : `DTEND:${dtEnd}`,
      `SUMMARY:${event.title.replace(/\n/g, " ")}`,
      event.description ? `DESCRIPTION:${event.description.replace(/\n/g, "\\n")}` : "",
      event.location ? `LOCATION:${event.location.replace(/\n/g, " ")}` : "",
      "STATUS:CONFIRMED",
      "END:VEVENT",
      "END:VCALENDAR",
    ]
      .filter(Boolean)
      .join("\r\n");
  }

  async listCalendars(account: CalendarAccount): Promise<DiscoveredCalendar[]> {
    const serverUrl = this.getServerUrl(account);
    const headers = this.getAuthHeaders(account);

    const propfindXml = `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:displayname />
    <d:resourcetype />
    <c:supported-calendar-component-set />
  </d:prop>
</d:propfind>`;

    try {
      const res = await fetchWithRetry(serverUrl, {
        method: "PROPFIND",
        headers: { ...headers, Depth: "1" },
        body: propfindXml,
        timeoutMs: 10000,
      });

      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          throw new ReauthRequiredError(
            `CalDAV credentials rejected (HTTP ${res.status}). Please check your password/app-specific password.`,
            "caldav",
            account.id
          );
        }
        throw new Error(`CalDAV PROPFIND failed with status ${res.status}`);
      }

      const xmlText = await res.text();
      const calendars: DiscoveredCalendar[] = [];
      const responses = xmlText.split(/<\/(?:d:)?response>/i);

      for (const block of responses) {
        if (!block.toLowerCase().includes("calendar")) continue;

        const hrefMatch = block.match(/<(?:d:)?href>([^<]+)<\/(?:d:)?href>/i);
        const nameMatch = block.match(/<(?:d:)?displayname>([^<]+)<\/(?:d:)?displayname>/i);

        if (hrefMatch) {
          const href = hrefMatch[1];
          const name = nameMatch ? nameMatch[1] : "Calendar";
          calendars.push({
            id: href,
            name,
            isPrimary: calendars.length === 0,
            accessRole: "owner",
          });
        }
      }

      if (calendars.length === 0) {
        calendars.push({
          id: "/calendars/primary/",
          name: "Default Calendar",
          isPrimary: true,
          accessRole: "owner",
        });
      }

      return calendars;
    } catch (err: unknown) {
      if (err instanceof ReauthRequiredError) throw err;
      logger.warn({ err }, "CalDAV calendar discovery fallback applied");
      return [
        {
          id: "/calendars/primary/",
          name: "Primary Calendar",
          isPrimary: true,
          accessRole: "owner",
        },
      ];
    }
  }

  async listEvents(
    account: CalendarAccount,
    calendarId: string,
    timeMin: string,
    timeMax: string,
    userTimezone?: string
  ): Promise<CalendarEvent[]> {
    const serverUrl = this.getServerUrl(account);
    const headers = this.getAuthHeaders(account);
    const targetUrl = calendarId.startsWith("http")
      ? calendarId
      : `${serverUrl.replace(/\/$/, "")}${calendarId}`;

    const startUtc =
      new Date(timeMin).toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
    const endUtc =
      new Date(timeMax).toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";

    const reportXml = `<?xml version="1.0" encoding="utf-8" ?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag />
    <c:calendar-data />
  </d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="${startUtc}" end="${endUtc}" />
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;

    try {
      const res = await fetchWithRetry(targetUrl, {
        method: "REPORT",
        headers: { ...headers, Depth: "1" },
        body: reportXml,
        timeoutMs: 10000,
      });

      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          throw new ReauthRequiredError(
            `CalDAV credentials rejected (HTTP ${res.status}). Reauthorization required.`,
            "caldav",
            account.id
          );
        }
        throw new Error(`CalDAV REPORT failed with status ${res.status}`);
      }

      const xmlText = await res.text();
      return this.parseIcsEvents(xmlText, calendarId, userTimezone);
    } catch (err: unknown) {
      if (err instanceof ReauthRequiredError) throw err;
      logger.warn({ err, calendarId }, "CalDAV listEvents failed or server returned non-standard XML");
      return [];
    }
  }

  async createEvent(
    account: CalendarAccount,
    calendarId: string,
    event: Omit<CalendarEvent, "id">
  ): Promise<CalendarEvent> {
    const serverUrl = this.getServerUrl(account);
    const headers = this.getAuthHeaders(account);
    const uid = `hevn_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const eventUrl = calendarId.startsWith("http")
      ? `${calendarId.replace(/\/$/, "")}/${uid}.ics`
      : `${serverUrl.replace(/\/$/, "")}${calendarId.replace(/\/$/, "")}/${uid}.ics`;

    const icsContent = this.generateIcsEvent(event, uid);

    const res = await fetchWithRetry(eventUrl, {
      method: "PUT",
      headers: {
        ...headers,
        "Content-Type": "text/calendar; charset=utf-8",
        "If-None-Match": "*",
      },
      body: icsContent,
      timeoutMs: 10000,
    });

    if (!res.ok && res.status !== 201 && res.status !== 204) {
      if (res.status === 401 || res.status === 403) {
        throw new ReauthRequiredError(
          `CalDAV credentials rejected (HTTP ${res.status}). Reauthorization required.`,
          "caldav",
          account.id
        );
      }
      throw new Error(`CalDAV createEvent failed with status ${res.status}`);
    }

    const etag = res.headers.get("etag") || null;

    return {
      id: uid,
      calendarId,
      title: event.title,
      description: event.description || null,
      startAt: event.startAt,
      endAt: event.endAt,
      isAllDay: event.isAllDay,
      status: "confirmed",
      location: event.location || null,
      transparency: "opaque",
      etag,
    };
  }

  async updateEvent(
    account: CalendarAccount,
    calendarId: string,
    eventId: string,
    patch: Partial<CalendarEvent>
  ): Promise<CalendarEvent> {
    const serverUrl = this.getServerUrl(account);
    const headers = this.getAuthHeaders(account);
    const eventUrl = calendarId.startsWith("http")
      ? `${calendarId.replace(/\/$/, "")}/${eventId}.ics`
      : `${serverUrl.replace(/\/$/, "")}${calendarId.replace(/\/$/, "")}/${eventId}.ics`;

    const updatedEvent: Omit<CalendarEvent, "id"> = {
      calendarId,
      title: patch.title || "Updated Event",
      description: patch.description || null,
      startAt: patch.startAt || new Date().toISOString(),
      endAt: patch.endAt || new Date().toISOString(),
      isAllDay: Boolean(patch.isAllDay),
      status: "confirmed",
      location: patch.location || null,
      transparency: "opaque",
    };

    const icsContent = this.generateIcsEvent(updatedEvent, eventId);

    const res = await fetchWithRetry(eventUrl, {
      method: "PUT",
      headers: {
        ...headers,
        "Content-Type": "text/calendar; charset=utf-8",
      },
      body: icsContent,
      timeoutMs: 10000,
    });

    if (!res.ok && res.status !== 200 && res.status !== 204) {
      if (res.status === 401 || res.status === 403) {
        throw new ReauthRequiredError(
          `CalDAV credentials rejected (HTTP ${res.status}). Reauthorization required.`,
          "caldav",
          account.id
        );
      }
      throw new Error(`CalDAV updateEvent failed with status ${res.status}`);
    }

    const etag = res.headers.get("etag") || null;

    return {
      id: eventId,
      ...updatedEvent,
      etag,
    };
  }

  async deleteEvent(
    account: CalendarAccount,
    calendarId: string,
    eventId: string
  ): Promise<boolean> {
    const serverUrl = this.getServerUrl(account);
    const headers = this.getAuthHeaders(account);
    const eventUrl = calendarId.startsWith("http")
      ? `${calendarId.replace(/\/$/, "")}/${eventId}.ics`
      : `${serverUrl.replace(/\/$/, "")}${calendarId.replace(/\/$/, "")}/${eventId}.ics`;

    const res = await fetchWithRetry(eventUrl, {
      method: "DELETE",
      headers,
      timeoutMs: 10000,
    });

    if (res.status === 404) {
      return true; // Idempotent
    }

    if (!res.ok && res.status !== 200 && res.status !== 204) {
      if (res.status === 401 || res.status === 403) {
        throw new ReauthRequiredError(
          `CalDAV credentials rejected (HTTP ${res.status}). Reauthorization required.`,
          "caldav",
          account.id
        );
      }
      throw new Error(`CalDAV deleteEvent failed with status ${res.status}`);
    }

    return true;
  }

  async getAvailability(
    account: CalendarAccount,
    calendarIds: string[],
    timeMin: string,
    timeMax: string
  ): Promise<TimeSlot[]> {
    const busySlots: TimeSlot[] = [];
    for (const calId of calendarIds) {
      const events = await this.listEvents(account, calId, timeMin, timeMax);
      for (const ev of events) {
        if (ev.transparency !== "transparent") {
          busySlots.push({ startAt: ev.startAt, endAt: ev.endAt });
        }
      }
    }
    return busySlots;
  }
}
