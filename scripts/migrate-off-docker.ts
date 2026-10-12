// One-time move from the Docker setup to Docker-free AyuOS:
//   1. copies AyuOS's database (Docker container "ayuos-db") into the
//      embedded database,
//   2. moves Oura/Whoop logins from the old wearables backend into AyuOS
//      (encrypted with the Keychain key; they were stored in plain text),
//   3. moves the Oura/Whoop client credentials into AyuOS's .env and removes
//      the settings that pointed at Docker.
// Docker's own data is left untouched as a backup.
//
// Run from the repo root with Docker running:  bun scripts/migrate-off-docker.ts

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";

const ROOT = join(import.meta.dir, "..");
const ENV_FILE = process.env.AYUOS_ENV_FILE ?? join(ROOT, ".env");
const WEARABLES_ENV = join(ROOT, "services/wearables/backend/config/.env");

function dockerExec(container: string, args: string[]): string {
  const result = Bun.spawnSync(["docker", "exec", container, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`docker exec ${container} failed: ${result.stderr.toString().slice(0, 500)}`);
  return result.stdout.toString();
}

function readEnv(file: string): Map<string, string> {
  const values = new Map<string, string>();
  if (!existsSync(file)) return values;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) values.set(match[1], match[2].replace(/\s+#.*$/, "").trim());
  }
  return values;
}

function editEnv(file: string, set: Record<string, string>, remove: string[]): void {
  let lines = readFileSync(file, "utf8").split("\n");
  lines = lines.filter((line) => !remove.some((key) => line.startsWith(`${key}=`)));
  for (const [key, value] of Object.entries(set)) {
    const index = lines.findIndex((line) => line.startsWith(`${key}=`));
    if (index >= 0) lines[index] = `${key}=${value}`;
    else lines.splice(lines[lines.length - 1] === "" ? lines.length - 1 : lines.length, 0, `${key}=${value}`);
  }
  writeFileSync(file, lines.join("\n"));
}

async function main(): Promise<void> {
  const env = readEnv(ENV_FILE);
  if (!env.get("DATABASE_URL")) {
    console.log("Already migrated (no DATABASE_URL in .env). Nothing to do.");
    return;
  }

  // Everything below talks to the embedded database.
  delete process.env.DATABASE_URL;
  const { ensureDatabase } = await import("../load/database");
  const { loadPostgresConfig } = await import("../load/config");
  const { runMigrations } = await import("../load/migrate");
  const { encryptSecret } = await import("../shared/crypto");

  console.log("Starting the embedded database...");
  await ensureDatabase();
  const target = new SQL(loadPostgresConfig().connectionString);

  try {
    await runMigrations(loadPostgresConfig(), false);

    // A previous run may have copied the data and then stopped before
    // finishing; don't copy twice (it would fail on duplicate keys).
    const [{ copied }] = await target`
      SELECT (EXISTS (SELECT 1 FROM clinical.fhir_resources)
           OR EXISTS (SELECT 1 FROM timeseries.readings)
           OR EXISTS (SELECT 1 FROM ops.sync_runs)) AS copied
    `;
    if (copied) {
      console.log("Your data is already in the new database — finishing the remaining steps.");
    } else {
      await copyData(target);
    }

    // From here on .env no longer points at Docker, so a re-run can't redo
    // the copy, whatever happens to the steps below.
    finishEnv(env);
    await moveWearableLogins(target, env, encryptSecret).catch((error) => {
      console.warn(
        `Couldn't move the Oura/Whoop logins (${error instanceof Error ? error.message : error}). ` +
          "Just reconnect them from the AyuOS home page."
      );
    });
  } finally {
    await target.close();
  }
  console.log("\nDone. Docker is no longer needed — its data is untouched if you ever want it.");
}

async function copyData(target: SQL): Promise<void> {
  {

    // Monthly partitions of timeseries.readings must exist before their rows arrive.
    const partitions = dockerExec("ayuos-db", [
      "psql", "-U", "ayuos", "-d", "ayuos", "-Atc",
      "SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname = 'readings'"
    ]).split("\n").filter(Boolean);
    for (const name of partitions) {
      const m = name.match(/^readings_(\d{4})_(\d{2})$/);
      if (!m) continue;
      const start = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1));
      const end = new Date(Date.UTC(Number(m[1]), Number(m[2]), 1));
      await target.unsafe(
        `CREATE TABLE IF NOT EXISTS timeseries.${name} PARTITION OF timeseries.readings FOR VALUES FROM ('${start.toISOString()}') TO ('${end.toISOString()}')`
      );
    }

    console.log("Copying your data out of Docker (a minute or two)...");
    const dump = dockerExec("ayuos-db", [
      "pg_dump", "-U", "ayuos", "-d", "ayuos", "--data-only", "--inserts", "--rows-per-insert=500",
      "--schema=clinical", "--schema=timeseries", "--schema=labs", "--schema=ops"
    ])
      .split("\n")
      .filter((line) => !line.startsWith("\\")) // psql meta-commands (\restrict ...)
      .join("\n");
    await target.unsafe(`SET session_replication_role = replica;\n${dump}\nSET session_replication_role = DEFAULT;`);

    const counts = await target`
      SELECT (SELECT count(*) FROM clinical.fhir_resources)::int AS fhir,
             (SELECT count(*) FROM timeseries.readings)::int AS readings,
             (SELECT count(*) FROM labs.results)::int AS lab_results
    `;
    console.log("Copied:", counts[0]);
  }
}

