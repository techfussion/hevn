import { getPool, withUserScope } from "../../db/pool";
import type { User, OnboardingState, UserPersona, FollowUpPreference, ResponseMode, UserVoicePreferences } from "../../types/domain";

const DEFAULT_TIMEZONE = "UTC";

export class UserService {
  async getOrCreate(platform: "telegram" | "whatsapp", platformUserId: string): Promise<User> {
    const pool = getPool();

    const existing = await pool.query(
      `SELECT * FROM users WHERE platform = $1 AND platform_user_id = $2`,
      [platform, platformUserId]
    );
    if (existing.rows[0]) return mapRow(existing.rows[0]);

    try {
      const inserted = await pool.query(
        `INSERT INTO users (platform, platform_user_id, timezone, onboarding_state, assistant_name, persona, preferred_checkin_time, preferred_checkin_hour, plan, followup_preference, response_mode, voice_enabled)
         VALUES ($1, $2, $3, 'WELCOME', 'Hevn', 'professional', '06:00', 6, 'free', 'active', 'auto', true)
         RETURNING *`,
        [platform, platformUserId, DEFAULT_TIMEZONE]
      );
      return mapRow(inserted.rows[0]);
    } catch (err: unknown) {
      const isUniqueViolation = err && typeof err === "object" && "code" in err && err.code === "23505";
      if (isUniqueViolation) {
        const retry = await pool.query(
          `SELECT * FROM users WHERE platform = $1 AND platform_user_id = $2`,
          [platform, platformUserId]
        );
        if (retry.rows[0]) return mapRow(retry.rows[0]);
      }
      throw err;
    }
  }

  async setOnboardingState(userId: string, state: OnboardingState): Promise<void> {
    const isOnboarded = state === "COMPLETED";
    await withUserScope(userId, async (client) => {
      await client.query(
        `UPDATE users SET onboarding_state = $1, onboarded = $2 WHERE id = $3`,
        [state, isOnboarded, userId]
      );
    });
  }

  async setAssistantName(userId: string, assistantName: string): Promise<void> {
    await withUserScope(userId, async (client) => {
      await client.query(
        `UPDATE users SET assistant_name = $1, bot_persona = $1 WHERE id = $2`,
        [assistantName, userId]
      );
    });
  }

  async setPersona(userId: string, persona: UserPersona): Promise<void> {
    await withUserScope(userId, async (client) => {
      await client.query(
        `UPDATE users SET persona = $1 WHERE id = $2`,
        [persona, userId]
      );
    });
  }

  async setCheckinTime(userId: string, timeStr: string, hour: number): Promise<void> {
    const clampedHour = Math.min(Math.max(Math.floor(hour), 0), 23);
    await withUserScope(userId, async (client) => {
      await client.query(
        `UPDATE users SET preferred_checkin_time = $1, preferred_checkin_hour = $2 WHERE id = $3`,
        [timeStr, clampedHour, userId]
      );
    });
  }

  async completeRegistration(
    userId: string,
    displayName: string,
    timezone: string,
    botPersona: string,
    persona: UserPersona = "professional"
  ): Promise<void> {
    await withUserScope(userId, async (client) => {
      await client.query(
        `UPDATE users
         SET display_name = $1, timezone = $2, assistant_name = $3, bot_persona = $3, persona = $4, onboarded = true, onboarding_state = 'COMPLETED'
         WHERE id = $5`,
        [displayName.slice(0, 100), timezone, botPersona, persona, userId]
      );
    });
  }

  async setCheckinHour(userId: string, hour: number): Promise<void> {
    const clamped = Math.min(Math.max(Math.floor(hour), 0), 23);
    const formatted = `${String(clamped).padStart(2, "0")}:00`;
    await withUserScope(userId, async (client) => {
      await client.query(
        `UPDATE users SET preferred_checkin_hour = $1, preferred_checkin_time = $2 WHERE id = $3`,
        [clamped, formatted, userId]
      );
    });
  }

  async setTimezone(userId: string, timezone: string): Promise<void> {
    await withUserScope(userId, async (client) => {
      await client.query(`UPDATE users SET timezone = $1 WHERE id = $2`, [timezone, userId]);
    });
  }

