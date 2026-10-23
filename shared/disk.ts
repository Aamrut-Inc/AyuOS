import { statfsSync } from "node:fs";
import { homedir } from "node:os";

// Below these, the database (and with it all syncing) starts failing in confusing
// ways, so the home page warns well before that point.
export const DISK_WARN_BYTES = 5 * 2 ** 30;
export const DISK_CRITICAL_BYTES = 2 * 2 ** 30;

// Free space from `df`, which the OS answers itself. Bun's statfs can't be
// trusted: Bun 1.3.11 on Intel Macs returns its fields shifted by one
// (bsize 0), which made every free-space reading 0 bytes.
function dfFreeBytes(path: string): number | null {
  const result = Bun.spawnSync(["df", "-k", path], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) return null;
  const line = result.stdout.toString().trim().split("\n").at(-1) ?? "";
  // Filesystem 1K-blocks Used Available ...
  const availableKb = Number(line.split(/\s+/)[3]);
  return Number.isFinite(availableKb) ? availableKb * 1024 : null;
}

export function freeDiskBytes(path = homedir()): number | null {
  const fromDf = dfFreeBytes(path);
  if (fromDf !== null) return fromDf;
  try {
    const stats = statfsSync(path);
    const bytes = Number(stats.bavail) * Number(stats.bsize);
    return bytes > 0 ? bytes : null;
  } catch {
    return null;
  }
}
