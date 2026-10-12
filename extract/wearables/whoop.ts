import type { WearableConnectionStore } from "../../load/wearable-connections";
import { providerGet } from "./api";

// Whoop API v2 → AyuOS readings, matching what the previous wearables backend
// stored: recovery (resting HR, HRV RMSSD, SpO2, skin temp) at the recovery's
// created_at, cycle (average/max HR) at the cycle start. Unscored records are
// skipped until Whoop scores them.

interface Page<T> {
  records?: T[];
  next_token?: string | null;
}

export const WHOOP_DATA_TYPES = ["recovery", "cycle"] as const;

export function readingsFromWhoop(
  kind: (typeof WHOOP_DATA_TYPES)[number],
  records: any[],
  push: (metricType: string, ts: string, value: unknown, unit: string) => void
): void {
  for (const record of records) {
    if (record.score_state !== "SCORED") continue;
    const score = record.score ?? {};
    if (kind === "recovery" && record.created_at) {
      push("resting_heart_rate", record.created_at, score.resting_heart_rate, "bpm");
      push("heart_rate_variability_rmssd", record.created_at, score.hrv_rmssd_milli, "ms");
      push("oxygen_saturation", record.created_at, score.spo2_percentage, "percent");
      push("skin_temperature", record.created_at, score.skin_temp_celsius, "celsius");
    }
    if (kind === "cycle" && record.start) {
      push("average_heart_rate", record.start, score.average_heart_rate, "bpm");
      push("max_heart_rate", record.start, score.max_heart_rate, "bpm");
    }
  }
}

export async function fetchWhoopType(
  store: WearableConnectionStore,
  kind: (typeof WHOOP_DATA_TYPES)[number],
  start: Date,
  end: Date
): Promise<any[]> {
  const all: any[] = [];
  let nextToken: string | null | undefined;
  do {
    const params: Record<string, string> = {
      start: start.toISOString().replace(/\.\d{3}Z$/, "Z"),
      end: end.toISOString().replace(/\.\d{3}Z$/, "Z"),
      limit: "25"
    };
    if (nextToken) params.nextToken = nextToken;
    const page = await providerGet<Page<any>>(store, "whoop", `/v2/${kind}`, params);
    all.push(...(page.records ?? []));
    nextToken = page.records?.length ? page.next_token : null;
  } while (nextToken);
  return all;
}

export async function fetchWhoopBody(
  store: WearableConnectionStore
): Promise<{ height_meter?: number; weight_kilogram?: number; max_heart_rate?: number }> {
  return providerGet(store, "whoop", "/v2/user/measurement/body");
}

export async function fetchWhoopProfile(store: WearableConnectionStore): Promise<{ user_id?: number }> {
  return providerGet(store, "whoop", "/v2/user/profile/basic");
}
