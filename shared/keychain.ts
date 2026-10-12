import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./data-dir";

// Per-install secrets (the database password, the key that encrypts stored
// OAuth tokens). Kept in the macOS Keychain, Apple's encrypted password
// store, so they're never in a file next to the data they protect. Other
// platforms fall back to a 0600 file in the data dir.

const SERVICE = "AyuOS";

function keychain(args: string[]): { ok: boolean; out: string } {
  const result = Bun.spawnSync(["security", ...args], { stdout: "pipe", stderr: "pipe" });
  return { ok: result.exitCode === 0, out: result.stdout.toString().trim() };
}

const cache = new Map<string, string>();

export function getOrCreateSecret(name: string): string {
  const cached = cache.get(name);
  if (cached) return cached;

  let value: string | null = null;
  if (process.platform === "darwin") {
    const found = keychain(["find-generic-password", "-s", SERVICE, "-a", name, "-w"]);
    if (found.ok && found.out) {
      value = found.out;
    } else {
      value = randomBytes(32).toString("hex");
      const added = keychain(["add-generic-password", "-s", SERVICE, "-a", name, "-w", value, "-U"]);
      if (!added.ok) throw new Error(`Could not save the ${name} secret in the macOS Keychain`);
    }
  } else {
    const dir = join(dataDir(), "secrets");
    const file = join(dir, name);
    if (existsSync(file)) {
      value = readFileSync(file, "utf8").trim();
    } else {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      value = randomBytes(32).toString("hex");
      writeFileSync(file, value, { mode: 0o600 });
    }
  }

  cache.set(name, value);
  return value;
}
