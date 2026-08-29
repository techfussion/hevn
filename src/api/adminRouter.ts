import { Router, type Request, type Response } from "express";
import { AdminService } from "../core/admin/AdminService";
import { requireAdminAuth } from "../middleware/adminAuth";
import { logger } from "../utils/logger";

export function createAdminRouter(adminService: AdminService): Router {
  const router = Router();

  // Protect all /api/admin routes with strict server-side authentication
  router.use(requireAdminAuth);

  /**
   * GET /api/admin/metrics
   * Top-level business KPIs, DAU/WAU/MAU, follow-through rates, and engagement statistics.
   */
  router.get("/metrics", async (_req: Request, res: Response) => {
    try {
      const metrics = await adminService.getDashboardMetrics();
      res.status(200).json(metrics);
    } catch (err) {
      logger.error({ err }, "Failed to fetch admin dashboard metrics");
      res.status(500).json({ error: "Internal Server Error", message: "Could not retrieve metrics" });
    }
  });

  /**
   * GET /api/admin/health
   * Operational system health (Database latency, Job queue backlog, Provider circuit breakers).
   */
  router.get("/health", async (_req: Request, res: Response) => {
    try {
      const health = await adminService.getSystemHealth();
      res.status(200).json(health);
    } catch (err) {
      logger.error({ err }, "Failed to fetch admin system health");
      res.status(500).json({ error: "Internal Server Error", message: "Could not retrieve system health" });
    }
  });

  /**
   * GET /api/admin/users
   * Paginated list of users with redacted metadata and engagement counts.
   */
  router.get("/users", async (req: Request, res: Response) => {
    try {
      const page = Math.max(1, parseInt(String(req.query.page || "1"), 10));
      const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "20"), 10)));
      const search = typeof req.query.search === "string" ? req.query.search : undefined;

      const userDirectory = await adminService.getUsersList(page, limit, search);
      res.status(200).json(userDirectory);
    } catch (err) {
      logger.error({ err }, "Failed to fetch admin users directory");
      res.status(500).json({ error: "Internal Server Error", message: "Could not retrieve users" });
    }
  });

  return router;
}
