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
