import { afterAll, afterEach, expect, test } from "bun:test";
import { SQL } from "bun";
import { loadPostgresConfig } from "../../load/config";
import { WearableConnectionStore } from "../../load/wearable-connections";
import { readingsFromOura } from "./oura";
import { readingsFromWhoop } from "./whoop";
import { readingCollector } from "./readings";
import { syncProvider, syncWindowStart } from "./sync";
import { WearableRecordStore } from "../../load/wearable-records";

const DAY = 24 * 60 * 60 * 1000;
const realFetch = globalThis.fetch;
const sql = new SQL(loadPostgresConfig().connectionString);

afterEach(async () => {
  globalThis.fetch = realFetch;
  await sql`DELETE FROM ops.wearable_connections`;
  await sql`DELETE FROM ops.wearable_sync_state`;
  await sql`DELETE FROM wearables.records`;
  await sql`DELETE FROM timeseries.readings WHERE user_id LIKE 'test-%'`;
});
afterAll(() => sql.close());

function collect(fn: (push: ReturnType<typeof readingCollector>["push"]) => void) {
  const { readings, push } = readingCollector("test-user", "oura");
  fn(push);
  return readings.map((r) => [r.metricType, r.ts, r.value, r.unit]);
}

test("first sync pulls full history; later syncs overlap 3 days", () => {
  const now = new Date("2026-10-12T00:00:00Z");
  expect(now.getTime() - syncWindowStart(null, now).getTime()).toBe(3650 * DAY);
  expect(syncWindowStart(new Date("2026-10-11T00:00:00Z"), now).toISOString()).toBe("2026-10-08T00:00:00.000Z");
});

test("Oura payloads map to the same metrics, units and timestamps as before", () => {
  expect(
    collect((push) =>
      readingsFromOura("daily_activity", [{ day: "2026-10-01", steps: 5369, active_calories: 310, equivalent_walking_distance: 4200 }], push)
    )
  ).toEqual([
    ["steps", "2026-10-01T00:00:00.000Z", 5369, "count"],
    ["energy", "2026-10-01T00:00:00.000Z", 310, "kcal"],
    ["distance_walking_running", "2026-10-01T00:00:00.000Z", 4200, "meters"]
  ]);
  expect(
    collect((push) => readingsFromOura("daily_spo2", [{ day: "2026-10-01", spo2_percentage: { average: 95.9 }, breathing_disturbance_index: 3 }], push))
  ).toEqual([
    ["oxygen_saturation", "2026-10-01T00:00:00.000Z", 95.9, "percent"],
    ["breathing_disturbance_index", "2026-10-01T00:00:00.000Z", 3, "score"]
  ]);
  expect(
    collect((push) =>
      readingsFromOura("sleep", [{ hrv: { interval: 300, items: [40, null, 42], timestamp: "2026-10-01T23:00:00+00:00" } }], push)
    )
  ).toEqual([
    ["heart_rate_variability_sdnn", "2026-10-01T23:00:00.000Z", 40, "ms"],
    ["heart_rate_variability_sdnn", "2026-10-01T23:10:00.000Z", 42, "ms"]
  ]);
  expect(collect((push) => readingsFromOura("heartrate", [{ timestamp: "2026-10-01T10:00:00Z", bpm: 61 }], push))).toEqual([
    ["heart_rate", "2026-10-01T10:00:00.000Z", 61, "bpm"]
  ]);
});

test("Whoop: scored recoveries and cycles map; unscored ones wait", () => {
  expect(
    collect((push) =>
      readingsFromWhoop(
        "recovery",
        [
          { score_state: "SCORED", created_at: "2026-10-01T07:00:00Z", score: { resting_heart_rate: 52, hrv_rmssd_milli: 61.2, spo2_percentage: 96, skin_temp_celsius: 33.4 } },
          { score_state: "PENDING_SCORE", created_at: "2026-10-02T07:00:00Z", score: null }
        ],
        push
      )
    )
  ).toEqual([
    ["resting_heart_rate", "2026-10-01T07:00:00.000Z", 52, "bpm"],
    ["heart_rate_variability_rmssd", "2026-10-01T07:00:00.000Z", 61.2, "ms"],
    ["oxygen_saturation", "2026-10-01T07:00:00.000Z", 96, "percent"],
    ["skin_temperature", "2026-10-01T07:00:00.000Z", 33.4, "celsius"]
  ]);
});

