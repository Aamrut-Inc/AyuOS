import { ensureDatabase } from "../load/database";

// Everything AyuOS needs running before it can serve: just its database now
// (embedded Postgres, no Docker).
export async function ensureStack(): Promise<void> {
  await ensureDatabase();
}
