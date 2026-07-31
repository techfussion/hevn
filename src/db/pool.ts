import { Pool, PoolClient } from "pg";

let pool: Pool | null = null;

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
 * Runs `fn` with a client whose session has app.current_user_id set,
 * so the RLS policies in schema.sql actually scope queries to that user.
 * ALWAYS use this (not a raw pool.query) for any user-data access.
 *
 * userId must already be a validated UUID belonging to an authenticated
 * request — never pass raw, unvalidated input here.
 */
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
    const errorHandler = (err: Error) =>
      console.error("DB client error (handled):", err.message);
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
        continue; // retry with a fresh connection
      }
      throw err;
    } finally {
      client.removeListener("error", errorHandler);
      client.release();
    }
  }
  throw new Error("unreachable"); // TypeScript needs this; loop always returns or throws above
}