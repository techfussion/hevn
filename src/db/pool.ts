import { Pool, PoolClient } from "pg";

let pool: Pool | null = null;
let schedulerPool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is missing from environment.");
    }
    pool = new Pool({
      connectionString,
      ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: true } : undefined,
      max: 10,
    });
    pool.on("error", (err) => {
      console.error("Unexpected PG pool error (connection recovered automatically):", err.message);
    });
  }
  return pool;
}

/**
 * Separate connection pool using a BYPASSRLS role, ONLY for the
 * scheduler's cross-user batch jobs (reading due reminders across all
 * users at once). Never use this for anything that handles a single
 * user's request — that must always go through getPool()/withUserScope
 * so RLS stays a real boundary. See src/scheduler/worker.ts for the only
 * legitimate callers.
 */
export function getSchedulerPool(): Pool {
  if (!schedulerPool) {
    const connectionString = process.env.SCHEDULER_DATABASE_URL;
    if (!connectionString) {
      throw new Error("SCHEDULER_DATABASE_URL is missing from environment.");
    }
    schedulerPool = new Pool({
      connectionString,
      ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: true } : undefined,
      max: 5,
    });
    schedulerPool.on("error", (err) => {
      console.error("Unexpected scheduler PG pool error:", err.message);
    });
  }
  return schedulerPool;
}

export async function withUserScope<T>(
  userId: string,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const isRetryable = (err: unknown) =>
    err instanceof Error &&
    (err.message.includes("ECONNRESET") ||
      err.message.includes("Connection terminated") ||
      err.message.includes("read ECONNRESET"));

  for (let attempt = 0; attempt <= 1; attempt++) {
    const client = await getPool().connect();
    const errorHandler = (err: Error) => console.error("DB client error (handled):", err.message);
    client.on("error", errorHandler);

    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_user_id', $1, true)", [userId]);
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      if (attempt === 0 && isRetryable(err)) {
        console.warn("Transient DB connection error, retrying once...");
        continue;
      }
      throw err;
    } finally {
      client.removeListener("error", errorHandler);
      client.release();
    }
  }
  throw new Error("unreachable");
}