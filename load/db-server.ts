import { existsSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { SQL } from "bun";
import { dataDir } from "../shared/data-dir";
import { getOrCreateSecret } from "../shared/keychain";

// AyuOS's own Postgres, run as a plain local process from the binaries in
// the @embedded-postgres npm packages — no Docker. Listens on 127.0.0.1 only,
// with a random per-install password from the Keychain.

export const DB_PORT = Number(process.env.AYUOS_DB_PORT ?? 5435);
export const DB_USER = "ayuos";
export const DB_NAME = "ayuos";

export function embeddedDatabaseUrl(): string {
  return `postgres://${DB_USER}:${getOrCreateSecret("database-password")}@127.0.0.1:${DB_PORT}/${DB_NAME}`;
}

export function clusterDir(): string {
  return join(dataDir(), "postgres");
}

function binDir(): string {
  const pkg = `@embedded-postgres/${process.platform}-${process.arch}`;
  try {
    const require = createRequire(import.meta.url);
    return join(dirname(require.resolve(`${pkg}/package.json`)), "native", "bin");
  } catch {
    throw new Error(`No bundled Postgres for ${process.platform}-${process.arch} (${pkg}). Run "bun install".`);
  }
}

function run(binary: string, args: string[]): { ok: boolean; output: string } {
  const result = Bun.spawnSync([join(binDir(), binary), ...args], { stdout: "pipe", stderr: "pipe" });
  return { ok: result.exitCode === 0, output: `${result.stdout}${result.stderr}`.trim() };
}

function initCluster(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const pwfile = join(dataDir(), ".initdb-pw");
  writeFileSync(pwfile, getOrCreateSecret("database-password"), { mode: 0o600 });
  try {
    const init = run("initdb", [
      "-D", dir, "-U", DB_USER, `--pwfile=${pwfile}`, "-A", "scram-sha-256", "-E", "UTF8", "--locale=C"
    ]);
    if (!init.ok) throw new Error(`Could not create the database: ${init.output.slice(-800)}`);
  } finally {
    rmSync(pwfile, { force: true });
  }
  appendFileSync(
    join(dir, "postgresql.conf"),
    `\n# AyuOS\nlisten_addresses = '127.0.0.1'\nport = ${DB_PORT}\nunix_socket_directories = '${dir}'\ntimezone = 'UTC'\nlog_timezone = 'UTC'\n`
  );
}

async function reachable(url: string): Promise<boolean> {
  const sql = new SQL(url);
  try {
    await sql`SELECT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.close();
  }
}

// Creates the database on first run and starts it if it isn't running.
// The server keeps running independently of the app (like a service), so app
// restarts don't restart it; after a reboot the app starts it again.
export async function ensureEmbeddedDatabase(): Promise<void> {
  const url = embeddedDatabaseUrl();
  if (!(await reachable(url.replace(new RegExp(`/${DB_NAME}$`), "/postgres")))) {
    const dir = clusterDir();
    if (!existsSync(join(dir, "PG_VERSION"))) initCluster(dir);

    const status = run("pg_ctl", ["-D", dir, "status"]);
    if (!status.ok) {
      const start = run("pg_ctl", ["-D", dir, "-l", join(dir, "server.log"), "-w", "-t", "60", "start"]);
      if (!start.ok) throw new Error(`Could not start the database: ${start.output.slice(-800)}`);
    }
  }

  const admin = new SQL(url.replace(new RegExp(`/${DB_NAME}$`), "/postgres"));
  try {
    const [exists] = await admin`SELECT 1 AS ok FROM pg_database WHERE datname = ${DB_NAME}`;
    if (!exists) await admin.unsafe(`CREATE DATABASE ${DB_NAME}`);
    // Day boundaries and date-only values are computed in UTC, as they were
    // on the Docker database (clusters created before this setting existed).
    await admin.unsafe(`ALTER DATABASE ${DB_NAME} SET timezone TO 'UTC'`);
    await admin.unsafe(`ALTER DATABASE postgres SET timezone TO 'UTC'`);
  } finally {
    await admin.close();
  }
}

export function stopEmbeddedDatabase(): void {
  run("pg_ctl", ["-D", clusterDir(), "-m", "fast", "stop"]);
}
