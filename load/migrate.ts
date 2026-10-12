import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";
import { loadPostgresConfig, type PostgresConfig } from "./config";
import { ensureDatabase } from "./database";

// Applies every migration in order. They're all idempotent (IF NOT EXISTS),
// so this is safe to run on every start.
export async function runMigrations(config: PostgresConfig, log = true): Promise<void> {
  const sql = new SQL(config.connectionString);
  const migrationsDir = join(import.meta.dir, "migrations");
  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  try {
    for (const file of files) {
      await sql.unsafe(readFileSync(join(migrationsDir, file), "utf8"));
      if (log) console.log(`applied ${file}`);
    }
  } finally {
    await sql.close();
  }
}

if (import.meta.main) {
  ensureDatabase()
    .then(() => runMigrations(loadPostgresConfig()))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
