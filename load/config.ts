import { SQL } from "bun";

export interface PostgresConfig {
  connectionString: string;
}

export function loadPostgresConfig(): PostgresConfig {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error("Missing required environment variable: DATABASE_URL");
  }
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
    throw new Error(
      `Could not connect to Postgres at ${config.connectionString}\n` +
        `Is it running? On this machine: brew services start postgresql@15\n` +
        `Underlying error: ${reason}`
    );
  } finally {
    await sql.close();
  }
}
