import { createHash } from "node:crypto";
import type { WearableConnectionStore } from "../../load/wearable-connections";
import type { WearableRecord } from "../../load/wearable-records";
import { providerGet } from "./api";
import type { DataTypeSpec, PushReading, WearableReading } from "./readings";

// Oura API v2 → AyuOS. Every endpoint of the API (see docs/data-retrieval.md):
// each document is kept whole in wearables.records, and its numeric values
// become readings. Metric names, units and timestamps the previous wearables
// backend used (steps, energy, heart_rate, ...) are unchanged, so history
// stays continuous.

interface Page<T> {
  data?: T[];
  next_token?: string | null;
}

interface IntervalData {
  interval?: number;
  items?: Array<number | null>;
  timestamp?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DATETIME_CHUNK_DAYS = 30; // Oura caps heartrate/battery requests at 30 days

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function dayStart(day: string): string {
  return `${day}T00:00:00.000Z`;
}

function seconds(start: string | undefined, end: string | undefined): number | null {
  if (!start || !end) return null;
  return (new Date(end).getTime() - new Date(start).getTime()) / 1000;
}

// A sampled series ({interval, items, timestamp}) → one reading per sample.
function pushSeries(push: PushReading, series: IntervalData | null | undefined, metric: string, unit: string, context: string | null = null) {
  if (!series?.timestamp || !series.interval || !series.items) return;
  const start = new Date(series.timestamp).getTime();
  series.items.forEach((value, i) => {
    push(metric, new Date(start + series.interval! * 1000 * i).toISOString(), value, unit, context);
  });
}

// A string with one digit per time step (hypnogram, activity class) → readings.
function pushCodes(push: PushReading, codes: string | null | undefined, startIso: string | undefined, stepSeconds: number, metric: string, unit: string, context: string | null = null) {
  if (!codes || !startIso) return;
  const start = new Date(startIso).getTime();
  [...codes].forEach((code, i) => push(metric, new Date(start + stepSeconds * 1000 * i).toISOString(), Number(code), unit, context));
}

// Every numeric field of `object` as `${prefix}_${field}` readings.
function pushAll(push: PushReading, object: Record<string, unknown> | null | undefined, prefix: string, ts: string, unit: string) {
  for (const [field, value] of Object.entries(object ?? {})) push(`${prefix}_${field}`, ts, value, unit);
}

const RESILIENCE_LEVELS = ["limited", "adequate", "solid", "strong", "exceptional"];
const STRESS_SUMMARIES = ["restored", "normal", "stressful"];
const WORKOUT_INTENSITIES = ["easy", "moderate", "hard"];

// Ordinal value (1-based) of an enum string, so it can be charted.
function ordinal(levels: string[], value: unknown): number | null {
  const i = levels.indexOf(String(value));
  return i >= 0 ? i + 1 : null;
}

const READINGS: Record<string, (item: any, push: PushReading) => void> = {
  daily_activity(item, push) {
    const ts = item.timestamp ?? (item.day ? dayStart(item.day) : null);
    if (!ts) return;
    push("steps", ts, item.steps, "count");
    push("energy", ts, item.active_calories, "kcal");
    push("distance_walking_running", ts, item.equivalent_walking_distance, "meters");
    push("activity_score", ts, item.score, "score");
    pushAll(push, item.contributors, "activity_contributor", ts, "score");
    push("total_energy", ts, item.total_calories, "kcal");
    push("target_energy", ts, item.target_calories, "kcal");
    push("target_distance", ts, item.target_meters, "meters");
    push("distance_to_target", ts, item.meters_to_target, "meters");
    push("inactivity_alerts", ts, item.inactivity_alerts, "count");
    push("average_met_minutes", ts, item.average_met_minutes, "met_min");
    for (const field of ["high_activity_met_minutes", "medium_activity_met_minutes", "low_activity_met_minutes", "sedentary_met_minutes"]) {
      push(field, ts, item[field], "met_min");
    }
    for (const field of ["high_activity_time", "medium_activity_time", "low_activity_time", "sedentary_time", "resting_time", "non_wear_time"]) {
      push(field, ts, item[field], "s");
    }
    pushSeries(push, item.met, "met", "met");
    // 0 non-wear, 1 rest, 2 inactive, 3 low, 4 medium, 5 high activity
    pushCodes(push, item.class_5_min, item.timestamp, 300, "activity_class", "class");
  },
  daily_sleep(item, push) {
    if (!item.day) return;
    const ts = dayStart(item.day);
    push("sleep_score", ts, item.score, "score");
    pushAll(push, item.contributors, "sleep_contributor", ts, "score");
  },
  daily_readiness(item, push) {
    const ts = item.timestamp ?? (item.day ? dayStart(item.day) : null);
    if (!ts) return;
    push("skin_temperature_deviation", ts, item.temperature_deviation, "celsius");
    push("skin_temperature_trend_deviation", ts, item.temperature_trend_deviation, "celsius");
    push("readiness_score", ts, item.score, "score");
    pushAll(push, item.contributors, "readiness_contributor", ts, "score");
  },
  daily_spo2(item, push) {
    if (!item.day) return;
    push("oxygen_saturation", dayStart(item.day), item.spo2_percentage?.average, "percent");
    push("breathing_disturbance_index", dayStart(item.day), item.breathing_disturbance_index, "score");
  },
  daily_stress(item, push) {
    if (!item.day) return;
    const ts = dayStart(item.day);
    push("stress_high_time", ts, item.stress_high, "s", item.day_summary ?? null);
    push("recovery_high_time", ts, item.recovery_high, "s", item.day_summary ?? null);
    push("stress_day_summary", ts, ordinal(STRESS_SUMMARIES, item.day_summary), "level", item.day_summary ?? null);
  },
  daily_resilience(item, push) {
    if (!item.day) return;
    const ts = dayStart(item.day);
    push("resilience_level", ts, ordinal(RESILIENCE_LEVELS, item.level), "level", item.level ?? null);
    pushAll(push, item.contributors, "resilience_contributor", ts, "score");
  },
  daily_cardiovascular_age(item, push) {
    if (!item.day) return;
    push("cardiovascular_age", dayStart(item.day), item.vascular_age, "years");
    push("pulse_wave_velocity", dayStart(item.day), item.pulse_wave_velocity, "m/s");
  },
  vO2_max(item, push) {
    if (item.timestamp && item.vo2_max) push("vo2_max", item.timestamp, item.vo2_max, "ml_kg_min");
  },
  heartrate(item, push) {
    if (item.timestamp) push("heart_rate", item.timestamp, item.bpm, "bpm", item.source ?? null);
  },
  sleep(item, push) {
    const type = item.type ?? null;
    pushSeries(push, item.heart_rate, "heart_rate", "bpm", "sleep");
    pushSeries(push, item.hrv, "heart_rate_variability_sdnn", "ms", "sleep");
    const ts = item.bedtime_start;
    if (!ts) return;
    push("sleep_total_duration", ts, item.total_sleep_duration, "s", type);
    push("sleep_deep_duration", ts, item.deep_sleep_duration, "s", type);
    push("sleep_light_duration", ts, item.light_sleep_duration, "s", type);
    push("sleep_rem_duration", ts, item.rem_sleep_duration, "s", type);
    push("sleep_awake_time", ts, item.awake_time, "s", type);
    push("sleep_time_in_bed", ts, item.time_in_bed, "s", type);
    push("sleep_latency", ts, item.latency, "s", type);
    push("sleep_efficiency", ts, item.efficiency, "percent", type);
    push("sleep_respiratory_rate", ts, item.average_breath, "breaths/min", type);
    push("sleep_average_heart_rate", ts, item.average_heart_rate, "bpm", type);
    push("sleep_lowest_heart_rate", ts, item.lowest_heart_rate, "bpm", type);
    push("sleep_average_hrv", ts, item.average_hrv, "ms", type);
    push("sleep_restless_periods", ts, item.restless_periods, "count", type);
    push("sleep_score_delta", ts, item.sleep_score_delta, "score", type);
    push("readiness_score_delta", ts, item.readiness_score_delta, "score", type);
    // 1 deep, 2 light, 3 REM, 4 awake
    pushCodes(push, item.sleep_phase_5_min, ts, 300, "sleep_stage", "stage", type);
    // 1 no motion ... 4 restless
    pushCodes(push, item.movement_30_sec, ts, 30, "sleep_movement", "level", type);
  },
  sleep_time(item, push) {
    if (!item.day) return;
    const ts = dayStart(item.day);
    const context = item.recommendation ?? item.status ?? null;
    push("optimal_bedtime_start_offset", ts, item.optimal_bedtime?.start_offset, "s", context);
    push("optimal_bedtime_end_offset", ts, item.optimal_bedtime?.end_offset, "s", context);
  },
  workout(item, push) {
    const ts = item.start_datetime;
    if (!ts) return;
    const activity = item.activity ?? null;
    push("workout_duration", ts, seconds(item.start_datetime, item.end_datetime), "s", activity);
    push("workout_calories", ts, item.calories, "kcal", activity);
    push("workout_distance", ts, item.distance, "meters", activity);
    push("workout_intensity", ts, ordinal(WORKOUT_INTENSITIES, item.intensity), "level", activity);
  },
  session(item, push) {
    const type = item.type ?? null;
    if (item.start_datetime) push("session_duration", item.start_datetime, seconds(item.start_datetime, item.end_datetime), "s", type);
    pushSeries(push, item.heart_rate, "session_heart_rate", "bpm", type);
    pushSeries(push, item.heart_rate_variability, "session_hrv", "ms", type);
    pushSeries(push, item.motion_count, "session_motion_count", "count", type);
  },
  ring_battery_level(item, push) {
    if (!item.timestamp) return;
    const context = item.charging ? "charging" : item.in_charger ? "in_charger" : null;
    push("ring_battery_level", item.timestamp, item.level, "percent", context);
  }
};

export function readingsFromOura(kind: string, items: any[], push: PushReading): void {
  const map = READINGS[kind];
  if (map) for (const item of items) map(item, push);
}

function ouraRecord(item: any): WearableRecord {
  return {
    recordId: String(item.id ?? createHash("sha256").update(JSON.stringify(item)).digest("hex")),
    json: item,
    day: item.day ?? item.start_day ?? null,
    startTime: item.bedtime_start ?? item.start_datetime ?? item.start_time ?? item.timestamp ?? null,
    endTime: item.bedtime_end ?? item.end_datetime ?? item.end_time ?? null
  };
}

async function paginate(
  store: WearableConnectionStore,
  path: string,
  params: Record<string, string>
): Promise<any[]> {
  const all: any[] = [];
  let nextToken: string | null | undefined;
  do {
    const page = await providerGet<Page<any>>(store, "oura", path, nextToken ? { ...params, next_token: nextToken } : params);
    all.push(...(page.data ?? []));
    nextToken = page.next_token;
  } while (nextToken);
  return all;
}

function utc(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

// Documents dated by day.
function byDate(kind: string): DataTypeSpec {
  return {
    name: kind,
    history: "window",
    fetch: (store, start, end) =>
      paginate(store, `/v2/usercollection/${kind}`, { start_date: isoDate(start), end_date: isoDate(new Date(end.getTime() + DAY_MS)) }),
    record: ouraRecord,
    readings: (items, push) => readingsFromOura(kind, items, push)
  };
}

// Dense time series, requested in 30-day chunks; every field is a reading.
function byDatetime(kind: string): DataTypeSpec {
  return {
    name: kind,
    history: "window",
    async fetch(store, start, end) {
      const items: any[] = [];
      for (let chunk = start.getTime(); chunk < end.getTime(); chunk += DATETIME_CHUNK_DAYS * DAY_MS) {
        const chunkEnd = Math.min(chunk + DATETIME_CHUNK_DAYS * DAY_MS, end.getTime());
        items.push(
          ...(await paginate(store, `/v2/usercollection/${kind}`, {
            start_datetime: utc(new Date(chunk)),
            end_datetime: utc(new Date(chunkEnd))
          }))
        );
      }
      return items;
    },
    readings: (items, push) => readingsFromOura(kind, items, push)
  };
}

export const OURA_TYPES: DataTypeSpec[] = [
  byDate("daily_activity"),
  byDate("daily_sleep"),
  byDate("daily_readiness"),
  byDate("daily_spo2"),
  byDate("daily_stress"),
  byDate("daily_resilience"),
  byDate("daily_cardiovascular_age"),
  byDate("vO2_max"),
  byDate("sleep"),
  byDate("sleep_time"),
  byDate("workout"),
  byDate("session"),
  byDate("enhanced_tag"),
  byDate("tag"),
  byDate("rest_mode_period"),
  byDatetime("heartrate"),
  byDatetime("ring_battery_level"),
  {
    name: "ring_configuration",
    history: "snapshot",
    fetch: (store) => paginate(store, "/v2/usercollection/ring_configuration", {}),
    record: ouraRecord,
    readings: () => {}
  },
  {
    name: "personal_info",
    history: "snapshot",
    fetch: async (store) => [await providerGet(store, "oura", "/v2/usercollection/personal_info")],
    record: ouraRecord,
    readings(items, push, now) {
      const info = items[0] ?? {};
      push("weight", now.toISOString(), info.weight, "kg");
      if (typeof info.height === "number") push("height", now.toISOString(), Math.round(info.height * 10000) / 100, "cm");
    }
  }
];

export type { WearableReading };
