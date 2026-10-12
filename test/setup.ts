// Preloaded before every test file (bunfig.toml): points all tests at a
// separate "ayuos_test" database on the same server, so tests never read or
// write the user's real health data or wearable logins.
import { SQL } from "bun";
import { loadPostgresConfig } from "../load/config";
import { ensureDatabase } from "../load/database";
import { runMigrations } from "../load/migrate";

await ensureDatabase();
const real = new URL(loadPostgresConfig().connectionString);
const testUrl = new URL(real);
testUrl.pathname = "/ayuos_test";

const admin = new SQL(real.toString());
try {
  const [exists] = await admin`SELECT 1 AS ok FROM pg_database WHERE datname = 'ayuos_test'`;
  if (!exists) await admin.unsafe("CREATE DATABASE ayuos_test");
  await admin.unsafe("ALTER DATABASE ayuos_test SET timezone TO 'UTC'");
} finally {
  await admin.close();
}

process.env.DATABASE_URL = testUrl.toString();
await runMigrations({ connectionString: testUrl.toString() }, false);
