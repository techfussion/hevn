import { logger } from "./logger";

export interface FetchWithRetryOptions extends RequestInit {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterMs?: number;
  timeoutMs?: number;
  onRetry?: (attempt: number, error: Error, delayMs: number) => void;
}

export class HttpTimeoutError extends Error {
  constructor(message: string = "HTTP request timed out") {
    super(message);
    this.name = "HttpTimeoutError";
  }
}

export class HttpRetryExhaustedError extends Error {
  readonly lastError: Error;
  readonly attempts: number;

  constructor(message: string, lastError: Error, attempts: number) {
    super(message);
    this.name = "HttpRetryExhaustedError";
    this.lastError = lastError;
    this.attempts = attempts;
  }
}

/**
 * Parse standard Retry-After header (either seconds or HTTP-Date string).
 */
export function parseRetryAfter(headerValue: string | null | undefined, maxDelayMs: number): number | null {
  if (!headerValue) return null;

  // 1. Try integer seconds
  const seconds = parseInt(headerValue, 10);
  if (!isNaN(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, maxDelayMs);
  }

  // 2. Try HTTP-date string
  const dateMs = Date.parse(headerValue);
  if (!isNaN(dateMs)) {
    const diff = dateMs - Date.now();
    return Math.max(0, Math.min(diff, maxDelayMs));
  }

  return null;
}

/**
 * Check if an HTTP status code is transient/retryable.
 */
export function isRetryableHttpStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

/**
 * Robust HTTP client with timeout protection, bounded exponential backoff,
 * full jitter, and HTTP 429 Retry-After header support.
 */
export async function fetchWithRetry(
  url: string,
  options: FetchWithRetryOptions = {}
): Promise<Response> {
  const maxRetries = options.maxRetries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 300;
  const maxDelayMs = options.maxDelayMs ?? 5000;
  const jitterMs = options.jitterMs ?? 200;
  const timeoutMs = options.timeoutMs ?? 10000;

  let lastError: Error = new Error("Unknown HTTP error");

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    let timeoutId: NodeJS.Timeout | null = null;

    // Handle user-supplied AbortSignal chaining if present
    if (options.signal) {
      options.signal.addEventListener("abort", () => controller.abort());
    }

    if (timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        controller.abort();
      }, timeoutMs);
    }

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });

      if (timeoutId) clearTimeout(timeoutId);

      // Check if response is successful or non-retryable
      if (response.ok || !isRetryableHttpStatus(response.status)) {
        return response;
      }

      // Handle retryable HTTP status (429 or 5xx)
      const isLastAttempt = attempt >= maxRetries;
      if (isLastAttempt) {
        return response; // Return response on retry exhaustion so caller can inspect status
      }

      // Calculate delay: prefer Retry-After header on 429, else exponential backoff with jitter
      let delay = 0;
      if (response.status === 429) {
        const retryAfterHeader = response.headers.get("Retry-After");
        const parsed = parseRetryAfter(retryAfterHeader, maxDelayMs);
        delay = parsed ?? Math.min(maxDelayMs, Math.pow(2, attempt) * baseDelayMs + Math.random() * jitterMs);
      } else {
        delay = Math.min(maxDelayMs, Math.pow(2, attempt) * baseDelayMs + Math.random() * jitterMs);
      }

      const retryError = new Error(`HTTP ${response.status} ${response.statusText}`);
      lastError = retryError;

      if (options.onRetry) {
        options.onRetry(attempt + 1, retryError, delay);
      } else {
        logger.warn(
          { attempt: attempt + 1, status: response.status, delayMs: Math.round(delay) },
          "Retrying transient HTTP error"
        );
      }

      await new Promise((resolve) => setTimeout(resolve, delay));
    } catch (err: unknown) {
      if (timeoutId) clearTimeout(timeoutId);

      const isAbort =
        (err instanceof Error && err.name === "AbortError") ||
        (err instanceof Error && err.message.includes("aborted"));

      const currentError = isAbort
        ? new HttpTimeoutError(`HTTP request timed out after ${timeoutMs}ms`)
        : err instanceof Error
        ? err
        : new Error(String(err));

      lastError = currentError;

      const isLastAttempt = attempt >= maxRetries;
      if (isLastAttempt) {
        break;
      }

      const delay = Math.min(
        maxDelayMs,
        Math.pow(2, attempt) * baseDelayMs + Math.random() * jitterMs
      );

      if (options.onRetry) {
        options.onRetry(attempt + 1, currentError, delay);
      } else {
        logger.warn(
          { attempt: attempt + 1, err: currentError.message, delayMs: Math.round(delay) },
          "Retrying network/timeout error"
        );
      }

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw new HttpRetryExhaustedError(
    `HTTP request failed after ${maxRetries + 1} attempt(s): ${lastError.message}`,
    lastError,
    maxRetries + 1
  );
}