  async setDisplayName(userId: string, displayName: string): Promise<void> {
    await withUserScope(userId, async (client) => {
      await client.query(`UPDATE users SET display_name = $1 WHERE id = $2`, [
        displayName.slice(0, 100),
        userId,
      ]);
    });
  }

  async setFollowUpPreference(userId: string, preference: FollowUpPreference): Promise<void> {
    await withUserScope(userId, async (client) => {
      await client.query(`UPDATE users SET followup_preference = $1 WHERE id = $2`, [
        preference,
        userId,
      ]);
    });
  }

  async setQuietHours(userId: string, start: string | null, end: string | null): Promise<void> {
    await withUserScope(userId, async (client) => {
      await client.query(`UPDATE users SET quiet_hours_start = $1, quiet_hours_end = $2 WHERE id = $3`, [
        start,
        end,
        userId,
      ]);
    });
  }

  async setVoicePreferences(
    userId: string,
    prefs: Partial<UserVoicePreferences>
  ): Promise<void> {
    await withUserScope(userId, async (client) => {
      const updates: string[] = [];
      const values: unknown[] = [];
      let idx = 1;

      if (prefs.responseMode !== undefined) {
        updates.push(`response_mode = $${idx++}`);
        values.push(prefs.responseMode);
      }
      if (prefs.voiceEnabled !== undefined) {
        updates.push(`voice_enabled = $${idx++}`);
        values.push(prefs.voiceEnabled);
      }
      if (prefs.voiceName !== undefined) {
        updates.push(`voice_name = $${idx++}`);
        values.push(prefs.voiceName);
      }
      if (prefs.voiceLanguage !== undefined) {
        updates.push(`voice_language = $${idx++}`);
        values.push(prefs.voiceLanguage);
      }

      if (updates.length === 0) return;

      values.push(userId);
      await client.query(
        `UPDATE users SET ${updates.join(", ")} WHERE id = $${idx}`,
        values
      );
    });
  }

  async tryAcquireUpdate(updateId: string, platform: "telegram" | "whatsapp"): Promise<boolean> {
    const pool = getPool();
    try {
      const res = await pool.query(
        `INSERT INTO processed_updates (id, platform) VALUES ($1, $2)
         ON CONFLICT (id) DO NOTHING
         RETURNING id`,
        [updateId, platform]
      );
      return (res.rowCount ?? 0) > 0;
    } catch {
      // Fallback: if table is missing or DB blips, permit processing rather than dropping
      return true;
    }
  }
}

function mapRow(row: Record<string, unknown>): User {
  const assistantName = (row.assistant_name as string) || (row.bot_persona as string) || "Hevn";
  const preferredCheckinHour = typeof row.preferred_checkin_hour === "number" ? row.preferred_checkin_hour : 6;
  const preferredCheckinTime = (row.preferred_checkin_time as string) || `${String(preferredCheckinHour).padStart(2, "0")}:00`;
  const persona = ((row.persona as string) || "professional") as UserPersona;
  const onboardingState = ((row.onboarding_state as string) || (row.onboarded ? "COMPLETED" : "WELCOME")) as OnboardingState;
  const followupPreference = ((row.followup_preference as string) || "active") as FollowUpPreference;
  const responseMode = ((row.response_mode as string) || "auto") as ResponseMode;
  const voiceEnabled = row.voice_enabled !== false; // defaults to true unless explicitly false

  return {
    id: row.id as string,
    platform: row.platform as "telegram" | "whatsapp",
    platformUserId: row.platform_user_id as string,
    displayName: (row.display_name as string | null) ?? null,
    timezone: (row.timezone as string) ?? DEFAULT_TIMEZONE,
    onboarded: Boolean(row.onboarded) || onboardingState === "COMPLETED",
    onboardingState,
    assistantName,
    botPersona: assistantName,
    persona,
    preferredCheckinTime,
    preferredCheckinHour,
    plan: ((row.plan as string) || "free") as "free" | "pro",
    followupPreference,
    quietHoursStart: (row.quiet_hours_start as string | null) ?? null,
    quietHoursEnd: (row.quiet_hours_end as string | null) ?? null,
    responseMode,
    voiceEnabled,
    voiceName: (row.voice_name as string | null) ?? null,
    voiceLanguage: (row.voice_language as string | null) ?? null,
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : new Date(String(row.created_at ?? Date.now())).toISOString(),
  };
}
