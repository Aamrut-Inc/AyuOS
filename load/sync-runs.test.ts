import { afterAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { SyncRunStore } from "./sync-runs";
import { loadPostgresConfig } from "./config";

const config = loadPostgresConfig();
const sql = new SQL(config.connectionString);
const store = new SyncRunStore(config);

afterAll(async () => {
  await sql`DELETE FROM ops.sync_runs WHERE job IN ('wearables-mirror', 'summary-test')`;
  await sql.close();
  await store.close();
});

test("summaries list current jobs, not retired ones, with JSON details intact", async () => {
  const retired = await store.start("wearables-mirror", "schedule");
  await store.succeed(retired, {});
  const current = await store.start("summary-test", "manual");
  await store.succeed(current, { readings: 3 });

  const jobs = (await store.summaries()).map((s) => s.job);
  expect(jobs).toContain("summary-test");
  expect(jobs).not.toContain("wearables-mirror");
  const [row] = await sql`SELECT jsonb_typeof(detail) AS kind FROM ops.sync_runs WHERE id = ${current}`;
  expect(row.kind).toBe("object");
});
