import test from "node:test";
import assert from "node:assert/strict";
import { NotificationDeduplicationService } from "../src/core/notifications/NotificationDeduplicationService";

test("NotificationDeduplicationService — Atomic Deduplication, Lock Claiming & Rate Tracking", async (t) => {
  const dedupDb: any[] = [];

  const mockDbQuery = async (rawSql: string, params?: any[]): Promise<{ rows: any[] }> => {
    const sql = rawSql.replace(/\s+/g, " ");

    // 1. INSERT ON CONFLICT DO NOTHING
    if (sql.includes("INSERT INTO notification_dedup_log")) {
      const userId = params![0];
      const dedupKey = params![1];
      const channel = params![2];
      const category = params![3];

      const exists = dedupDb.find((r) => r.user_id === userId && r.dedup_key === dedupKey);
      if (exists) {
        return { rows: [] }; // collision
      }

      const record = {
        id: `dedup-${dedupDb.length + 1}`,
        user_id: userId,
        dedup_key: dedupKey,
        channel,
        category,
        status: "pending",
        payload_summary: null,
        delivered_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      };
      dedupDb.push(record);
      return { rows: [record] };
    }

    // 2. UPDATE status
    if (sql.includes("UPDATE notification_dedup_log SET status = $1")) {
      const status = params![0];
      const summary = params![1];
      const userId = params![2];
      const dedupKey = params![3];

      const match = dedupDb.find((r) => r.user_id === userId && r.dedup_key === dedupKey);
      if (match) {
        match.status = status;
        match.payload_summary = summary;
        match.delivered_at = new Date().toISOString();
        return { rows: [match] };
      }
      return { rows: [] };
    }

    // 3. SELECT isDelivered
    if (sql.includes("FROM notification_dedup_log WHERE user_id = $1 AND dedup_key = $2")) {
      const userId = params![0];
      const dedupKey = params![1];
      const match = dedupDb.find((r) => r.user_id === userId && r.dedup_key === dedupKey && (r.status === "delivered" || r.status === "batched"));
      return { rows: match ? [match] : [] };
    }

    // 4. COUNT recent notifications
    if (sql.includes("COUNT(*) as count FROM notification_dedup_log")) {
      const userId = params![0];
      const deliveredCount = dedupDb.filter((r) => r.user_id === userId && r.status === "delivered").length;
      return { rows: [{ count: deliveredCount }] };
    }

    // 5. Last notification timestamp
    if (sql.includes("SELECT delivered_at FROM notification_dedup_log WHERE user_id = $1 AND dedup_key LIKE $2")) {
      const userId = params![0];
      const prefix = params![1];
      const matched = dedupDb
        .filter((r) => r.user_id === userId && r.dedup_key.startsWith(prefix))
        .sort((a, b) => new Date(b.delivered_at).getTime() - new Date(a.delivered_at).getTime());

      return { rows: matched.length > 0 ? [matched[0]] : [] };
    }

    return { rows: [] };
  };

  const service = new NotificationDeduplicationService(mockDbQuery);

  await t.test("claims notification atomically and rejects duplicate delivery attempts", async () => {
    const userId = "user-123";
    const dedupKey = "reminder:task-100:2026-08-26T10:00:00Z";

    // 1. First worker claims lock
    const claimedFirst = await service.claimNotification(userId, dedupKey, "telegram", "reminder");
    assert.strictEqual(claimedFirst, true);

    // 2. Second worker attempts same lock -> suppressed
    const claimedSecond = await service.claimNotification(userId, dedupKey, "telegram", "reminder");
    assert.strictEqual(claimedSecond, false);

    // 3. Record delivery outcome
    await service.recordOutcome(userId, dedupKey, "delivered", "Reminder for Math homework sent");
    const isDelivered = await service.isDelivered(userId, dedupKey);
    assert.strictEqual(isDelivered, true);
  });

  await t.test("tracks recent notification volume and latest follow-up timestamps", async () => {
    const userId = "user-456";
    await service.claimNotification(userId, "followup:task-99:att-1", "whatsapp", "follow_up");
    await service.recordOutcome(userId, "followup:task-99:att-1", "delivered");

    const recentCount = await service.getRecentNotificationCount(userId, 60);
    assert.strictEqual(recentCount, 1);

    const lastTimestamp = await service.getLastNotificationTimestamp(userId, "followup:task-99");
    assert.ok(lastTimestamp !== null);
    assert.ok(lastTimestamp.getTime() <= Date.now());
  });
});
