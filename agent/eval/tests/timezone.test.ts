import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { loadPostgresConfig } from "../../../load/config";
import { runMigrations } from "../../../load/migrate";
import { OURA_TYPES } from "../../../extract/wearables/oura";
import { readingCollector } from "../../../extract/wearables/readings";
import { buildOffsetIntervals, localMidnightUtc, zoneOffsetMinutes } from "../../context/timezone";
import { resolveTimePhrases } from "../../context/time-phrases";
import { resolveLastNight } from "../../context/last-night";
import { rebuildTzHistory } from "../../jobs/tz-history";
import { refreshWearableDaily } from "../../jobs/index";
import { setSetting } from "../../db";

// Section 5.6: users at UTC-8, UTC+5:30 and UTC+13 (across the date line), a
// month with a daylight-saving change, and a trip that changes the offset
// mid-month. Small fixtures in their own database (ayuos_eval_tz).

const DB = "ayuos_eval_tz";
let sql: SQL;

function url(): string {
  const u = new URL(process.env.DATABASE_URL ?? loadPostgresConfig().connectionString);
  u.pathname = `/${DB}`;
  return u.toString();
}

beforeAll(async () => {
  const admin = new SQL(process.env.DATABASE_URL ?? loadPostgresConfig().connectionString);
  await admin.unsafe(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE ${DB}`);
  await admin.unsafe(`ALTER DATABASE ${DB} SET timezone TO 'UTC'`);
  await admin.close();
  await runMigrations({ connectionString: url() }, false);
  sql = new SQL(url());
}, 60_000);

afterAll(async () => {
  await sql?.close();
});

const off = (m: number) => `${m < 0 ? "-" : "+"}${String(Math.floor(Math.abs(m) / 60)).padStart(2, "0")}:${String(Math.abs(m) % 60).padStart(2, "0")}`;

function localIso(date: string, time: string, offsetMinutes: number): string {
  return `${date}T${time}.000${off(offsetMinutes)}`;
}

// One night per day: bed 23:15 the evening before, wake 07:05 on `day`,
// plus the Oura daily score at 00:00 UTC of `day` and a heart-rate sample at
// 23:30 local on `day`.
async function loadFixture(zone: string, days: Array<{ day: string; offset: number }>, hrTime = "23:30:00") {
  await sql`TRUNCATE wearables.records, agent.tz_history`;
  await sql`DELETE FROM timeseries.readings`;
  await setSetting(sql, "timezone", zone, "user");
  const { readings, push } = readingCollector("me", "oura");
  const sleepDocs: any[] = [];
  const dailyDocs: any[] = [];
  const hr: any[] = [];
  for (const [i, { day, offset }] of days.entries()) {
    const prev = new Date(`${day}T12:00:00Z`);
    prev.setUTCDate(prev.getUTCDate() - 1);
    const prevDay = prev.toISOString().slice(0, 10);
    sleepDocs.push({ id: `s${i}`, day, type: "long_sleep", bedtime_start: localIso(prevDay, "23:15:00", offset), bedtime_end: localIso(day, "07:05:00", offset), total_sleep_duration: 25000, time_in_bed: 28200, sleep_phase_5_min: "4222" });
    dailyDocs.push({ id: `d${i}`, day, score: 70 + i, timestamp: `${day}T00:00:00+00:00` });
    hr.push({ timestamp: new Date(localIso(day, hrTime, offset)).toISOString(), bpm: 60 + i, source: "awake" });
  }
  const spec = (name: string) => OURA_TYPES.find((t) => t.name === name)!;
  for (const [name, items] of [["sleep", sleepDocs], ["daily_sleep", dailyDocs], ["heartrate", hr]] as const) {
    const s = spec(name);
    if (s.record) {
      for (const rec of items.map(s.record)) {
        await sql`INSERT INTO wearables.records (provider, data_type, record_id, json, content_hash, day, start_time, end_time)
                  VALUES ('oura', ${name}, ${rec.recordId}, ${JSON.stringify(rec.json)}::text::jsonb, 'x', ${rec.day}, ${rec.startTime}, ${rec.endTime})`;
      }
    }
    s.readings(items as any[], push, new Date());
  }
  const { TimeseriesStore } = await import("../../../load/timeseries");
  const store = new TimeseriesStore({ connectionString: url() });
  await store.upsertReadings(readings);
  await store.close();
  await rebuildTzHistory(sql, new Date(`${days.at(-1)!.day}T23:59:00Z`));
  await refreshWearableDaily(sql);
}

const span = (from: string, n: number) =>
  Array.from({ length: n }, (_, i) => {
    const d = new Date(`${from}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });

describe("time zone arithmetic", () => {
  test("offsets of the test zones, including daylight saving and the date line", () => {
    expect(zoneOffsetMinutes("Asia/Kolkata", new Date("2026-06-01T00:00:00Z"))).toBe(330);
    expect(zoneOffsetMinutes("Pacific/Tongatapu", new Date("2026-06-01T00:00:00Z"))).toBe(780);
    expect(zoneOffsetMinutes("Etc/GMT+8", new Date("2026-06-01T00:00:00Z"))).toBe(-480);
    expect(zoneOffsetMinutes("America/Los_Angeles", new Date("2026-03-07T12:00:00Z"))).toBe(-480);
    expect(zoneOffsetMinutes("America/Los_Angeles", new Date("2026-03-09T12:00:00Z"))).toBe(-420);
    expect(localMidnightUtc("America/Los_Angeles", "2026-03-08").toISOString()).toBe("2026-03-08T08:00:00.000Z");
    expect(localMidnightUtc("America/Los_Angeles", "2026-03-09").toISOString()).toBe("2026-03-09T07:00:00.000Z");
  });

  test("offset history: flip-flops ignored, trips kept, DST stays one zone interval", () => {
    const at = (iso: string, offsetMinutes: number) => ({ at: new Date(iso), offsetMinutes });
    const intervals = buildOffsetIntervals(
      [
        at("2026-03-01T07:00:00Z", -480), at("2026-03-02T07:00:00Z", -480),
        at("2026-03-02T09:00:00Z", 60), // one stray observation: a flip-flop
        at("2026-03-03T07:00:00Z", -480),
        at("2026-03-10T06:00:00Z", -420), at("2026-03-11T06:00:00Z", -420), // DST: same zone
        at("2026-03-15T22:00:00Z", 540), at("2026-03-16T22:00:00Z", 540), // trip to UTC+9
        at("2026-03-20T06:00:00Z", -420), at("2026-03-21T06:00:00Z", -420)
      ],
      "America/Los_Angeles",
      new Date("2026-03-22T00:00:00Z")
    );
    expect(intervals.map((i) => [i.offsetMinutes, i.ianaTz])).toEqual([
      [-480, "America/Los_Angeles"],
      [540, null],
      [-420, "America/Los_Angeles"]
    ]);
    expect(intervals[0]!.validFrom).toBeNull(); // earliest offset before the first observation
    expect(intervals.at(-1)!.validTo).toBeNull();
  });

  test("after the last observation the current zone applies", () => {
    const intervals = buildOffsetIntervals([{ at: new Date("2026-03-01T00:00:00Z"), offsetMinutes: 540 }, { at: new Date("2026-03-02T00:00:00Z"), offsetMinutes: 540 }], "Asia/Kolkata", new Date("2026-03-05T00:00:00Z"));
    expect(intervals.at(-1)).toMatchObject({ offsetMinutes: 330, ianaTz: "Asia/Kolkata", validTo: null });
  });

  test("relative phrases resolve per zone, across the date line", () => {
    const now = new Date("2026-11-01T09:00:00Z");
    const tonga = resolveTimePhrases("how did I sleep last week and today?", "Pacific/Tongatapu", now);
    const la = resolveTimePhrases("how did I sleep last week and today?", "America/Los_Angeles", now);
    expect(tonga.find((r) => r.phrase === "today")!.from).toBe("2026-11-01"); // 22:00 local on 1 Nov
    expect(la.find((r) => r.phrase === "today")!.from).toBe("2026-11-01"); // 02:00 local on 1 Nov
    const lastWeek = la.find((r) => r.phrase === "last week")!;
    expect([lastWeek.from, lastWeek.to]).toEqual(["2026-10-19", "2026-10-25"]);
    const thirty = resolveTimePhrases("over the last 30 days", "Asia/Kolkata", now)[0]!;
    expect([thirty.from, thirty.to]).toEqual(["2026-10-03", "2026-11-01"]);
    expect(thirty.fromUtc).toBe("2026-10-02T18:30:00.000Z");
    const late = resolveTimePhrases("yesterday", "Pacific/Tongatapu", new Date("2026-11-01T10:30:00Z"))[0]!;
    expect(late.from).toBe("2026-10-31"); // 23:30 on 1 Nov in Tonga
    const early = resolveTimePhrases("yesterday", "Pacific/Tongatapu", new Date("2026-11-01T11:30:00Z"))[0]!;
    expect(early.from).toBe("2026-11-01"); // 00:30 on 2 Nov in Tonga
    const month = resolveTimePhrases("last month", "Etc/GMT+8", now)[0]!;
    expect([month.from, month.to]).toEqual(["2026-10-01", "2026-10-31"]); // 01:00 on 1 Nov locally
  });
});

describe("local days in the database", () => {
  for (const [zone, offset] of [["Etc/GMT+8", -480], ["Asia/Kolkata", 330], ["Pacific/Tongatapu", 780]] as const) {
    test(`${zone}: samples land on their local day, Oura daily values never move, last night`, async () => {
      const days = span("2026-06-10", 5);
      await loadFixture(zone, days.map((day) => ({ day, offset })));
      // A heart-rate sample at 23:30 local belongs to that local day.
      const hr = await sql`SELECT local_day::text AS d, mean FROM agent.v_wearable_daily WHERE metric_type = 'heart_rate' ORDER BY local_day`;
      expect(hr.map((r: any) => r.d)).toEqual(days);
      // Oura's daily score at 00:00 UTC stays on its own day in every zone.
      const scores = await sql`SELECT local_day::text AS d, mean FROM agent.v_wearable_daily WHERE metric_type = 'sleep_score' ORDER BY local_day`;
      expect(scores.map((r: any) => [r.d, r.mean])).toEqual(days.map((d, i) => [d, 70 + i]));
      // Sessions show local wall-clock times.
      const [night] = await sql`SELECT start_local::text AS s, end_local::text AS e FROM agent.v_sleep_nights WHERE day = ${days[2]}`;
      expect(night).toEqual({ s: `${days[1]} 23:15:00`, e: `${days[2]} 07:05:00` });
      // "Last night" is the night that ended this morning; before any sleep
      // ended today, it falls back to yesterday.
      expect(await resolveLastNight(sql, days[4]!)).toEqual({ day: days[4]!, found: true });
      expect(await resolveLastNight(sql, "2026-06-15")).toEqual({ day: "2026-06-14", found: false });
    }, 60_000);
  }

  test("a month with a daylight-saving change keeps local days right", async () => {
    const days = span("2026-03-05", 7); // US change on 8 Mar
    await loadFixture("America/Los_Angeles", days.map((day) => ({ day, offset: zoneOffsetMinutes("America/Los_Angeles", new Date(`${day}T12:00:00Z`)) })));
    const hr = await sql`SELECT local_day::text AS d FROM agent.v_wearable_daily WHERE metric_type = 'heart_rate' ORDER BY local_day`;
    expect(hr.map((r: any) => r.d)).toEqual(days);
    const intervals = await sql`SELECT iana_tz FROM agent.tz_history`;
    expect(intervals.map((i: any) => i.iana_tz)).toEqual(["America/Los_Angeles"]);
  }, 60_000);

  test("a trip that changes the offset mid-month", async () => {
    const days = span("2026-07-01", 20);
    // Samples at 06:00 local: an eastward flight skips most of a day, so a
    // 23:30 Los Angeles sample would postdate the first Tokyo bedtime.
    await loadFixture("America/Los_Angeles", days.map((day, i) => ({ day, offset: i >= 8 && i < 14 ? 540 : -420 })), "06:00:00");
    const intervals = await sql`SELECT utc_offset_minutes AS o FROM agent.tz_history ORDER BY valid_from`;
    expect(intervals.map((i: any) => i.o)).toEqual([-420, 540, -420]);
    const hr = await sql`SELECT local_day::text AS d FROM agent.v_wearable_daily WHERE metric_type = 'heart_rate' ORDER BY local_day`;
    expect(hr.map((r: any) => r.d)).toEqual(days);
    // A Tokyo-time night shows Tokyo wall-clock times.
    const [night] = await sql`SELECT start_local::text AS s FROM agent.v_sleep_nights WHERE day = ${days[10]}`;
    expect(night.s).toBe(`${days[9]} 23:15:00`);
  }, 60_000);
});
