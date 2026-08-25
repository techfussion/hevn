import crypto from "crypto";

/**
 * Cryptographic helpers for securing tokens at rest and generating tamper-proof OAuth state tokens.
 */

function getEncryptionKey(customKey?: string): Buffer {
  const secret =
    customKey ||
    process.env.ENCRYPTION_KEY ||
    process.env.TELEGRAM_WEBHOOK_SECRET ||
    "hevn_fallback_calendar_encryption_secret_key_32bytes!!";
  return crypto.createHash("sha256").update(secret).digest();
}

/**
 * Encrypt a plaintext string using AES-256-GCM with a random IV.
 * Output format: `ivHex:authTagHex:encryptedHex`
 */
export function encryptSecret(plaintext: string, customKey?: string): string {
  const key = getEncryptionKey(customKey);
  const iv = crypto.randomBytes(12); // 96-bit IV recommended for GCM
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");

  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted}`;
}

/**
 * Decrypt an AES-256-GCM encrypted string (`ivHex:authTagHex:encryptedHex`).
 */
export function decryptSecret(ciphertext: string, customKey?: string): string {
  const parts = ciphertext.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted payload format");
  }

  const [ivHex, authTagHex, encryptedHex] = parts;
  const key = getEncryptionKey(customKey);
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encryptedHex, "hex", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}

/**
 * Generate a cryptographically signed, timestamped OAuth state parameter.
 * Format: `userId.timestamp.hmacSignature`
 */
export function generateOAuthState(userId: string, secret?: string): string {
  const key = secret || process.env.TELEGRAM_WEBHOOK_SECRET || "hevn_oauth_state_secret";
  const timestamp = Date.now().toString();
  const payload = `${userId}.${timestamp}`;
  const hmac = crypto.createHmac("sha256", key).update(payload).digest("hex");
  return `${payload}.${hmac}`;
}

/**
 * Validate an OAuth state parameter.
 * Ensures the signature matches and timestamp is within the allowed window (default: 15 minutes).
 */
export function verifyOAuthState(
  state: string,
  secret?: string,
  maxAgeMs: number = 15 * 60 * 1000
): { valid: boolean; userId?: string } {
  if (!state || typeof state !== "string") {
    return { valid: false };
  }

  const parts = state.split(".");
  if (parts.length !== 3) {
    return { valid: false };
  }

  const [userId, timestampStr, signature] = parts;
  const timestamp = parseInt(timestampStr, 10);
  if (isNaN(timestamp)) {
    return { valid: false };
  }

  // Check expiration
  if (Date.now() - timestamp > maxAgeMs || timestamp > Date.now() + 60000) {
    return { valid: false };
  }

  // Verify signature with constant-time equality
  const key = secret || process.env.TELEGRAM_WEBHOOK_SECRET || "hevn_oauth_state_secret";
  const payload = `${userId}.${timestampStr}`;
  const expectedHmac = crypto.createHmac("sha256", key).update(payload).digest("hex");

  const expectedBuf = Buffer.from(expectedHmac, "hex");
  const actualBuf = Buffer.from(signature, "hex");

  if (expectedBuf.length !== actualBuf.length) {
    return { valid: false };
  }

  if (!crypto.timingSafeEqual(expectedBuf, actualBuf)) {
    return { valid: false };
  }

  return { valid: true, userId };
}
