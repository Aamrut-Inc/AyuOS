import { SQL } from "bun";
import { embeddedDatabaseUrl } from "./db-server";

export interface PostgresConfig {
  connectionString: string;
}

// DATABASE_URL points at an external Postgres (e.g. the old Docker one);
// without it, AyuOS uses its own embedded database (load/db-server.ts).
export function loadPostgresConfig(): PostgresConfig {
  const connectionString = process.env.DATABASE_URL?.trim() || embeddedDatabaseUrl();
  return { connectionString };
}

/**
 * Fails fast with a clear, actionable message instead of letting a bare
 * connection error surface later, mid-request, from whatever query happened
 * to run first (Bun's Postgres client connects lazily on first query).
 */
export async function assertPostgresReachable(config: PostgresConfig): Promise<void> {
  const sql = new SQL(config.connectionString);
  try {
    await sql`SELECT 1`;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const where = config.connectionString.replace(/\/\/([^:]+):[^@]*@/, "//$1:***@");
    throw new Error(`Could not connect to the database at ${where}\nUnderlying error: ${reason}`);
  } finally {
    await sql.close();
  }
}
