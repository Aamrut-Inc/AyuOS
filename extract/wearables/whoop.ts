import type { WearableConnectionStore } from "../../load/wearable-connections";
import type { WearableRecord } from "../../load/wearable-records";
import { providerGet } from "./api";
import type { DataTypeSpec, PushReading } from "./readings";

// Whoop API v2 → AyuOS. Every endpoint of the API (see docs/data-retrieval.md):
// each document is kept whole in wearables.records, and every scored value
// becomes a reading. Names the previous wearables backend used (recovery:
// resting HR, HRV RMSSD, SpO2, skin temp at created_at; cycle: average/max HR
// at start) are unchanged. Unscored records produce readings once Whoop has
// scored them; their documents are kept meanwhile.

interface Page<T> {
  records?: T[];
  next_token?: string | null;
}

const KJ_PER_KCAL = 4.184;

function seconds(milli: unknown): number | null {
  return typeof milli === "number" ? milli / 1000 : null;
}

function kcal(kilojoule: unknown): number | null {
  return typeof kilojoule === "number" ? kilojoule / KJ_PER_KCAL : null;
}

const READINGS: Record<string, (record: any, score: any, push: PushReading) => void> = {
  cycle(record, score, push) {
    if (!record.start) return;
    push("average_heart_rate", record.start, score.average_heart_rate, "bpm");
    push("max_heart_rate", record.start, score.max_heart_rate, "bpm");
    push("strain", record.start, score.strain, "strain");
    push("total_energy", record.start, kcal(score.kilojoule), "kcal");
    push("steps", record.start, record.step_count, "count");
  },
  recovery(record, score, push) {
    if (!record.created_at) return;
    const context = score.user_calibrating ? "calibrating" : null;
    push("resting_heart_rate", record.created_at, score.resting_heart_rate, "bpm");
    push("heart_rate_variability_rmssd", record.created_at, score.hrv_rmssd_milli, "ms");
    push("oxygen_saturation", record.created_at, score.spo2_percentage, "percent");
    push("skin_temperature", record.created_at, score.skin_temp_celsius, "celsius");
    push("recovery_score", record.created_at, score.recovery_score, "percent", context);
  },
  sleep(record, score, push) {
    const ts = record.start;
    if (!ts) return;
    const context = record.nap ? "nap" : "sleep";
    const stages = score.stage_summary ?? {};
    const needed = score.sleep_needed ?? {};
    const asleep = [stages.total_light_sleep_time_milli, stages.total_slow_wave_sleep_time_milli, stages.total_rem_sleep_time_milli];
    push("sleep_total_duration", ts, asleep.every((v) => typeof v === "number") ? asleep.reduce((a, b) => a + b, 0) / 1000 : null, "s", context);
    push("sleep_deep_duration", ts, seconds(stages.total_slow_wave_sleep_time_milli), "s", context);
    push("sleep_light_duration", ts, seconds(stages.total_light_sleep_time_milli), "s", context);
    push("sleep_rem_duration", ts, seconds(stages.total_rem_sleep_time_milli), "s", context);
    push("sleep_awake_time", ts, seconds(stages.total_awake_time_milli), "s", context);
    push("sleep_time_in_bed", ts, seconds(stages.total_in_bed_time_milli), "s", context);
    push("sleep_no_data_time", ts, seconds(stages.total_no_data_time_milli), "s", context);
    push("sleep_cycle_count", ts, stages.sleep_cycle_count, "count", context);
    push("sleep_disturbance_count", ts, stages.disturbance_count, "count", context);
    push("sleep_need_baseline", ts, seconds(needed.baseline_milli), "s", context);
    push("sleep_need_from_sleep_debt", ts, seconds(needed.need_from_sleep_debt_milli), "s", context);
    push("sleep_need_from_recent_strain", ts, seconds(needed.need_from_recent_strain_milli), "s", context);
    push("sleep_need_from_recent_nap", ts, seconds(needed.need_from_recent_nap_milli), "s", context);
    push("sleep_respiratory_rate", ts, score.respiratory_rate, "breaths/min", context);
    push("sleep_performance", ts, score.sleep_performance_percentage, "percent", context);
    push("sleep_consistency", ts, score.sleep_consistency_percentage, "percent", context);
    push("sleep_efficiency", ts, score.sleep_efficiency_percentage, "percent", context);
  },
  workout(record, score, push) {
    const ts = record.start;
    if (!ts) return;
    const sport = record.sport_name ?? null;
    const durationS = record.end ? (new Date(record.end).getTime() - new Date(ts).getTime()) / 1000 : null;
    push("workout_duration", ts, durationS, "s", sport);
    push("workout_strain", ts, score.strain, "strain", sport);
    push("workout_average_heart_rate", ts, score.average_heart_rate, "bpm", sport);
    push("workout_max_heart_rate", ts, score.max_heart_rate, "bpm", sport);
    push("workout_calories", ts, kcal(score.kilojoule), "kcal", sport);
    push("workout_distance", ts, score.distance_meter, "meters", sport);
    push("workout_altitude_gain", ts, score.altitude_gain_meter, "meters", sport);
    push("workout_altitude_change", ts, score.altitude_change_meter, "meters", sport);
    push("workout_percent_recorded", ts, score.percent_recorded, "percent", sport);
    const zones = score.zone_durations ?? {};
    ["zero", "one", "two", "three", "four", "five"].forEach((zone, i) => {
      push(`workout_zone_${i}_duration`, ts, seconds(zones[`zone_${zone}_milli`]), "s", sport);
    });
  }
};

