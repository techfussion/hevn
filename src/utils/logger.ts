import pino from "pino";

const SENSITIVE_KEYS = [
  "accessToken",
  "access_token",
  "refreshToken",
  "refresh_token",
  "clientSecret",
  "client_secret",
  "encryptedAccessToken",
  "encrypted_access_token",
  "encryptedRefreshToken",
  "encrypted_refresh_token",
  "password",
  "code",
  "authorization",
  "Authorization",
  "authMetadata",
  "auth_metadata",
  "secret",
  "token",
];

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: [
      ...SENSITIVE_KEYS.map((k) => `*.${k}`),
      ...SENSITIVE_KEYS.map((k) => `*.*.${k}`),
      ...SENSITIVE_KEYS,
    ],
    censor: "[REDACTED]",
  },
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export function createChildLogger(bindings: Record<string, unknown>) {
  return logger.child(bindings);
}

/**
 * Strips secrets, bearer tokens, or query param codes from raw strings before logging.
 */
export function sanitizeStringForLogging(input: string): string {
  if (!input) return input;
  return input
    .replace(/Bearer\s+[A-Za-z0-9_\-.~+/]+=*/gi, "Bearer [REDACTED]")
    .replace(/(client_secret|refresh_token|access_token|code)=[^&\s]+/gi, "$1=[REDACTED]")
    .replace(/"(access_token|refresh_token|client_secret|password)":\s*"[^"]+"/gi, '"$1":"[REDACTED]"');
}
