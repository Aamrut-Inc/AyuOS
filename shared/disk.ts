import { statfsSync } from "node:fs";
import { homedir } from "node:os";

// Below these, the database (and with it all syncing) starts failing in confusing
// ways, so the home page warns well before that point.
export const DISK_WARN_BYTES = 5 * 2 ** 30;
export const DISK_CRITICAL_BYTES = 2 * 2 ** 30;

export function freeDiskBytes(path = homedir()): number | null {
  try {
    const stats = statfsSync(path);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}
