import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import {
  DatabaseCapabilityChecker,
  CapabilityCheckResult,
} from "../src/core/db/DatabaseCapabilityChecker";

describe("DatabaseCapabilityChecker & Worker Database Permissions", () => {
  it("passes capability check when all table checks succeed", async () => {
    const mockPool = {
      async query(sql: string) {
        if (sql.includes("current_user")) {
          return { rows: [{ role: "scheduler_service", session_role: "scheduler_service" }] };
        }
        return { rows: [] };
      },
    } as unknown as Pool;

    const checker = new DatabaseCapabilityChecker(mockPool);
    const result: CapabilityCheckResult = await checker.checkCapabilities();

    assert.equal(result.success, true);
    assert.equal(result.role, "scheduler_service");
    assert.equal(result.sessionRole, "scheduler_service");
    assert.equal(result.missingCapabilities.length, 0);
  });

  it("identifies missing permission when job_queue returns permission denied", async () => {
    const mockPool = {
      async query(sql: string) {
        if (sql.includes("current_user")) {
          return { rows: [{ role: "scheduler_service", session_role: "scheduler_service" }] };
        }
        if (sql.includes("job_queue")) {
          const err = new Error("permission denied for table job_queue");
          (err as unknown as Record<string, string>).code = "42501";
          throw err;
        }
        return { rows: [] };
      },
    } as unknown as Pool;

    const checker = new DatabaseCapabilityChecker(mockPool);
    const result = await checker.checkCapabilities();

    assert.equal(result.success, false);
    assert.equal(result.missingCapabilities.includes("SELECT on public.job_queue"), true);
  });

  it("identifies missing permission when follow_ups returns permission denied", async () => {
    const mockPool = {
      async query(sql: string) {
        if (sql.includes("current_user")) {
          return { rows: [{ role: "scheduler_service", session_role: "scheduler_service" }] };
        }
        if (sql.includes("follow_ups")) {
          const err = new Error("permission denied for table follow_ups");
          (err as unknown as Record<string, string>).code = "42501";
          throw err;
        }
        return { rows: [] };
      },
    } as unknown as Pool;

    const checker = new DatabaseCapabilityChecker(mockPool);
    const result = await checker.checkCapabilities();

    assert.equal(result.success, false);
    assert.equal(result.missingCapabilities.includes("SELECT on public.follow_ups"), true);
  });

  it("assertCapabilitiesOrHalt throws descriptive error referencing migration 008 when capabilities are missing", async () => {
    const mockPool = {
      async query(sql: string) {
        if (sql.includes("current_user")) {
          return { rows: [{ role: "scheduler_service", session_role: "scheduler_service" }] };
        }
        if (sql.includes("job_queue")) {
          throw new Error("permission denied for table job_queue");
        }
        return { rows: [] };
      },
    } as unknown as Pool;

    const checker = new DatabaseCapabilityChecker(mockPool);

    await assert.rejects(
      async () => {
        await checker.assertCapabilitiesOrHalt();
      },
      (err: Error) => {
        return err.message.includes("008_p2_worker_database_permissions.sql");
      }
    );
  });

  it("handles database connection failure gracefully during role inspection", async () => {
    const mockPool = {
      async query() {
        throw new Error("Connection terminated unexpectedly");
      },
    } as unknown as Pool;

    const checker = new DatabaseCapabilityChecker(mockPool);
    const result = await checker.checkCapabilities();

    assert.equal(result.success, false);
    assert.equal(result.missingCapabilities.includes("CONNECT"), true);
    assert.equal(result.errorDetails?.includes("Connection terminated unexpectedly"), true);
  });
});