export function readingsFromWhoop(kind: string, records: any[], push: PushReading): void {
  const map = READINGS[kind];
  if (!map) return;
  for (const record of records) {
    if (record.score_state !== "SCORED") continue;
    map(record, record.score ?? {}, push);
  }
}

function whoopRecord(record: any): WearableRecord {
  return {
    // Recoveries have no id of their own: one per cycle.
    recordId: String(record.id ?? record.cycle_id),
    json: record,
    day: null,
    startTime: record.start ?? record.created_at ?? null,
    endTime: record.end ?? null
  };
}

function utc(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function fetchCollection(store: WearableConnectionStore, path: string, start: Date, end: Date): Promise<any[]> {
  const all: any[] = [];
  let nextToken: string | null | undefined;
  do {
    const params: Record<string, string> = { start: utc(start), end: utc(end), limit: "25" };
    if (nextToken) params.nextToken = nextToken;
    const page = await providerGet<Page<any>>(store, "whoop", path, params);
    all.push(...(page.records ?? []));
    nextToken = page.records?.length ? page.next_token : null;
  } while (nextToken);
  return all;
}

function collection(name: string, path: string): DataTypeSpec {
  return {
    name,
    history: "window",
    fetch: (store, start, end) => fetchCollection(store, path, start, end),
    record: whoopRecord,
    readings: (records, push) => readingsFromWhoop(name, records, push)
  };
}

export const WHOOP_TYPES: DataTypeSpec[] = [
  collection("cycle", "/v2/cycle"),
  collection("recovery", "/v2/recovery"),
  collection("sleep", "/v2/activity/sleep"),
  collection("workout", "/v2/activity/workout"),
  {
    name: "profile",
    history: "snapshot",
    fetch: async (store) => [await providerGet(store, "whoop", "/v2/user/profile/basic")],
    record: (profile) => ({ recordId: String(profile.user_id ?? "profile"), json: profile, day: null, startTime: null, endTime: null }),
    readings: () => {}
  },
  {
    name: "body_measurement",
    history: "snapshot",
    fetch: async (store) => [await providerGet(store, "whoop", "/v2/user/measurement/body")],
    record: (body) => ({ recordId: "body", json: body, day: null, startTime: null, endTime: null }),
    readings(items, push, now) {
      const body = items[0] ?? {};
      const ts = now.toISOString();
      if (typeof body.height_meter === "number") push("height", ts, Math.round(body.height_meter * 10000) / 100, "cm");
      push("weight", ts, body.weight_kilogram, "kg");
      push("max_heart_rate", ts, body.max_heart_rate, "bpm");
    }
  }
];