// Fake Oura API + token endpoint: counts refreshes, serves one heart-rate
// reading, optionally fails one data type.
function fakeOura(opts: { failSleep?: boolean } = {}) {
  const calls = { refresh: 0 };
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname === "/oauth/token") {
      calls.refresh++;
      await Bun.sleep(50);
      return Response.json({ access_token: `access-${calls.refresh}`, refresh_token: `refresh-${calls.refresh}`, expires_in: 3600 });
    }
    if (url.pathname.endsWith("/heartrate")) return Response.json({ data: [{ timestamp: "2026-10-11T10:00:00Z", bpm: 61 }] });
    if (url.pathname.endsWith("/sleep") && opts.failSleep) return new Response("upstream down", { status: 503 });
    if (url.pathname.endsWith("/vO2_max")) return new Response("not a member", { status: 403 });
    if (url.pathname.endsWith("/personal_info")) return Response.json({ weight: 81.8 });
    return Response.json({ data: [] });
  }) as typeof fetch;
  return calls;
}

test("tokens are stored encrypted and concurrent refreshes happen once", async () => {
  process.env.OURA_CLIENT_ID = "test-client";
  process.env.OURA_CLIENT_SECRET = "test-secret";
  const calls = fakeOura();
  const store = new WearableConnectionStore(loadPostgresConfig());
  try {
    await store.save("oura", { accessToken: "plain-access", refreshToken: "plain-refresh", expiresAt: new Date(Date.now() - 1000), scope: null });
    const [row] = await sql`SELECT access_token_enc FROM ops.wearable_connections WHERE provider = 'oura'`;
    expect(row.access_token_enc).not.toContain("plain-access");

    const other = new WearableConnectionStore(loadPostgresConfig());
    const tokens = await Promise.all([store.accessToken("oura"), other.accessToken("oura")]);
    await other.close();
    expect(calls.refresh).toBe(1);
    expect(tokens).toEqual(["access-1", "access-1"]);
  } finally {
    await store.close();
  }
});

test("a sync saves readings and advances; a transient failure holds the resume point", async () => {
  process.env.OURA_CLIENT_ID = "test-client";
  process.env.OURA_CLIENT_SECRET = "test-secret";
  const store = new WearableConnectionStore(loadPostgresConfig());
  try {
    await store.save("oura", { accessToken: "a", refreshToken: "r", expiresAt: new Date(Date.now() + 3600_000), scope: null });

    fakeOura({ failSleep: true });
    await expect(syncProvider(store, "oura", "test-user", new Date("2026-10-12T00:00:00Z"))).rejects.toThrow("sleep");
    expect(await store.lastSyncedAt("oura")).toBeNull();

    fakeOura();
    const result = await syncProvider(store, "oura", "test-user", new Date("2026-10-12T00:00:00Z"));
    expect(result.skipped).toEqual(["vO2_max"]);
    expect((await store.lastSyncedAt("oura"))?.toISOString()).toBe("2026-10-12T00:00:00.000Z");
    const rows = await sql`SELECT metric_type, value FROM timeseries.readings WHERE user_id = 'test-user' ORDER BY metric_type`;
    expect(rows.map((r: any) => [r.metric_type, r.value])).toEqual([["heart_rate", 61], ["weight", 81.8]]);
  } finally {
    await store.close();
  }
});

test("a refused refresh marks the login as needing reconnect (and it sticks)", async () => {
  process.env.WHOOP_CLIENT_ID = "test-client";
  process.env.WHOOP_CLIENT_SECRET = "test-secret";
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: "invalid_request" }), { status: 400 })) as unknown as typeof fetch;
  const store = new WearableConnectionStore(loadPostgresConfig());
  try {
    await store.save("whoop", { accessToken: "a", refreshToken: "dead", expiresAt: new Date(Date.now() - 1000), scope: null });
    await expect(store.accessToken("whoop")).rejects.toThrow();
    const [row] = await sql`SELECT status, last_error FROM ops.wearable_connections WHERE provider = 'whoop'`;
    expect(row.status).toBe("needs_reconnect");
    expect(row.last_error).toContain("invalid_request");
  } finally {
    await store.close();
  }
});

