import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";
import { loadPostgresConfig } from "./config";

async function main(): Promise<void> {
  const config = loadPostgresConfig();
  const sql = new SQL(config.connectionString);
  const migrationsDir = join(import.meta.dir, "migrations");

  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  try {
    for (const file of files) {
      const text = readFileSync(join(migrationsDir, file), "utf8");
      await sql.unsafe(text);
      console.log(`applied ${file}`);
    }
  } finally {
    await sql.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
