import type { PoolClient } from "pg";
import { withUserScope, getSchedulerPool } from "../../db/pool";
import { generateOAuthState } from "../../utils/crypto";
import { logger } from "../../utils/logger";
import type { Task } from "../../types/domain";
import { CalDavCalendarProvider } from "./CalDavCalendarProvider";
import { GoogleCalendarProvider } from "./GoogleCalendarProvider";
import {
  ReauthRequiredError,
  type AvailabilityOptions,
  type CalendarAccount,
  type CalendarAccountStatus,
  type CalendarAvailability,
  type CalendarEvent,
  type CalendarEventLink,
  type CalendarMetricEvent,
  type CalendarProvider,
  type ConnectedCalendar,
  type DiscoveredCalendar,
  type TimeSlot,
} from "./types";

export type UserScopeFn = <T>(
  userId: string,
  fn: (client: PoolClient) => Promise<T>
) => Promise<T>;

export class CalendarService {
  private providers: Map<string, CalendarProvider> = new Map();
  private dbScope: UserScopeFn;

  constructor(dbScope?: UserScopeFn) {
    this.dbScope = dbScope || withUserScope;

    // Register default providers
    const googleProvider = new GoogleCalendarProvider(
      undefined,
      async (accountId, encryptedToken, expiresAt) => {
        try {
          await getSchedulerPool().query(
            `UPDATE calendar_accounts
             SET encrypted_access_token = $1, token_expires_at = $2, updated_at = now()
             WHERE id = $3`,
            [encryptedToken, expiresAt, accountId]
          );
        } catch (err) {
          logger.warn({ err, accountId }, "Failed to update refreshed access token in DB");
        }
      }
    );
    this.providers.set("google", googleProvider);
    this.providers.set("caldav", new CalDavCalendarProvider());
  }

  /**
   * Inject or override a provider (useful for testing).
   */
  registerProvider(name: string, provider: CalendarProvider) {
    this.providers.set(name, provider);
  }