// Wearable logins from the old backend, for this install's user.
async function moveWearableLogins(
  target: SQL,
  env: Map<string, string>,
  encryptSecret: (plain: string) => string
): Promise<void> {
  {
    const userId = env.get("OPEN_WEARABLES_USER_ID") ?? "";
    if (userId) {
      const rows = dockerExec("wearables-db", [
        "psql", "-U", "open-wearables", "-d", "open-wearables", "-At", "-F", "\t", "-c",
        `SELECT provider, access_token, coalesce(refresh_token, ''), coalesce(token_expires_at::text, ''), coalesce(scope, ''), coalesce(last_synced_at::text, '') FROM user_connection WHERE user_id = '${userId.replace(/[^0-9a-f-]/gi, "")}'`
      ]).split("\n").filter(Boolean);
      for (const row of rows) {
        const [provider, access, refresh, expires, scope, lastSynced] = row.split("\t");
        if (provider !== "oura" && provider !== "whoop") continue;
        const expired = expires && new Date(expires).getTime() < Date.now() - 24 * 60 * 60 * 1000;
        // A token that expired long ago and was never refreshed is a dead login.
        const status = expired && provider === "whoop" ? "needs_reconnect" : "active";
        await target`
          INSERT INTO ops.wearable_connections (
            provider, access_token_enc, refresh_token_enc, token_expires_at, scope, status, last_synced_at
          ) VALUES (
            ${provider}, ${encryptSecret(access)}, ${refresh ? encryptSecret(refresh) : null},
            ${expires || null}, ${scope || null}, ${status}, ${lastSynced || null}
          )
          ON CONFLICT (provider) DO NOTHING
        `;
        console.log(`Moved ${provider} login (${status}).`);
      }
    }
  }
}

function finishEnv(env: Map<string, string>): void {
  // Client credentials move from the backend's .env to AyuOS's.
  const wearablesEnv = readEnv(WEARABLES_ENV);
  const set: Record<string, string> = {};
  for (const key of ["OURA_CLIENT_ID", "OURA_CLIENT_SECRET", "WHOOP_CLIENT_ID", "WHOOP_CLIENT_SECRET"]) {
    const value = wearablesEnv.get(key);
    if (value && !/^(public-client-id|private-secret-id|your-.*)$/.test(value)) set[key] = value;
  }
  if (env.get("OPEN_WEARABLES_USER_ID")) set.AYUOS_USER_ID = env.get("OPEN_WEARABLES_USER_ID")!;
  editEnv(ENV_FILE, set, ["DATABASE_URL", "OPEN_WEARABLES_API_BASE_URL", "OPEN_WEARABLES_API_KEY", "OPEN_WEARABLES_USER_ID"]);
  console.log("Updated .env (credentials moved; Docker settings removed).");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
