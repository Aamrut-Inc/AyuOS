import { assertPostgresReachable, loadPostgresConfig } from "./config";
import { ensureEmbeddedDatabase } from "./db-server";

// Makes AyuOS's database available: starts the embedded one (the default),
// or checks an external one when DATABASE_URL points at it.
export async function ensureDatabase(): Promise<void> {
  if (!process.env.DATABASE_URL?.trim()) await ensureEmbeddedDatabase();
  await assertPostgresReachable(loadPostgresConfig());
}
