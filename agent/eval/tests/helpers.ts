import { SQL } from "bun";
import { loadPostgresConfig } from "../../../load/config";
import { runMigrations } from "../../../load/migrate";
import { evalDbName } from "../synth/personas";

// Tests read the synthetic evaluation databases, never the person's data.
// test/setup.ts points DATABASE_URL at ayuos_test; the eval databases live on
// the same server.

export function evalUrl(id: string): string {
  const url = new URL(process.env.DATABASE_URL ?? loadPostgresConfig().connectionString);
  url.pathname = `/${evalDbName(id)}`;
  return url.toString();
}

// Builds the persona's database when it doesn't exist yet (about 15-30 s),
// and re-applies the migrations so view changes are picked up.
export async function ensureEvalDb(id: string): Promise<SQL> {
  const admin = new SQL(process.env.DATABASE_URL ?? loadPostgresConfig().connectionString);
  let exists = false;
  try {
    [exists] = await admin`SELECT 1 FROM pg_database WHERE datname = ${evalDbName(id)}`;
  } finally {
    await admin.close();
  }
  if (!exists) {
    const { buildPersona } = await import("../synth/build");
    await buildPersona(id, () => {});
  } else {
    await runMigrations({ connectionString: evalUrl(id) }, false);
    const sql = new SQL(evalUrl(id));
    const { ensureWearableDailyPopulated } = await import("../../jobs/index");
    await ensureWearableDailyPopulated(sql);
    await sql.close();
  }
  return new SQL(evalUrl(id));
}

export async function withSandbox<T>(sql: SQL, fn: () => Promise<T>): Promise<T> {
  await sql`UPDATE agent.user_settings SET value = 'true'::jsonb WHERE key = 'include_sandbox'`;
  try {
    return await fn();
  } finally {
    await sql`UPDATE agent.user_settings SET value = 'false'::jsonb WHERE key = 'include_sandbox'`;
  }
}