function collectWithContext(provider: string, fn: (push: ReturnType<typeof readingCollector>["push"]) => void) {
  const { readings, push } = readingCollector("test-user", provider);
  fn(push);
  return Object.fromEntries(readings.map((r) => [`${r.metricType}@${r.ts}`, [r.value, r.unit, r.context]]));
}

test("Oura: scores, contributors, sleep sessions, hypnogram and heart-rate source are kept", () => {
  const daily = collectWithContext("oura", (push) =>
    readingsFromOura("daily_sleep", [{ day: "2026-10-01", score: 82, contributors: { deep_sleep: 90, timing: 70 } }], push)
  );
  expect(daily["sleep_score@2026-10-01T00:00:00.000Z"]).toEqual([82, "score", null]);
  expect(daily["sleep_contributor_deep_sleep@2026-10-01T00:00:00.000Z"]).toEqual([90, "score", null]);
  expect(daily["sleep_contributor_timing@2026-10-01T00:00:00.000Z"]).toEqual([70, "score", null]);

  const session = collectWithContext("oura", (push) =>
    readingsFromOura(
      "sleep",
      [{ type: "long_sleep", bedtime_start: "2026-10-01T22:00:00+00:00", total_sleep_duration: 27000, efficiency: 91, sleep_phase_5_min: "42" }],
      push
    )
  );
  expect(session["sleep_total_duration@2026-10-01T22:00:00.000Z"]).toEqual([27000, "s", "long_sleep"]);
  expect(session["sleep_efficiency@2026-10-01T22:00:00.000Z"]).toEqual([91, "percent", "long_sleep"]);
  expect(session["sleep_stage@2026-10-01T22:00:00.000Z"]).toEqual([4, "stage", "long_sleep"]);
  expect(session["sleep_stage@2026-10-01T22:05:00.000Z"]).toEqual([2, "stage", "long_sleep"]);

  const hr = collectWithContext("oura", (push) => readingsFromOura("heartrate", [{ timestamp: "2026-10-01T10:00:00Z", bpm: 120, source: "workout" }], push));
  expect(hr["heart_rate@2026-10-01T10:00:00.000Z"]).toEqual([120, "bpm", "workout"]);

  const workout = collectWithContext("oura", (push) =>
    readingsFromOura("workout", [{ activity: "cycling", start_datetime: "2026-10-01T07:00:00Z", end_datetime: "2026-10-01T08:00:00Z", calories: 450, intensity: "hard" }], push)
  );
  expect(workout["workout_duration@2026-10-01T07:00:00.000Z"]).toEqual([3600, "s", "cycling"]);
  expect(workout["workout_calories@2026-10-01T07:00:00.000Z"]).toEqual([450, "kcal", "cycling"]);
  expect(workout["workout_intensity@2026-10-01T07:00:00.000Z"]).toEqual([3, "level", "cycling"]);
});

test("Whoop: recovery score, strain, sleep stages and workouts map; durations in seconds, energy in kcal", () => {
  const out = collectWithContext("whoop", (push) => {
    readingsFromWhoop("recovery", [{ score_state: "SCORED", created_at: "2026-10-01T07:00:00Z", score: { recovery_score: 66, user_calibrating: false } }], push);
    readingsFromWhoop("cycle", [{ score_state: "SCORED", start: "2026-10-01T04:00:00Z", score: { strain: 12.5, kilojoule: 8368 } }], push);
    readingsFromWhoop(
      "sleep",
      [{
        score_state: "SCORED", start: "2026-09-30T23:00:00Z", nap: false,
        score: { sleep_performance_percentage: 88, stage_summary: { total_light_sleep_time_milli: 10_800_000, total_slow_wave_sleep_time_milli: 5_400_000, total_rem_sleep_time_milli: 7_200_000 } }
      }],
      push
    );
    readingsFromWhoop(
      "workout",
      [{ score_state: "SCORED", start: "2026-10-01T17:00:00Z", end: "2026-10-01T17:30:00Z", sport_name: "running", score: { strain: 9.1, zone_durations: { zone_two_milli: 600_000 } } }],
      push
    );
  });
  expect(out["recovery_score@2026-10-01T07:00:00.000Z"]).toEqual([66, "percent", null]);
  expect(out["strain@2026-10-01T04:00:00.000Z"]).toEqual([12.5, "strain", null]);
  expect(out["total_energy@2026-10-01T04:00:00.000Z"]).toEqual([2000, "kcal", null]);
  expect(out["sleep_total_duration@2026-09-30T23:00:00.000Z"]).toEqual([23400, "s", "sleep"]);
  expect(out["sleep_deep_duration@2026-09-30T23:00:00.000Z"]).toEqual([5400, "s", "sleep"]);
  expect(out["sleep_performance@2026-09-30T23:00:00.000Z"]).toEqual([88, "percent", "sleep"]);
  expect(out["workout_duration@2026-10-01T17:00:00.000Z"]).toEqual([1800, "s", "running"]);
  expect(out["workout_zone_2_duration@2026-10-01T17:00:00.000Z"]).toEqual([600, "s", "running"]);
});

