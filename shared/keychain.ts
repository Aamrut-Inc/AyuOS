import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./data-dir";

// Per-install secrets (the database password, the key that encrypts stored
// OAuth tokens). Kept in the macOS Keychain, Apple's encrypted password
// store, so they're never in a file next to the data they protect. Other
// platforms fall back to a 0600 file in the data dir.

const SERVICE = "AyuOS";

// `security` exit code for "no such item" (errSecItemNotFound).
const NOT_FOUND = 44;

function keychain(args: string[]): { code: number; out: string; err: string } {
  const result = Bun.spawnSync(["security", ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode ?? -1, out: result.stdout.toString().trim(), err: result.stderr.toString().trim() };
}

const cache = new Map<string, string>();

export function getOrCreateSecret(name: string): string {
  const cached = cache.get(name);
  if (cached) return cached;

  let value: string | null = null;
  if (process.platform === "darwin") {
    const found = keychain(["find-generic-password", "-s", SERVICE, "-a", name, "-w"]);
    if (found.code === 0 && found.out) {
      value = found.out;
    } else if (found.code === NOT_FOUND) {
      // Only ever create a secret that doesn't exist: replacing one (e.g.
      // after a transient "keychain locked" error) would lock AyuOS out of
      // its own database or make stored tokens unreadable.
      // (The value is briefly visible to local `ps` while `security` runs.)
      value = randomBytes(32).toString("hex");
      const added = keychain(["add-generic-password", "-s", SERVICE, "-a", name, "-w", value]);
      if (added.code !== 0) throw new Error(`Could not save the ${name} secret in the macOS Keychain: ${added.err}`);
    } else {
      throw new Error(
        `Could not read the ${name} secret from the macOS Keychain (is it locked?). ` +
          `security exited ${found.code}: ${found.err}`
      );
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
