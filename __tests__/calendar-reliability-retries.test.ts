import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchWithRetry,
  parseRetryAfter,
  isRetryableHttpStatus,
  HttpTimeoutError,
  HttpRetryExhaustedError,
} from "../src/utils/http";

test("HTTP Utility — parseRetryAfter handles integer seconds and HTTP-date", () => {
  // Integer seconds
  assert.equal(parseRetryAfter("5", 10000), 5000);
  assert.equal(parseRetryAfter("60", 10000), 10000); // capped by maxDelayMs

  // Invalid or null
  assert.equal(parseRetryAfter(null, 5000), null);
  assert.equal(parseRetryAfter("invalid", 5000), null);

  // Future HTTP-date
  const futureDate = new Date(Date.now() + 3000).toUTCString();
  const delay = parseRetryAfter(futureDate, 10000);
  assert.ok(delay !== null && delay > 1000 && delay <= 3500);
});

test("HTTP Utility — isRetryableHttpStatus identifies transient vs non-transient status codes", () => {
  assert.equal(isRetryableHttpStatus(429), true);
  assert.equal(isRetryableHttpStatus(500), true);
  assert.equal(isRetryableHttpStatus(502), true);
  assert.equal(isRetryableHttpStatus(503), true);
  assert.equal(isRetryableHttpStatus(504), true);

  // Non-retryable
  assert.equal(isRetryableHttpStatus(200), false);
  assert.equal(isRetryableHttpStatus(201), false);
  assert.equal(isRetryableHttpStatus(400), false);
  assert.equal(isRetryableHttpStatus(401), false);
  assert.equal(isRetryableHttpStatus(403), false);
  assert.equal(isRetryableHttpStatus(404), false);
});

test("HTTP Utility — fetchWithRetry retries on 429 with Retry-After header", async () => {
  let callCount = 0;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (_url: any, _init: any) => {
    callCount++;
    if (callCount === 1) {
      return new Response("Too Many Requests", {
        status: 429,
        statusText: "Too Many Requests",
        headers: { "Retry-After": "1" },
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as any;

  try {
    const res = await fetchWithRetry("https://api.example.com/calendar", {
      maxRetries: 2,
      baseDelayMs: 50,
      maxDelayMs: 200,
    });
    assert.equal(res.status, 200);
    assert.equal(callCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("HTTP Utility — fetchWithRetry retries on 503 with exponential backoff and succeeds", async () => {
  let callCount = 0;
  const retryDelays: number[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () => {
    callCount++;
    if (callCount < 3) {
      return new Response("Service Unavailable", { status: 503 });
    }
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  }) as any;

  try {
    const res = await fetchWithRetry("https://api.example.com/sync", {
      maxRetries: 3,
      baseDelayMs: 20,
      maxDelayMs: 100,
      jitterMs: 10,
      onRetry: (_att, _err, delay) => {
        retryDelays.push(delay);
      },
    });

    assert.equal(res.status, 200);
    assert.equal(callCount, 3);
    assert.equal(retryDelays.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("HTTP Utility — fetchWithRetry fast-fails non-retryable 4xx client errors (400, 401, 404)", async () => {
  let callCount = 0;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () => {
    callCount++;
    return new Response("Unauthorized", { status: 401 });
  }) as any;

  try {
    const res = await fetchWithRetry("https://api.example.com/events", { maxRetries: 3 });
    assert.equal(res.status, 401);
    assert.equal(callCount, 1, "Non-retryable 401 should not be retried");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("HTTP Utility — fetchWithRetry aborts and throws HttpTimeoutError on timeout", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = ((_url: any, init: any) => {
    return new Promise((_resolve, reject) => {
      if (init?.signal) {
        init.signal.addEventListener("abort", () => {
          const err = new Error("This operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      }
    });
  }) as any;

  try {
    await assert.rejects(
      async () => {
        await fetchWithRetry("https://api.example.com/slow", {
          timeoutMs: 50,
          maxRetries: 1,
          baseDelayMs: 10,
        });
      },
      (err: any) => err instanceof HttpRetryExhaustedError && err.lastError instanceof HttpTimeoutError
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
