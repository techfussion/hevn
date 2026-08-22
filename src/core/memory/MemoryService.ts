import { z } from "zod";
import { withUserScope } from "../../db/pool";
import type { UserMemory, MemoryCategory } from "../../types/domain";

const memorySchema = z.object({
  category: z.enum(["fact", "person", "project", "preference", "general"]).default("general"),
  content: z.string().min(1).max(1000),
  key: z.string().min(1).max(100).nullable().optional(),
});

export class MemoryService {
  async storeMemory(userId: string, input: unknown): Promise<UserMemory> {
    const parsed = memorySchema.parse(input);

    return withUserScope(userId, async (client) => {
      // If a key is provided and exists, update it; otherwise insert
      if (parsed.key) {
        const existing = await client.query(
          `SELECT id FROM user_memories WHERE user_id = $1 AND key = $2 LIMIT 1`,
          [userId, parsed.key]
        );
        if (existing.rows[0]) {
          const { rows } = await client.query(
            `UPDATE user_memories
             SET content = $1, category = $2, updated_at = now()
             WHERE id = $3 RETURNING *`,
            [parsed.content, parsed.category, existing.rows[0].id]
          );
          return mapMemoryRow(rows[0]);
        }
      }

      const { rows } = await client.query(
        `INSERT INTO user_memories (user_id, category, content, key)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [userId, parsed.category, parsed.content, parsed.key ?? null]
      );
      return mapMemoryRow(rows[0]);
    });
  }

  async getMemories(userId: string, category?: MemoryCategory, limit = 20): Promise<UserMemory[]> {
    const safeLimit = Math.min(Math.max(limit, 1), 50);

    return withUserScope(userId, async (client) => {
      if (category) {
        const { rows } = await client.query(
          `SELECT * FROM user_memories WHERE user_id = $1 AND category = $2 ORDER BY updated_at DESC LIMIT $3`,
          [userId, category, safeLimit]
        );
        return rows.map(mapMemoryRow);
      }

      const { rows } = await client.query(
        `SELECT * FROM user_memories WHERE user_id = $1 ORDER BY updated_at DESC LIMIT $2`,
        [userId, safeLimit]
      );
      return rows.map(mapMemoryRow);
    });
  }

  async forgetMemory(userId: string, memoryId: string): Promise<boolean> {
    if (!isUuid(memoryId)) return false;

    return withUserScope(userId, async (client) => {
      const { rowCount } = await client.query(
        `DELETE FROM user_memories WHERE id = $1 AND user_id = $2`,
        [memoryId, userId]
      );
      return (rowCount ?? 0) > 0;
    });
  }

  async forgetMemoryByKey(userId: string, key: string): Promise<boolean> {
    const sanitizedKey = key.trim();
    if (!sanitizedKey) return false;

    return withUserScope(userId, async (client) => {
      const { rowCount } = await client.query(
        `DELETE FROM user_memories WHERE user_id = $1 AND (key ILIKE $2 OR content ILIKE ('%' || $2 || '%'))`,
        [userId, sanitizedKey]
      );
      return (rowCount ?? 0) > 0;
    });
  }

  async searchMemories(userId: string, query: string): Promise<UserMemory[]> {
    const q = query.trim();
    if (!q) return this.getMemories(userId);

    return withUserScope(userId, async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM user_memories
         WHERE user_id = $1 AND (content ILIKE ('%' || $2 || '%') OR key ILIKE ('%' || $2 || '%'))
         ORDER BY updated_at DESC
         LIMIT 10`,
        [userId, q]
      );
      return rows.map(mapMemoryRow);
    });
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function mapMemoryRow(row: Record<string, unknown>): UserMemory {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    category: row.category as MemoryCategory,
    content: row.content as string,
    key: (row.key as string | null) ?? null,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}
