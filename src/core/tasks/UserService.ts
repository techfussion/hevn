import { getPool, withUserScope } from "../../db/pool";
import type { User } from "../../types/domain";

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
        `INSERT INTO users (platform, platform_user_id, timezone) VALUES ($1, $2, $3) RETURNING *`,
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

  async completeRegistration(
    userId: string,
    displayName: string,
    timezone: string,
    botPersona: string
  ): Promise<void> {
    await withUserScope(userId, async (client) => {
      await client.query(
        `UPDATE users SET display_name = $1, timezone = $2, bot_persona = $3, onboarded = true WHERE id = $4`,
        [displayName.slice(0, 100), timezone, botPersona, userId]
      );
    });
  }

  async setCheckinHour(userId: string, hour: number): Promise<void> {
    const clamped = Math.min(Math.max(Math.floor(hour), 0), 23);
    await withUserScope(userId, async (client) => {
      await client.query(`UPDATE users SET preferred_checkin_hour = $1 WHERE id = $2`, [clamped, userId]);
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
  return {
    id: row.id as string,
    platform: row.platform as "telegram" | "whatsapp",
    platformUserId: row.platform_user_id as string,
    displayName: (row.display_name as string | null) ?? null,
    timezone: (row.timezone as string) ?? DEFAULT_TIMEZONE,
    onboarded: Boolean(row.onboarded),
    botPersona: (row.bot_persona as string) || "Hevn",
    preferredCheckinHour: typeof row.preferred_checkin_hour === "number" ? row.preferred_checkin_hour : 8,
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : new Date(String(row.created_at ?? Date.now())).toISOString(),
  };
}