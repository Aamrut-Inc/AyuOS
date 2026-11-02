import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { SQL } from "bun";
import { openAgentDb, type AgentDb } from "../../db";
import { SEED_PATH, seedSql } from "../../catalog/generate-seed";
import { ensureEvalDb, evalUrl } from "./helpers";

// Section 4.2 acceptance: as ayuos_agent_ro, raw tables and any write fail;
// the agent views work. The write role reaches only the agent's own tables.

let db: AgentDb;

// Bun's lazy query objects hang `expect(...).rejects`; resolve them explicitly.
const failure = (q: PromiseLike<unknown>) => Promise.resolve(q).then(() => "no error", (e: Error) => e.message);
let main: SQL;

beforeAll(async () => {
  main = await ensureEvalDb("p01");
  db = await openAgentDb({ connectionString: evalUrl("p01") });
}, 300_000);

afterAll(async () => {
  await db?.close();
  await main?.close();
});

test("read role: views yes, raw schemas and writes no", async () => {
  expect((await db.ro`SELECT 1 AS one FROM agent.v_lab_results LIMIT 1`).length).toBe(1);
  expect(await failure(db.ro`SELECT 1 FROM clinical.patient`)).toMatch(/permission denied/);
  expect(await failure(db.ro`SELECT 1 FROM timeseries.readings LIMIT 1`)).toMatch(/permission denied/);
  expect(await failure(db.ro`SELECT 1 FROM ops.wearable_connections`)).toMatch(/permission denied/);
  expect(await failure(db.ro`SELECT 1 FROM agent.turns`)).toMatch(/permission denied/);
  expect(await failure(db.ro`INSERT INTO agent.user_settings (key, value) VALUES ('x', '1')`)).toMatch(/read-only transaction|permission denied/);
  expect(await failure(db.ro`CREATE TABLE agent.x (a int)`)).toMatch(/read-only transaction|permission denied/);
  // Even in an explicitly read-write transaction the role holds no write grant.
  expect(await failure(db.ro.begin("read write", (tx) => tx`INSERT INTO agent.user_settings (key, value) VALUES ('x', '1')`))).toMatch(/permission denied/);
  const [settings] = await db.ro`SELECT current_setting('statement_timeout') AS t, current_setting('search_path') AS p`;
  expect(settings).toEqual({ t: "15s", p: "agent" });
});

test("write role: agent logs only", async () => {
  const [conv] = await db.rw`INSERT INTO agent.conversations (title) VALUES ('role test') RETURNING id`;
  await db.rw`DELETE FROM agent.conversations WHERE id = ${conv.id}`;
  expect(await failure(db.rw`SELECT 1 FROM clinical.observation LIMIT 1`)).toMatch(/permission denied/);
  expect(await failure(db.rw`UPDATE agent.user_settings SET value = 'true' WHERE key = 'include_sandbox'`)).toMatch(/permission denied/);
  expect(await failure(db.rw`INSERT INTO agent.metric_catalog (metric_type, source_provider, display_name, definition, unit_canonical, value_kind, comparable_group, day_anchor, stored_in) VALUES ('x','x','x','x','x','score','x','local_ts','readings')`)).toMatch(/permission denied/);
});

test("the catalog seed migration matches the code catalog", () => {
  expect(readFileSync(SEED_PATH, "utf8")).toBe(seedSql());
});
