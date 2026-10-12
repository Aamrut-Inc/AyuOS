import type { WearableConnectionStore } from "../../load/wearable-connections";
import { providerGet } from "./api";
import type { WearableReading } from "./readings";

// Oura API v2 → AyuOS readings. Metric names, units and timestamps match what
// the previous wearables backend stored, so history stays continuous.

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
const HEARTRATE_CHUNK_DAYS = 30; // Oura caps heartrate requests at 30 days

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function dayStart(day: string): string {
  return `${day}T00:00:00.000Z`;
}

export function readingsFromOura(
  kind: string,
  items: any[],
  push: (metricType: string, ts: string, value: unknown, unit: string) => void
): void {
  for (const item of items) {
    switch (kind) {
      case "daily_activity": {
        const ts = item.timestamp ?? (item.day ? dayStart(item.day) : null);
        if (!ts) break;
        push("steps", ts, item.steps, "count");
        push("energy", ts, item.active_calories, "kcal");
        push("distance_walking_running", ts, item.equivalent_walking_distance, "meters");
        break;
      }
      case "daily_readiness": {
        const ts = item.timestamp ?? (item.day ? dayStart(item.day) : null);
        if (!ts) break;
        push("skin_temperature_deviation", ts, item.temperature_deviation, "celsius");
        push("skin_temperature_trend_deviation", ts, item.temperature_trend_deviation, "celsius");
        break;
      }
      case "daily_cardiovascular_age":
        if (item.day) push("cardiovascular_age", dayStart(item.day), item.vascular_age, "years");
        break;
      case "daily_spo2":
        if (item.day) {
          push("oxygen_saturation", dayStart(item.day), item.spo2_percentage?.average, "percent");
          push("breathing_disturbance_index", dayStart(item.day), item.breathing_disturbance_index, "score");
        }
        break;
      case "vO2_max":
        if (item.timestamp && item.vo2_max) push("vo2_max", item.timestamp, item.vo2_max, "ml_kg_min");
        break;
      case "heartrate":
        if (item.timestamp) push("heart_rate", item.timestamp, item.bpm, "bpm");
        break;
      case "sleep":
        for (const [field, metric, unit] of [
          ["heart_rate", "heart_rate", "bpm"],
          ["hrv", "heart_rate_variability_sdnn", "ms"]
        ] as const) {
          const series = item[field] as IntervalData | undefined;
          if (!series?.timestamp || !series.interval || !series.items) continue;
          const start = new Date(series.timestamp).getTime();
          series.items.forEach((value, i) => {
            push(metric, new Date(start + series.interval! * 1000 * i).toISOString(), value, unit);
          });
        }
        break;
    }
  }
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

export const OURA_DATA_TYPES = [
  "daily_activity",
  "daily_readiness",
  "daily_cardiovascular_age",
  "daily_spo2",
  "vO2_max",
  "sleep",
  "heartrate"
] as const;

// Raw items of one Oura data type between two instants.
export async function fetchOuraType(
  store: WearableConnectionStore,
  kind: (typeof OURA_DATA_TYPES)[number],
  start: Date,
  end: Date
): Promise<any[]> {
  const path = `/v2/usercollection/${kind}`;
  if (kind !== "heartrate") {
    return paginate(store, path, { start_date: isoDate(start), end_date: isoDate(new Date(end.getTime() + DAY_MS)) });
  }
  const items: any[] = [];
  for (let chunk = start.getTime(); chunk < end.getTime(); chunk += HEARTRATE_CHUNK_DAYS * DAY_MS) {
    const chunkEnd = Math.min(chunk + HEARTRATE_CHUNK_DAYS * DAY_MS, end.getTime());
    items.push(
      ...(await paginate(store, path, {
        start_datetime: new Date(chunk).toISOString().replace(/\.\d{3}Z$/, "Z"),
        end_datetime: new Date(chunkEnd).toISOString().replace(/\.\d{3}Z$/, "Z")
      }))
    );
  }
  return items;
}

export async function fetchOuraPersonalInfo(store: WearableConnectionStore): Promise<{ weight?: number; height?: number }> {
  return providerGet(store, "oura", "/v2/usercollection/personal_info");
}

export type { WearableReading };
