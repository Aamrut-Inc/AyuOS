import { chmodSync, mkdirSync } from "node:fs";
import { dataDir } from "./data-dir";

// Uploaded lab PDFs and downloaded record attachments are plain files in the
// data dir: keep the folder private to this user, and recommend FileVault
// (macOS full-disk encryption) so the files are encrypted on disk.

export function ensurePrivateDataDir(): void {
  const dir = dataDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

let fileVault: { on: boolean | null; checkedAt: number } | null = null;

// true/false, or null if it can't be determined (not macOS).
export function fileVaultOn(): boolean | null {
  if (process.platform !== "darwin") return null;
  if (fileVault && Date.now() - fileVault.checkedAt < 60 * 60 * 1000) return fileVault.on;
  const result = Bun.spawnSync(["fdesetup", "status"], { stdout: "pipe", stderr: "pipe" });
  const out = result.stdout.toString();
  const on = /FileVault is On/.test(out) ? true : /FileVault is Off/.test(out) ? false : null;
  fileVault = { on, checkedAt: Date.now() };
  return on;
}
