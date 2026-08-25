import { Router, type Request, type Response } from "express";
import { CalendarService } from "../core/calendar/CalendarService";
import { encryptSecret, verifyOAuthState } from "../utils/crypto";
import { logger } from "../utils/logger";

export function createCalendarOAuthRouter(calendarService?: CalendarService): Router {
  const router = Router();
  const service = calendarService || new CalendarService();

  /**
   * Google OAuth Callback Endpoint
   * GET /auth/google/callback?code=...&state=...
   */
  router.get("/google/callback", async (req: Request, res: Response) => {
    const { code, state, error } = req.query;

    if (error) {
      logger.warn({ error }, "Google OAuth authorization rejected or returned error");
      return res.status(400).send(`
        <!DOCTYPE html>
        <html>
          <head><title>Hevn — Calendar Connection Failed</title></head>
          <body style="font-family: sans-serif; text-align: center; padding: 40px;">
            <h2 style="color: #e53e3e;">Connection Cancelled</h2>
            <p>Google Calendar authorization was cancelled or failed. You may close this window and try again in Hevn.</p>
          </body>
        </html>
      `);
    }

    if (!code || typeof code !== "string" || !state || typeof state !== "string") {
      return res.status(400).send("Invalid OAuth callback parameters.");
    }

    // 1. Verify tamper-proof OAuth state
    const { valid, userId } = verifyOAuthState(state);
    if (!valid || !userId) {
      logger.warn({ state }, "Tampered or expired OAuth state parameter rejected");
      return res.status(403).send("Invalid or expired OAuth state token.");
    }

    try {
      // 2. Exchange authorization code for tokens
      const clientId = process.env.GOOGLE_CLIENT_ID || "";
      const clientSecret = process.env.GOOGLE_CLIENT_SECRET || "";
      const redirectUri =
        process.env.GOOGLE_REDIRECT_URI || "http://localhost:3000/auth/google/callback";

      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }).toString(),
      });

      if (!tokenRes.ok) {
        const errText = await tokenRes.text();
        logger.error({ status: tokenRes.status, errText }, "Google token exchange failed");
        return res.status(502).send("Failed to exchange code with Google OAuth.");
      }

      const tokenData = (await tokenRes.json()) as {
        access_token: string;
        refresh_token?: string;
        expires_in: number;
      };

      // 3. Fetch account email from Google UserInfo
      let email: string | null = null;
      try {
        const userInfoRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
          headers: { Authorization: `Bearer ${tokenData.access_token}` },
        });
        if (userInfoRes.ok) {
          const userData = (await userInfoRes.json()) as { email?: string };
          email = userData.email || null;
        }
      } catch (err) {
        logger.warn({ err }, "Could not fetch Google user info email; continuing");
      }

      // 4. Encrypt credentials and save account
      const encryptedAccessToken = encryptSecret(tokenData.access_token);
      const encryptedRefreshToken = tokenData.refresh_token
        ? encryptSecret(tokenData.refresh_token)
        : null;
      const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000).toISOString();

      const account = await service.saveAccount(userId, {
        provider: "google",
        accountEmail: email,
        encryptedAccessToken,
        encryptedRefreshToken,
        tokenExpiresAt: expiresAt,
      });

      // 5. Discover calendars
      try {
        await service.discoverAndSyncCalendars(userId, account.id);
      } catch (err) {
        logger.warn({ err, accountId: account.id }, "Initial calendar discovery failed");
      }

      logger.info({ userId, provider: "google" }, "Google Calendar successfully connected");

      return res.send(`
        <!DOCTYPE html>
        <html>
          <head><title>Hevn — Calendar Connected</title></head>
          <body style="font-family: sans-serif; text-align: center; padding: 60px 20px; background: #0f172a; color: #f8fafc;">
            <div style="max-width: 480px; margin: 0 auto; background: #1e293b; padding: 32px; border-radius: 16px; box-shadow: 0 10px 25px rgba(0,0,0,0.5);">
              <h2 style="color: #38bdf8; margin-top: 0;">Google Calendar Connected!</h2>
              <p style="color: #94a3b8; font-size: 16px; line-height: 1.5;">
                Hevn is now connected to your calendar and can check your availability and sync commitments.
              </p>
              <p style="color: #cbd5e1; font-size: 14px; margin-top: 24px;">
                You can now close this tab and return to your chat.
              </p>
            </div>
          </body>
        </html>
      `);
    } catch (err) {
      logger.error({ err, userId }, "Unhandled error in Google OAuth callback");
      return res.status(500).send("Internal server error completing calendar connection.");
    }
  });

  return router;
}