test("documents are kept whole with version history; unchanged ones are skipped", async () => {
  const records = new WearableRecordStore(loadPostgresConfig());
  try {
    const doc = { recordId: "s1", json: { id: "s1", score: 80 }, day: "2026-10-01", startTime: null, endTime: null };
    expect(await records.upsert("oura", "daily_sleep", [doc])).toBe(1);
    expect(await records.upsert("oura", "daily_sleep", [doc])).toBe(0);
    expect(await records.upsert("oura", "daily_sleep", [{ ...doc, json: { id: "s1", score: 81 } }])).toBe(1);
    const rows = await sql`SELECT version, is_current, json FROM wearables.records WHERE record_id = 's1' ORDER BY version`;
    expect(rows.map((r: any) => [r.version, r.is_current, r.json.score])).toEqual([[1, false, 80], [2, true, 81]]);
  } finally {
    await records.close();
  }
});

test("each data type resumes on its own: new types download full history, heartrate continues", async () => {
  process.env.OURA_CLIENT_ID = "test-client";
  process.env.OURA_CLIENT_SECRET = "test-secret";
  const store = new WearableConnectionStore(loadPostgresConfig());
  try {
    await store.save("oura", { accessToken: "a", refreshToken: "r", expiresAt: new Date(Date.now() + 3600_000), scope: null });
    await store.markSynced("oura", new Date("2026-10-11T00:00:00Z")); // synced before per-type resume points existed
    const firstRequest = new Map<string, URLSearchParams>();
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const kind = url.pathname.split("/").pop()!;
      if (!firstRequest.has(kind)) firstRequest.set(kind, url.searchParams);
      if (kind === "daily_sleep") return Response.json({ data: [{ id: "d1", day: "2026-10-10", score: 77 }] });
      if (kind === "personal_info") return Response.json({ id: "me" });
      return Response.json({ data: [] });
    }) as typeof fetch;

    const result = await syncProvider(store, "oura", "test-user", new Date("2026-10-12T00:00:00Z"));
    expect(firstRequest.get("heartrate")?.get("start_datetime")).toBe("2026-10-08T00:00:00Z");
    expect(firstRequest.get("daily_sleep")?.get("start_date")).toBe("2016-10-14");
    expect(result.documents).toEqual({ daily_sleep: 1, personal_info: 1 });
    expect((await store.typeSyncedAt("oura", "daily_sleep"))?.toISOString()).toBe("2026-10-12T00:00:00.000Z");
    const [score] = await sql`SELECT value FROM timeseries.readings WHERE user_id = 'test-user' AND metric_type = 'sleep_score'`;
    expect(score.value).toBe(77);
  } finally {
    await store.close();
  }
});

test("a data type the user didn't share (401 even with a fresh token) is skipped, not retried forever", async () => {
  process.env.OURA_CLIENT_ID = "test-client";
  process.env.OURA_CLIENT_SECRET = "test-secret";
  const store = new WearableConnectionStore(loadPostgresConfig());
  try {
    await store.save("oura", { accessToken: "a", refreshToken: "r", expiresAt: new Date(Date.now() + 3600_000), scope: null });
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === "/oauth/token") return Response.json({ access_token: "fresh", refresh_token: "r2", expires_in: 3600 });
      if (url.pathname.endsWith("/tag")) return new Response("unauthorized", { status: 401 });
      return Response.json({ data: [] });
    }) as typeof fetch;
    const result = await syncProvider(store, "oura", "test-user", new Date("2026-10-12T00:00:00Z"));
    expect(result.skipped).toContain("tag");
    expect(await store.lastSyncedAt("oura")).not.toBeNull();
  } finally {
    await store.close();
  }
});
