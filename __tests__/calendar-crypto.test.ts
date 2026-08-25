import test from "node:test";
import assert from "node:assert/strict";
import {
  encryptSecret,
  decryptSecret,
  generateOAuthState,
  verifyOAuthState,
} from "../src/utils/crypto";

test("Calendar Crypto — AES-256-GCM encryption & decryption", async () => {
  const secretText = "ya29.a0AfH6SMD_google_oauth_super_secret_access_token_12345";
  const encrypted = encryptSecret(secretText);

  assert.notEqual(encrypted, secretText, "Ciphertext should not equal plaintext");
  assert.match(encrypted, /^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/, "Format should be iv:tag:ciphertext in hex");

  const decrypted = decryptSecret(encrypted);
  assert.equal(decrypted, secretText, "Decrypted text should match original plaintext exactly");
});

test("Calendar Crypto — Tampered ciphertext throws error", async () => {
  const secretText = "caldav_app_specific_password_secret";
  const encrypted = encryptSecret(secretText);
  const parts = encrypted.split(":");

  // Tamper with the encrypted body
  const tamperedHex = parts[2].substring(0, parts[2].length - 2) + "00";
  const tamperedPayload = `${parts[0]}:${parts[1]}:${tamperedHex}`;

  assert.throws(() => {
    decryptSecret(tamperedPayload);
  }, "Tampered payload should fail authentication tag check and throw");
});

test("Calendar Crypto — OAuth state signing & verification", async () => {
  const userId = "b47c0e81-8d2a-43d9-9524-ec588e1cb67b";
  const state = generateOAuthState(userId);

  assert.match(state, /^[^.]+\.[0-9]+\.[0-9a-f]+$/, "OAuth state should be userId.timestamp.hmac");

  const verification = verifyOAuthState(state);
  assert.equal(verification.valid, true, "Freshly generated state must be valid");
  assert.equal(verification.userId, userId, "Extracted userId must match initiating user");
});

test("Calendar Crypto — Tampered OAuth state fails verification", async () => {
  const userId = "b47c0e81-8d2a-43d9-9524-ec588e1cb67b";
  const state = generateOAuthState(userId);
  const parts = state.split(".");

  // Attempt user impersonation by changing user ID in state
  const attackerUserId = "attacker-user-id-9999";
  const tamperedState = `${attackerUserId}.${parts[1]}.${parts[2]}`;

  const verification = verifyOAuthState(tamperedState);
  assert.equal(verification.valid, false, "Tampered state must fail HMAC verification");
});

test("Calendar Crypto — Expired OAuth state fails verification", async () => {
  const userId = "b47c0e81-8d2a-43d9-9524-ec588e1cb67b";
  // Expired timestamp (20 minutes ago)
  const oldTimestamp = (Date.now() - 20 * 60 * 1000).toString();
  const secret = "test_secret_key";
  const crypto = await import("crypto");
  const payload = `${userId}.${oldTimestamp}`;
  const hmac = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  const expiredState = `${payload}.${hmac}`;

  const verification = verifyOAuthState(expiredState, secret, 15 * 60 * 1000);
  assert.equal(verification.valid, false, "Expired state (>15 min) must be rejected");
});
