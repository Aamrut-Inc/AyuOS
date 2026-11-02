import { SQL } from "bun";
import { loadPostgresConfig, type PostgresConfig } from "../load/config";
import { getOrCreateSecret } from "../shared/keychain";

// The agent's three database connections:
//   ro   (ayuos_agent_ro): tools and model-written SQL; agent views only.
//   rw   (ayuos_agent_rw): the agent's own logs and memory.
//   main (the app's role): jobs that fill agent tables (time zones, note text,
//        view refresh), settings, and the identifier list for the privacy guard.
// Role passwords live in the Keychain and are (re)applied at startup, so they
// never appear in a migration.

export const RO_ROLE = "ayuos_agent_ro";
export const RW_ROLE = "ayuos_agent_rw";

export interface AgentDb {
  ro: SQL;
  rw: SQL;
  main: SQL;
  config: PostgresConfig;
  close(): Promise<void>;
}

function roleUrl(base: string, role: string, password: string): string {
  const url = new URL(base);
  url.username = role;
  url.password = password;
  return url.toString();
}

// Hex only, so it can be inlined in ALTER ROLE without quoting issues.
function rolePassword(role: string): string {
  return getOrCreateSecret(`${role}-password`);
}

export async function applyRolePasswords(main: SQL): Promise<void> {
  for (const role of [RO_ROLE, RW_ROLE]) {
    const password = rolePassword(role);
    if (!/^[0-9a-f]+$/.test(password)) throw new Error(`Unexpected ${role} password format in the Keychain`);
    await main.unsafe(`ALTER ROLE ${role} WITH LOGIN PASSWORD '${password}'`);
  }
}

export async function openAgentDb(config: PostgresConfig = loadPostgresConfig()): Promise<AgentDb> {
  const main = new SQL({ url: config.connectionString, max: 4 });
  await applyRolePasswords(main);
  const ro = new SQL({ url: roleUrl(config.connectionString, RO_ROLE, rolePassword(RO_ROLE)), max: 6 });
  const rw = new SQL({ url: roleUrl(config.connectionString, RW_ROLE, rolePassword(RW_ROLE)), max: 3 });
  return {
    ro,
    rw,
    main,
    config,
    async close() {
      await Promise.all([ro.close(), rw.close(), main.close()]);
    }
  };
}

export async function getSetting<T>(sql: SQL, key: string, fallback: T): Promise<T> {
  const [row] = await sql`SELECT value FROM agent.user_settings WHERE key = ${key}`;
  return row ? (row.value as T) : fallback;
}

// Values go in as text and are cast, because Bun JSON-encodes a string
// parameter that it sees cast to jsonb (double-encoding it).
export async function setSetting(sql: SQL, key: string, value: unknown, source = "app"): Promise<void> {
  await sql`
    INSERT INTO agent.user_settings (key, value, source, updated_at)
    VALUES (${key}, ${JSON.stringify(value)}::text::jsonb, ${source}, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, source = EXCLUDED.source, updated_at = now()
  `;
}