  getProvider(name: string): CalendarProvider {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new Error(`Calendar provider '${name}' is not registered`);
    }
    return provider;
  }

  /**
   * Structured operational telemetry emission.
   */
  emitMetric(event: CalendarMetricEvent) {
    logger.info(
      {
        telemetry: true,
        metric: event.eventType,
        userId: event.userId,
        provider: event.provider,
        durationMs: event.durationMs,
        retryCount: event.retryCount,
        status: event.status,
        ...event.metadata,
      },
      `[Telemetry] ${event.eventType}`
    );
  }

  /**
   * Check if a calendar provider is fully configured with required environment variables.
   */
  isProviderConfigured(provider: "google" | "caldav"): { configured: boolean; missing: string[] } {
    if (provider === "google") {
      const p = this.providers.get("google") as GoogleCalendarProvider | undefined;
      if (p && typeof p.isConfigured === "function") {
        return p.isConfigured();
      }
      const missing: string[] = [];
      if (!process.env.GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID.includes("PLACEHOLDER")) {
        missing.push("GOOGLE_CLIENT_ID");
      }
      if (!process.env.GOOGLE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET.includes("PLACEHOLDER")) {
        missing.push("GOOGLE_CLIENT_SECRET");
      }
      if (!process.env.GOOGLE_REDIRECT_URI) {
        missing.push("GOOGLE_REDIRECT_URI");
      }
      return { configured: missing.length === 0, missing };
    }
    return { configured: true, missing: [] };
  }

  /**
   * Generate an authorization/connect URL for the user.
   */
  generateConnectUrl(userId: string, provider: "google" | "caldav"): string {
    if (provider === "google") {
      const clientId = process.env.GOOGLE_CLIENT_ID || "GOOGLE_CLIENT_ID_PLACEHOLDER";
      const redirectUri =
        process.env.GOOGLE_REDIRECT_URI || "http://localhost:3000/auth/google/callback";
      const state = generateOAuthState(userId);
      const scopes = [
        "https://www.googleapis.com/auth/calendar.events",
        "https://www.googleapis.com/auth/calendar.readonly",
      ].join(" ");

      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: scopes,
        access_type: "offline",
        prompt: "consent",
        state,
      });

      return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    }

    return `Please provide your CalDAV server URL, username, and app-specific password to link your calendar.`;
  }

  /**
   * Retrieve calendar accounts for a user.
   * By default returns only active accounts; pass includeInactive=true for administrative/diagnostic lookups.
   */
  async getAccounts(userId: string, includeInactive: boolean = false): Promise<CalendarAccount[]> {
    return this.dbScope(userId, async (client) => {
      const whereClause = includeInactive
        ? "WHERE user_id = $1"
        : "WHERE user_id = $1 AND status = 'active'";
      const { rows } = await client.query(
        `SELECT
           id, user_id as "userId", provider, account_email as "accountEmail",
           encrypted_access_token as "encryptedAccessToken",
           encrypted_refresh_token as "encryptedRefreshToken",
           token_expires_at as "tokenExpiresAt",
           auth_metadata as "authMetadata",
           status, error_code as "errorCode", error_message as "errorMessage",
           last_sync_at as "lastSyncAt",
           created_at as "createdAt", updated_at as "updatedAt"
         FROM calendar_accounts
         ${whereClause}
         ORDER BY created_at ASC`,
        [userId]
      );
      return rows as unknown as CalendarAccount[];
    });
  }

  /**
   * Save or update a calendar account.
   */
  async saveAccount(
    userId: string,
    account: {
      provider: "google" | "caldav";
      accountEmail?: string | null;
      encryptedAccessToken?: string | null;
      encryptedRefreshToken?: string | null;
      tokenExpiresAt?: string | null;
      authMetadata?: Record<string, unknown>;
    }
  ): Promise<CalendarAccount> {
    return this.dbScope(userId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO calendar_accounts (
           user_id, provider, account_email, encrypted_access_token,
           encrypted_refresh_token, token_expires_at, auth_metadata, status,
           error_code, error_message
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', NULL, NULL)
         ON CONFLICT (user_id, provider, account_email)
         DO UPDATE SET
           encrypted_access_token = EXCLUDED.encrypted_access_token,
           encrypted_refresh_token = COALESCE(EXCLUDED.encrypted_refresh_token, calendar_accounts.encrypted_refresh_token),
           token_expires_at = EXCLUDED.token_expires_at,
           auth_metadata = EXCLUDED.auth_metadata,
           status = 'active',
           error_code = NULL,
           error_message = NULL,
           updated_at = now()
         RETURNING
           id, user_id as "userId", provider, account_email as "accountEmail",
           encrypted_access_token as "encryptedAccessToken",
           encrypted_refresh_token as "encryptedRefreshToken",
           token_expires_at as "tokenExpiresAt",
           auth_metadata as "authMetadata",
           status, error_code as "errorCode", error_message as "errorMessage",
           last_sync_at as "lastSyncAt",
           created_at as "createdAt", updated_at as "updatedAt"`,
        [
          userId,
          account.provider,
          account.accountEmail || null,
          account.encryptedAccessToken || null,
          account.encryptedRefreshToken || null,
          account.tokenExpiresAt || null,
          JSON.stringify(account.authMetadata || {}),
        ]
      );
      return rows[0] as unknown as CalendarAccount;
    });
  }

  /**
   * Update calendar account connection status and operational error details.
   */
  async updateAccountStatus(
    userId: string,
    accountId: string,
    status: CalendarAccountStatus,
    errorCode?: string | null,
    errorMessage?: string | null
  ): Promise<void> {
    await this.dbScope(userId, async (client) => {
      await client.query(
        `UPDATE calendar_accounts
         SET status = $1, error_code = $2, error_message = $3, updated_at = now()
         WHERE id = $4 AND user_id = $5`,
        [status, errorCode || null, errorMessage || null, accountId, userId]
      );
    });

    if (status === "reauth_required") {
      this.emitMetric({
        eventType: "calendar.oauth.reauth_required",
        userId,
        status,
        metadata: { accountId, errorCode },
      });
    }
  }

  /**
   * Disconnect a calendar provider without deleting internal Hevn tasks.
   */
  async disconnectAccount(userId: string, provider: "google" | "caldav"): Promise<boolean> {
    return this.dbScope(userId, async (client) => {
      const { rowCount } = await client.query(
        `UPDATE calendar_accounts
         SET status = 'disconnected', encrypted_access_token = NULL, encrypted_refresh_token = NULL, updated_at = now()
         WHERE user_id = $1 AND provider = $2`,
        [userId, provider]
      );
      return (rowCount ?? 0) > 0;
    });
  }

  /**
   * Discover and persist available calendars from the provider.
   */
  async discoverAndSyncCalendars(userId: string, accountId: string): Promise<ConnectedCalendar[]> {
    return this.dbScope(userId, async (client) => {
      const { rows: accRows } = await client.query(
        `SELECT
           id, user_id as "userId", provider, account_email as "accountEmail",
           encrypted_access_token as "encryptedAccessToken",
           encrypted_refresh_token as "encryptedRefreshToken",
           token_expires_at as "tokenExpiresAt",
           auth_metadata as "authMetadata",
           status
         FROM calendar_accounts
         WHERE id = $1 AND user_id = $2`,
        [accountId, userId]
      );

      const account = accRows[0] as unknown as CalendarAccount;
      if (!account || account.status !== "active") {
        throw new Error("Calendar account not found or inactive");
      }

      const provider = this.getProvider(account.provider);
      let discovered: DiscoveredCalendar[] = [];
      try {
        discovered = await provider.listCalendars(account);
      } catch (err: unknown) {
        if (err instanceof ReauthRequiredError) {
          await this.updateAccountStatus(userId, account.id, "reauth_required", "INVALID_GRANT", err.message);
        }
        throw err;
      }

      const connected: ConnectedCalendar[] = [];
      for (const disc of discovered) {
        const { rows } = await client.query(
          `INSERT INTO connected_calendars (
             account_id, user_id, external_calendar_id, name, color,
             is_primary, is_selected_for_sync, access_role
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (account_id, external_calendar_id)
           DO UPDATE SET
             name = EXCLUDED.name,
             color = EXCLUDED.color,
             is_primary = EXCLUDED.is_primary,
             access_role = EXCLUDED.access_role,
             updated_at = now()
           RETURNING
             id, account_id as "accountId", user_id as "userId",
             external_calendar_id as "externalCalendarId", name, color,
             is_primary as "isPrimary", is_selected_for_sync as "isSelectedForSync",
             access_role as "accessRole", sync_token as "syncToken",
             last_sync_at as "lastSyncAt", created_at as "createdAt", updated_at as "updatedAt"`,
          [
            accountId,
            userId,
            disc.id,
            disc.name,
            disc.color || null,
            disc.isPrimary,
            disc.isPrimary, // auto-select primary by default
            disc.accessRole,
          ]
        );
        connected.push(rows[0] as unknown as ConnectedCalendar);
      }

      return connected;
    });
  }

  /**
   * Get all connected calendars selected for sync under active accounts.
   */
  async getSelectedCalendars(userId: string): Promise<ConnectedCalendar[]> {
    return this.dbScope(userId, async (client) => {
      const { rows } = await client.query(
        `SELECT
           c.id, c.account_id as "accountId", c.user_id as "userId",
           c.external_calendar_id as "externalCalendarId", c.name, c.color,
           c.is_primary as "isPrimary", c.is_selected_for_sync as "isSelectedForSync",
           c.access_role as "accessRole", c.sync_token as "syncToken",
           c.last_sync_at as "lastSyncAt", c.created_at as "createdAt", c.updated_at as "updatedAt"
         FROM connected_calendars c
         JOIN calendar_accounts a ON c.account_id = a.id
         WHERE c.user_id = $1 AND c.is_selected_for_sync = true AND a.status = 'active'`,
        [userId]
      );
      return rows as unknown as ConnectedCalendar[];
    });
  }

  /**
   * List upcoming events from all selected external calendars within a time range.
   */
  async listUpcomingEvents(
    userId: string,
    timeMin: string,
    timeMax: string,
    limit: number = 20
  ): Promise<CalendarEvent[]> {
    const allAccounts = await this.getAccounts(userId, true);
    const activeAccounts = allAccounts.filter((a) => a.status === "active");

    // Check if user's account is in reauth_required state
    const reauthAccount = allAccounts.find((a) => a.status === "reauth_required");
    if (activeAccounts.length === 0 && reauthAccount) {
      throw new ReauthRequiredError(
        `Your ${reauthAccount.provider} calendar connection expired or was revoked. Please reconnect your calendar.`,
        reauthAccount.provider,
        reauthAccount.id
      );
    }

    if (activeAccounts.length === 0) return [];

    const calendars = await this.getSelectedCalendars(userId);
    if (calendars.length === 0) return [];

    // Get user timezone for accurate all-day event parsing
    let userTimezone = "UTC";
    try {
      userTimezone = await this.dbScope(userId, async (client) => {
        const { rows } = await client.query(`SELECT timezone FROM users WHERE id = $1`, [userId]);
        return (rows[0] as unknown as { timezone?: string })?.timezone || "UTC";
      });
    } catch {
      // default fallback
    }

    const allEvents: CalendarEvent[] = [];

    for (const cal of calendars) {
      const account = activeAccounts.find((a) => a.id === cal.accountId);
      if (!account) continue;

      try {
        const provider = this.getProvider(account.provider);
        const events = await provider.listEvents(
          account,
          cal.externalCalendarId,
          timeMin,
          timeMax,
          userTimezone
        );
        allEvents.push(...events);
      } catch (err: unknown) {
        if (err instanceof ReauthRequiredError) {
          await this.updateAccountStatus(userId, account.id, "reauth_required", "INVALID_GRANT", err.message);
          throw err;
        }
        logger.warn({ err, calendarId: cal.externalCalendarId }, "Failed to fetch calendar events");
      }
    }

    // Filter out cancelled events, sort chronologically, and apply limit
    return allEvents
      .filter((ev) => ev.status !== "cancelled")
      .sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime())
      .slice(0, limit);
  }

  /**
   * Check calendar availability and find free time slots.
   */
  async checkAvailability(
    userId: string,
    timeMin: string,
    timeMax: string,
    durationMinutes: number = 30
  ): Promise<CalendarAvailability> {
    const startMs = new Date(timeMin).getTime();
    const endMs = new Date(timeMax).getTime();

    // 1. Get user timezone
    let userTimezone = "UTC";
    try {
      userTimezone = await this.dbScope(userId, async (client) => {
        const { rows } = await client.query(`SELECT timezone FROM users WHERE id = $1`, [userId]);
        return (rows[0] as unknown as { timezone?: string })?.timezone || "UTC";
      });
    } catch {
      // default fallback in unit test environments
    }

    // 2. Fetch external calendar busy slots
    let externalEvents: CalendarEvent[] = [];
    try {
      externalEvents = await this.listUpcomingEvents(userId, timeMin, timeMax, 100);
    } catch (err: unknown) {
      if (err instanceof ReauthRequiredError) throw err;
      logger.warn({ err, userId }, "Could not fetch external events for availability check; falling back to internal tasks");
    }

    const busySlots: TimeSlot[] = [];
    const conflictingEvents: Array<{ title: string; startAt: string; endAt: string }> = [];

    for (const ev of externalEvents) {
      if (ev.transparency !== "transparent") {
        busySlots.push({ startAt: ev.startAt, endAt: ev.endAt });
        conflictingEvents.push({ title: ev.title, startAt: ev.startAt, endAt: ev.endAt });
      }
    }

    // 3. Fetch internal Hevn commitments/tasks in the window
    let internalTasks: Array<{ title: string; dueAt: string }> = [];
    try {
      internalTasks = await this.dbScope(userId, async (client) => {
        const { rows } = await client.query(
          `SELECT title, due_at as "dueAt"
           FROM tasks
           WHERE user_id = $1
             AND status IN ('pending', 'in_progress')
             AND due_at >= $2 AND due_at <= $3`,
          [userId, new Date(timeMin).toISOString(), new Date(timeMax).toISOString()]
        );
        return rows as unknown as Array<{ title: string; dueAt: string }>;
      });
    } catch {
      // default fallback
    }

    for (const task of internalTasks) {
      const due = new Date(task.dueAt).getTime();
      const slotStart = new Date(due - 15 * 60000).toISOString();
      const slotEnd = new Date(due + 15 * 60000).toISOString();
      busySlots.push({ startAt: slotStart, endAt: slotEnd });
      conflictingEvents.push({ title: task.title, startAt: slotStart, endAt: slotEnd });
    }

    // 4. Merge overlapping busy intervals
    const normalizedIntervals = busySlots
      .map((s) => ({
        start: Math.max(startMs, new Date(s.startAt).getTime()),
        end: Math.min(endMs, new Date(s.endAt).getTime()),
      }))
      .filter((i) => i.end > i.start)
      .sort((a, b) => a.start - b.start);

    const mergedBusy: Array<{ start: number; end: number }> = [];
    for (const interval of normalizedIntervals) {
      if (mergedBusy.length === 0) {
        mergedBusy.push({ ...interval });
      } else {
        const last = mergedBusy[mergedBusy.length - 1];
        if (interval.start <= last.end) {
          last.end = Math.max(last.end, interval.end);
        } else {
          mergedBusy.push({ ...interval });
        }
      }
    }

    // 5. Calculate free continuous slots
    const freeSlots: TimeSlot[] = [];
    const minDurationMs = durationMinutes * 60 * 1000;
    let currentPointer = startMs;

    for (const busy of mergedBusy) {
      if (busy.start - currentPointer >= minDurationMs) {
        freeSlots.push({
          startAt: new Date(currentPointer).toISOString(),
          endAt: new Date(busy.start).toISOString(),
        });
      }
      currentPointer = Math.max(currentPointer, busy.end);
    }

    if (endMs - currentPointer >= minDurationMs) {
      freeSlots.push({
        startAt: new Date(currentPointer).toISOString(),
        endAt: new Date(endMs).toISOString(),
      });
    }

    const isFree = mergedBusy.length === 0;

    return {
      timeZone: userTimezone,
      busySlots: mergedBusy.map((b) => ({
        startAt: new Date(b.start).toISOString(),
        endAt: new Date(b.end).toISOString(),
      })),
      freeSlots,
      isFree,
      conflictingEvents: conflictingEvents.length > 0 ? conflictingEvents : undefined,
    };
  }

  /**
   * Conflict-Aware Scheduling Foundation:
   * Finds available continuous free slots matching duration within a search window,
   * respecting external calendar busy periods, internal Hevn commitments/tasks,
   * optional buffer padding before/after meetings, and quiet hours.
   */
  async findAvailableSlots(
    userId: string,
    options: AvailabilityOptions
  ): Promise<TimeSlot[]> {
    const durationMinutes = options.durationMinutes ?? 30;
    const minDurationMs = durationMinutes * 60 * 1000;
    const startMs = new Date(options.timeMin).getTime();
    const endMs = new Date(options.timeMax).getTime();
    const bufferMs = (options.preferences?.bufferMinutes ?? 0) * 60 * 1000;
    const maxSlots = options.preferences?.maxSlots ?? 5;

    // 1. Resolve user timezone and quiet hours
    let _userTimezone = options.userTimezone || "UTC";
    let quietHoursStart: string | null = null;
    let quietHoursEnd: string | null = null;

    try {
      const userMeta = await this.dbScope(userId, async (client) => {
        const { rows } = await client.query(
          `SELECT timezone, quiet_hours_start, quiet_hours_end FROM users WHERE id = $1`,
          [userId]
        );
        return rows[0];
      });
      if (userMeta) {
        _userTimezone = userMeta.timezone || _userTimezone;
        quietHoursStart = userMeta.quiet_hours_start;
        quietHoursEnd = userMeta.quiet_hours_end;
      }
    } catch {
      // default in test environments
    }

    // 2. Fetch external busy events
    let externalEvents: CalendarEvent[] = [];
    try {
      externalEvents = await this.listUpcomingEvents(userId, options.timeMin, options.timeMax, 100);
    } catch {
      // continue with internal tasks
    }

    const busyIntervals: Array<{ start: number; end: number }> = [];

    for (const ev of externalEvents) {
      if (ev.transparency !== "transparent") {
        const evStart = new Date(ev.startAt).getTime() - bufferMs;
        const evEnd = new Date(ev.endAt).getTime() + bufferMs;
        busyIntervals.push({
          start: Math.max(startMs, evStart),
          end: Math.min(endMs, evEnd),
        });
      }
    }

    // 3. Fetch internal commitments & high-priority tasks
    try {
      const internalTasks = await this.dbScope(userId, async (client) => {
        const { rows } = await client.query(
          `SELECT title, due_at as "dueAt"
           FROM tasks
           WHERE user_id = $1
             AND status IN ('pending', 'in_progress')
             AND due_at >= $2 AND due_at <= $3`,
          [userId, new Date(options.timeMin).toISOString(), new Date(options.timeMax).toISOString()]
        );
        return rows as unknown as Array<{ title: string; dueAt: string }>;
      });

      for (const t of internalTasks) {
        const due = new Date(t.dueAt).getTime();
        const tStart = due - 15 * 60000 - bufferMs;
        const tEnd = due + 15 * 60000 + bufferMs;
        busyIntervals.push({
          start: Math.max(startMs, tStart),
          end: Math.min(endMs, tEnd),
        });
      }
    } catch {
      // default in test environments
    }

    // 4. Map quiet hours into busy intervals if enabled
    const respectQuietHours = options.preferences?.respectQuietHours ?? true;
    if (respectQuietHours && quietHoursStart && quietHoursEnd) {
      // Scan each day in the search window (and 1 day before/after to cover overnight spans)
      const scanStart = new Date(startMs - 86400000);
      const scanEnd = new Date(endMs + 86400000);
      const curr = new Date(scanStart);

      while (curr.getTime() <= scanEnd.getTime()) {
        const dateStr = curr.toISOString().split("T")[0];
        const nextDay = new Date(curr.getTime() + 86400000);
        const nextDateStr = nextDay.toISOString().split("T")[0];

        const [startH, startM] = quietHoursStart.split(":").map(Number);
        const [endH, endM] = quietHoursEnd.split(":").map(Number);

        if (startH < endH || (startH === endH && startM < endM)) {
          // Same-day quiet hours (e.g. 13:00 to 15:00)
          const qStartMs = new Date(`${dateStr}T${quietHoursStart}:00.000Z`).getTime();
          const qEndMs = new Date(`${dateStr}T${quietHoursEnd}:00.000Z`).getTime();
          if (qEndMs > startMs && qStartMs < endMs) {
            busyIntervals.push({
              start: Math.max(startMs, qStartMs),
              end: Math.min(endMs, qEndMs),
            });
          }
        } else {
          // Overnight quiet hours (e.g. 22:00 to 07:00 next morning)
          const qStartMs = new Date(`${dateStr}T${quietHoursStart}:00.000Z`).getTime();
          const qEndMs = new Date(`${nextDateStr}T${quietHoursEnd}:00.000Z`).getTime();
          if (qEndMs > startMs && qStartMs < endMs) {
            busyIntervals.push({
              start: Math.max(startMs, qStartMs),
              end: Math.min(endMs, qEndMs),
            });
          }
        }
        curr.setDate(curr.getDate() + 1);
      }
    }

    // 5. Merge all overlapping busy intervals
    const sorted = busyIntervals
      .filter((i) => i.end > i.start)
      .sort((a, b) => a.start - b.start);

    const merged: Array<{ start: number; end: number }> = [];
    for (const interval of sorted) {
      if (merged.length === 0) {
        merged.push({ ...interval });
      } else {
        const last = merged[merged.length - 1];
        if (interval.start <= last.end) {
          last.end = Math.max(last.end, interval.end);
        } else {
          merged.push({ ...interval });
        }
      }
    }

    // 6. Find free contiguous slots
    const availableSlots: TimeSlot[] = [];
    let pointer = startMs;

    for (const busy of merged) {
      if (busy.start - pointer >= minDurationMs) {
        // Break into slots of requested duration
        let slotStart = pointer;
        while (slotStart + minDurationMs <= busy.start && availableSlots.length < maxSlots) {
          availableSlots.push({
            startAt: new Date(slotStart).toISOString(),
            endAt: new Date(slotStart + minDurationMs).toISOString(),
          });
          slotStart += minDurationMs;
        }
      }
      pointer = Math.max(pointer, busy.end);
      if (availableSlots.length >= maxSlots) break;
    }

    if (pointer + minDurationMs <= endMs && availableSlots.length < maxSlots) {
      let slotStart = pointer;
      while (slotStart + minDurationMs <= endMs && availableSlots.length < maxSlots) {
        availableSlots.push({
          startAt: new Date(slotStart).toISOString(),
          endAt: new Date(slotStart + minDurationMs).toISOString(),
        });
        slotStart += minDurationMs;
      }
    }

    return availableSlots;
  }

  /**
   * Create an event directly on the user's primary or selected external calendar.
   */
  async createCalendarEvent(
    userId: string,
    input: {
      title: string;
      startAt: string;
      endAt: string;
      description?: string;
      location?: string;
      calendarId?: string;
    }
  ): Promise<CalendarEvent> {
    const accounts = await this.getAccounts(userId);
    if (accounts.length === 0) {
      throw new Error("No connected calendar account found. Please connect your calendar first.");
    }

    const calendars = await this.getSelectedCalendars(userId);
    if (calendars.length === 0) {
      throw new Error("No calendar selected for sync.");
    }

    const targetCal =
      calendars.find((c) => c.id === input.calendarId || c.externalCalendarId === input.calendarId) ||
      calendars.find((c) => c.isPrimary) ||
      calendars[0];

    const account = accounts.find((a) => a.id === targetCal.accountId);
    if (!account) {
      throw new Error("Target calendar account is not available");
    }

    const provider = this.getProvider(account.provider);
    try {
      const created = await provider.createEvent(account, targetCal.externalCalendarId, {
        calendarId: targetCal.externalCalendarId,
        title: input.title,
        description: input.description || null,
        startAt: new Date(input.startAt).toISOString(),
        endAt: new Date(input.endAt).toISOString(),
        isAllDay: false,
        status: "confirmed",
        location: input.location || null,
        transparency: "opaque",
      });

      return created;
    } catch (err: unknown) {
      if (err instanceof ReauthRequiredError) {
        await this.updateAccountStatus(userId, account.id, "reauth_required", "INVALID_GRANT", err.message);
      }
      throw err;
    }
  }

  /**
   * Push a Hevn commitment to connected external calendar(s) idempotently.
   */
  async syncCommitmentToCalendar(userId: string, task: Task): Promise<CalendarEventLink | null> {
    const calendars = await this.getSelectedCalendars(userId);
    if (calendars.length === 0) return null;

    const primaryCal = calendars.find((c) => c.isPrimary) || calendars[0];
    const accounts = await this.getAccounts(userId);
    const account = accounts.find((a) => a.id === primaryCal.accountId);
    if (!account) return null;

    return this.dbScope(userId, async (client) => {
      // Check existing link
      const { rows: existingLinks } = await client.query(
        `SELECT * FROM calendar_event_links
         WHERE user_id = $1 AND task_id = $2 AND calendar_id = $3`,
        [userId, task.id, primaryCal.id]
      );

      const provider = this.getProvider(account.provider);
      const startIso = new Date(task.dueAt).toISOString();
      const endIso = new Date(new Date(task.dueAt).getTime() + 60 * 60000).toISOString(); // 1 hour event
      const eventTitle = task.status === "done" ? `[Done] ${task.title}` : task.title;

      if (existingLinks.length > 0) {
        const link = existingLinks[0] as unknown as {
          id: string;
          external_event_id: string;
          created_at: string;
        };
        try {
          const updated = await provider.updateEvent(
            account,
            primaryCal.externalCalendarId,
            link.external_event_id,
            {
              title: eventTitle,
              startAt: startIso,
              endAt: endIso,
            }
          );
          await client.query(
            `UPDATE calendar_event_links
             SET external_event_etag = $1, sync_status = 'synced', last_synced_at = now(), updated_at = now()
             WHERE id = $2`,
            [updated.etag || null, link.id]
          );
          return {
            id: link.id,
            userId,
            calendarId: primaryCal.id,
            taskId: task.id,
            externalEventId: link.external_event_id,
            syncStatus: "synced",
            lastSyncedAt: new Date().toISOString(),
            createdAt: link.created_at,
            updatedAt: new Date().toISOString(),
          };
        } catch (err) {
          if (err instanceof ReauthRequiredError) {
            await this.updateAccountStatus(userId, account.id, "reauth_required", "INVALID_GRANT", err.message);
          }
          logger.warn({ err, taskId: task.id }, "Failed to update external calendar event for task");
          return null;
        }
      }

      // Create new event
      try {
        const created = await provider.createEvent(account, primaryCal.externalCalendarId, {
          calendarId: primaryCal.externalCalendarId,
          title: eventTitle,
          description: `Synced from Hevn (Task ID: ${task.id})`,
          startAt: startIso,
          endAt: endIso,
          isAllDay: false,
          status: "confirmed",
          transparency: "opaque",
        });

        const { rows: newLinkRows } = await client.query(
          `INSERT INTO calendar_event_links (
             user_id, calendar_id, task_id, external_event_id, external_event_etag, sync_status
           )
           VALUES ($1, $2, $3, $4, $5, 'synced')
           ON CONFLICT (calendar_id, external_event_id)
           DO UPDATE SET
             task_id = EXCLUDED.task_id,
             sync_status = 'synced',
             last_synced_at = now(),
             updated_at = now()
           RETURNING
             id, user_id as "userId", calendar_id as "calendarId",
             task_id as "taskId", external_event_id as "externalEventId",
             external_event_etag as "externalEventEtag",
             sync_status as "syncStatus", last_synced_at as "lastSyncedAt",
             created_at as "createdAt", updated_at as "updatedAt"`,
          [userId, primaryCal.id, task.id, created.id, created.etag || null]
        );

        return newLinkRows[0] as unknown as CalendarEventLink;
      } catch (err) {
        if (err instanceof ReauthRequiredError) {
          await this.updateAccountStatus(userId, account.id, "reauth_required", "INVALID_GRANT", err.message);
        }
        logger.warn({ err, taskId: task.id }, "Failed to create external calendar event for task");
        return null;
      }
    });
  }

  /**
   * Delete an external calendar event.
   */
  async deleteCalendarEvent(
    userId: string,
    calendarId: string,
    eventId: string
  ): Promise<boolean> {
    const accounts = await this.getAccounts(userId);
    if (accounts.length === 0) return false;

    const calendars = await this.getSelectedCalendars(userId);
    const targetCal = calendars.find(
      (c) => c.id === calendarId || c.externalCalendarId === calendarId
    );
    if (!targetCal) return false;

    const account = accounts.find((a) => a.id === targetCal.accountId);
    if (!account) return false;

    const provider = this.getProvider(account.provider);
    try {
      const deleted = await provider.deleteEvent(account, targetCal.externalCalendarId, eventId);

      if (deleted) {
        await this.dbScope(userId, async (client) => {
          await client.query(
            `DELETE FROM calendar_event_links
             WHERE user_id = $1 AND calendar_id = $2 AND external_event_id = $3`,
            [userId, targetCal.id, eventId]
          );
        });
      }

      return deleted;
    } catch (err: unknown) {
      if (err instanceof ReauthRequiredError) {
        await this.updateAccountStatus(userId, account.id, "reauth_required", "INVALID_GRANT", err.message);
      }
      throw err;
    }
  }
}
