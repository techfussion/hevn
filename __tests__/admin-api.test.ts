import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { AdminService } from "../src/core/admin/AdminService";
import { createAdminRouter } from "../src/api/adminRouter";

test("Admin API — Authentication, Authorization & Security", async (t) => {
  const originalAdminKey = process.env.ADMIN_API_KEY;
  const testAdminKey = "super_secure_test_admin_api_key_32bytes_long";
  process.env.ADMIN_API_KEY = testAdminKey;

  t.after(() => {
    process.env.ADMIN_API_KEY = originalAdminKey;
  });

  const mockAdminService = {
    async getDashboardMetrics() {
      return {
        users: {
          total: 42,
          newToday: 5,
          newThisWeek: 12,
          newThisMonth: 30,
          dau: 15,
          wau: 28,
          mau: 39,
          onboardedRate: 85,
          byPlatform: { telegram: 30, whatsapp: 12 },
          byPersona: { student: 25, executive_assistant: 10, professional: 7 },
        },
        engagement: {
          totalTasks: 180,
          completedTasks: 145,
          followThroughRate: 81,
          totalFollowUps: 90,
          completedFollowUps: 75,
          activeProjects: 8,
          totalMemories: 60,
          totalStudySessions: 35,
          completedQuizzes: 20,
          averageQuizScore: 84,
          messagesProcessed: 540,
        },
        timestamp: new Date().toISOString(),
      };
    },
    async getSystemHealth() {
      return {
        status: "healthy",
        database: { connected: true, latencyMs: 2 },
        jobQueue: { pending: 0, active: 1, failed: 0, retrying: 0, deadLetter: 0 },
        integrations: {
          telegram: { configured: true },
          whatsapp: { configured: false },
          googleCalendar: { configured: true, totalAccounts: 10, activeAccounts: 9, reauthRequiredAccounts: 1 },
          voiceSynthesis: { providers: [{ name: "elevenlabs", state: "CLOSED", isHealthy: true }] },
        },
        timestamp: new Date().toISOString(),
      };
    },
    async getUsersList(page: number, limit: number) {
      return {
        users: [
          {
            id: "u-1",
            platform: "telegram",
            displayName: "Test User",
            persona: "student",
            plan: "free",
            onboarded: true,
            responseMode: "auto",
            createdAt: new Date().toISOString(),
            taskCount: 10,
            completedTaskCount: 8,
            calendarConnected: true,
            studyCourseCount: 2,
          },
        ],
        total: 1,
        page,
        limit,
      };
    },
  } as unknown as AdminService;

  const app = express();
  app.use(express.json());
  app.use("/api/admin", createAdminRouter(mockAdminService));

  const server = app.listen(0);
  const port = (server.address() as any).port;
  const baseUrl = `http://localhost:${port}/api/admin`;

  t.after(() => {
    server.close();
  });

  await t.test("rejects request without administrative credentials with 401 Unauthorized", async () => {
    const res = await fetch(`${baseUrl}/metrics`);
    assert.strictEqual(res.status, 401);
    const body = await res.json() as any;
    assert.strictEqual(body.error, "Unauthorized");
  });

  await t.test("rejects request with invalid admin key with 401 Unauthorized", async () => {
    const res = await fetch(`${baseUrl}/metrics`, {
      headers: { "X-Admin-Key": "wrong_key_123456789012345678901234" },
    });
    assert.strictEqual(res.status, 401);
  });

  await t.test("allows authorized access via X-Admin-Key header and returns valid metrics", async () => {
    const res = await fetch(`${baseUrl}/metrics`, {
      headers: { "X-Admin-Key": testAdminKey },
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json() as any;
    assert.strictEqual(data.users.total, 42);
    assert.strictEqual(data.engagement.followThroughRate, 81);
    assert.strictEqual(data.users.byPlatform.telegram, 30);
  });

  await t.test("allows authorized access via Authorization Bearer token header", async () => {
    const res = await fetch(`${baseUrl}/health`, {
      headers: { Authorization: `Bearer ${testAdminKey}` },
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json() as any;
    assert.strictEqual(data.status, "healthy");
    assert.strictEqual(data.database.connected, true);
  });

  await t.test("returns sanitized user metadata and does not expose passwords, tokens or conversations", async () => {
    const res = await fetch(`${baseUrl}/users?page=1&limit=10`, {
      headers: { "X-Admin-Key": testAdminKey },
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json() as any;
    assert.strictEqual(data.users.length, 1);
    const user = data.users[0];
    assert.strictEqual(user.id, "u-1");
    assert.strictEqual(user.displayName, "Test User");
    assert.strictEqual(user.taskCount, 10);
    assert.strictEqual(user.password, undefined);
    assert.strictEqual(user.accessToken, undefined);
    assert.strictEqual(user.refreshToken, undefined);
    assert.strictEqual(user.conversations, undefined);
  });
});
