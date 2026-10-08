import { homedir } from "node:os";
import { join } from "node:path";

// Where AyuOS keeps files that aren't in Postgres (uploaded lab PDFs, the
// compiled PDF reader). Outside the repo and outside the installed app copy,
// so reinstalling or re-cloning never deletes them. The login agent sets
// AYUOS_DATA_DIR to the same default.
export function dataDir(): string {
  return process.env.AYUOS_DATA_DIR?.trim() || join(homedir(), "Library", "Application Support", "AyuOS", "data");
}
