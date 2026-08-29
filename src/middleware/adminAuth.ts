import type { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { logger } from "../utils/logger";

/**
 * Enforces strict server-side administrative authorization.
 * Accepts credentials via `X-Admin-Key` header or `Authorization: Bearer <ADMIN_API_KEY>`.
 * Rejects requests with 401 Unauthorized using timing-safe comparison.
 */
export function requireAdminAuth(req: Request, res: Response, next: NextFunction): void {
  const adminSecret = process.env.ADMIN_API_KEY;
  if (!adminSecret || adminSecret.length < 16) {
    logger.error("ADMIN_API_KEY is not configured or too short in environment.");
    res.status(503).json({
      error: "Service Unavailable",
      message: "Administrative API is not enabled on this server.",
    });
    return;
  }

  const authHeader = req.headers.authorization;
  const adminKeyHeader = req.headers["x-admin-key"] as string | undefined;

  let providedKey: string | undefined;

  if (adminKeyHeader) {
    providedKey = adminKeyHeader;
  } else if (authHeader && authHeader.startsWith("Bearer ")) {
    providedKey = authHeader.slice("Bearer ".length).trim();
  }

  if (!providedKey) {
    res.status(401).json({
      error: "Unauthorized",
      message: "Missing administrative authentication credentials.",
    });
    return;
  }

  try {
    const expectedBuf = Buffer.from(adminSecret);
    const providedBuf = Buffer.from(providedKey);

    if (expectedBuf.length !== providedBuf.length || !crypto.timingSafeEqual(expectedBuf, providedBuf)) {
      logger.warn({ ip: req.ip, path: req.path }, "Unauthorized admin API access attempt rejected");
      res.status(401).json({
        error: "Unauthorized",
        message: "Invalid administrative credentials.",
      });
      return;
    }

    next();
  } catch (err) {
    logger.error({ err }, "Error during admin authentication verification");
    res.status(500).json({ error: "Internal Server Error" });
  }
}
