import { afterAll, expect, setSystemTime, test } from "bun:test";
import { SQL } from "bun";
import { Scheduler } from "./scheduler";
import { loadPostgresConfig } from "../load/config";

const config = loadPostgresConfig();
const sql = new SQL(config.connectionString);
const prefix = `test-${crypto.randomUUID()}`;
const HOUR = 60 * 60 * 1000;

let clock = new Date("2026-10-09T08:00:00Z").getTime();
function advance(ms: number) {
  clock += ms;
  setSystemTime(new Date(clock));
}

// Jobs run fire-and-forget behind a DNS probe, so wait for the expected
// count instead of a fixed delay (which flakes on a busy machine).
async function until(check: () => boolean, timeoutMs = 3000) {
  const deadline = performance.now() + timeoutMs;
  while (!check() && performance.now() < deadline) await Bun.sleep(10);
}

async function tick(scheduler: Scheduler, expectRuns?: () => boolean) {
  await (scheduler as any).tick();
  if (expectRuns) await until(expectRuns);
  else await Bun.sleep(50);
}

afterAll(async () => {
  setSystemTime();
  await sql`DELETE FROM ops.sync_runs WHERE job LIKE ${prefix + "%"}`;
  await sql.close();
});

test("runs on startup, waits for the interval, and catches up after a wake gap", async () => {
  setSystemTime(new Date(clock));
  let runs = 0;
  const scheduler = new Scheduler(config, [
    { name: `${prefix}-interval`, intervalMs: HOUR, run: async () => ++runs }
  ]);
  await scheduler.start();
  scheduler.stop();
  await until(() => runs === 1);
  expect(runs).toBe(1);

  for (let i = 0; i < 4; i++) {
    advance(30 * 1000);
    await tick(scheduler);
  }
  expect(runs).toBe(1);

  advance(5 * HOUR); // lid closed: no ticks for 5 hours
  await tick(scheduler, () => runs === 2);
  expect(runs).toBe(2);
});

test("wake-only jobs run after wake, honoring their delay, then not on the interval", async () => {
  let runs = 0;
  const scheduler = new Scheduler(config, [
    { name: `${prefix}-wake`, intervalMs: Infinity, onWakeOnly: true, wakeDelayMs: 60 * 1000, run: async () => ++runs }
  ]);
  await scheduler.start();
  scheduler.stop();
  await Bun.sleep(50);
  expect(runs).toBe(0); // still inside the wake delay

  advance(30 * 1000);
  await tick(scheduler);
  expect(runs).toBe(0);
  advance(31 * 1000);
  await tick(scheduler, () => runs === 1);
  expect(runs).toBe(1);

  for (let i = 0; i < 10; i++) {
    advance(30 * 1000);
    await tick(scheduler);
  }
  expect(runs).toBe(1);
});

test("failed runs retry with backoff and are recorded", async () => {
  let attempts = 0;
  const name = `${prefix}-flaky`;
  const scheduler = new Scheduler(config, [
    {
      name,
      intervalMs: HOUR,
      run: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("offline");
        return { ok: true };
      }
    }
  ]);
  await scheduler.start();
  scheduler.stop();
  await until(() => attempts === 1);
  await Bun.sleep(50); // let the failure be recorded
  expect(attempts).toBe(1);

  advance(30 * 1000);
  await tick(scheduler);
  expect(attempts).toBe(1); // 1 min backoff not elapsed
  advance(31 * 1000);
  await tick(scheduler, () => attempts === 2);
  await Bun.sleep(50);
  expect(attempts).toBe(2);
  advance(60 * 1000);
  await tick(scheduler);
  expect(attempts).toBe(2); // backoff doubled to 2 min
  advance(61 * 1000);
  await tick(scheduler, () => attempts === 3);
  await Bun.sleep(100); // let the success be recorded
  expect(attempts).toBe(3);

  const rows = await sql`SELECT status FROM ops.sync_runs WHERE job = ${name} ORDER BY id`;
  expect(rows.map((r: any) => r.status)).toEqual(["failed", "failed", "success"]);
});
