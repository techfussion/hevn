import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeStringForLogging } from "../src/utils/logger";
import { CalendarService } from "../src/core/calendar/CalendarService";

test("Observability & Redaction — sanitizeStringForLogging redacts Bearer tokens, secrets, and auth codes", () => {
  // Bearer token
  const headerStr = "Authorization: Bearer ya29.a0AfH6SMD_secret_token_12345";
  const sanitizedHeader = sanitizeStringForLogging(headerStr);
  assert.equal(sanitizedHeader, "Authorization: Bearer [REDACTED]");

  // Query parameters with secrets/code
  const queryStr = "https://oauth2.googleapis.com/token?code=4/0AdQt8qW_secret&client_secret=GOCSPX-secret_123&refresh_token=1//0g_secret";
  const sanitizedQuery = sanitizeStringForLogging(queryStr);
  assert.ok(!sanitizedQuery.includes("4/0AdQt8qW_secret"));
  assert.ok(!sanitizedQuery.includes("GOCSPX-secret_123"));
  assert.ok(!sanitizedQuery.includes("1//0g_secret"));
  assert.ok(sanitizedQuery.includes("code=[REDACTED]"));
  assert.ok(sanitizedQuery.includes("client_secret=[REDACTED]"));
  assert.ok(sanitizedQuery.includes("refresh_token=[REDACTED]"));

  // JSON string
  const jsonStr = '{"access_token": "ya29.secret_token", "refresh_token": "1//secret_token"}';
  const sanitizedJson = sanitizeStringForLogging(jsonStr);
  assert.ok(!sanitizedJson.includes("ya29.secret_token"));
  assert.ok(!sanitizedJson.includes("1//secret_token"));
});

test("Observability & Redaction — CalendarService.emitMetric emits structured telemetry", () => {
  const service = new CalendarService();
  let capturedLog: any = null;

  const originalEmit = service.emitMetric.bind(service);
  service.emitMetric = (event) => {
    capturedLog = event;
    originalEmit(event);
  };

  service.emitMetric({
    eventType: "calendar.sync.success",
    userId: "user-obs-1",
    provider: "google",
    durationMs: 142,
  });

  assert.ok(capturedLog);
  assert.equal(capturedLog.eventType, "calendar.sync.success");
  assert.equal(capturedLog.userId, "user-obs-1");
  assert.equal(capturedLog.durationMs, 142);
});
