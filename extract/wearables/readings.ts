import type { WearableConnectionStore } from "../../load/wearable-connections";
import type { WearableRecord } from "../../load/wearable-records";

// One kind of document a provider serves (Oura "daily_sleep", Whoop "workout").
export interface DataTypeSpec {
  // The provider's own name; stored as wearables.records.data_type.
  name: string;
  // "window": documents dated in a time range, fetched from the type's resume
  // point. "snapshot": the account's current state (profile, ring), fetched
  // whole every sync.
  history: "window" | "snapshot";
  fetch(store: WearableConnectionStore, start: Date, end: Date): Promise<any[]>;
  // How to keep each document in wearables.records. Absent for dense time
  // series (heart rate, battery) whose every field is already a reading.
  record?: (item: any) => WearableRecord;
  readings(items: any[], push: PushReading, now: Date): void;
}

export interface WearableReading {
  userId: string;
  metricType: string;
  ts: string;
  value: number;
  unit: string | null;
  sourceProvider: string;
  sourceDevice: string | null;
  // Qualifier such as the activity of a heart-rate sample or a workout's sport.
  context?: string | null;
}

export type PushReading = (metricType: string, ts: string, value: unknown, unit: string, context?: string | null) => void;

// Collects readings, dropping empty/non-numeric values.
export function readingCollector(userId: string, provider: string) {
  const readings: WearableReading[] = [];
  const push: PushReading = (metricType, ts, value, unit, context = null) => {
    const num = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    if (!Number.isFinite(num)) return;
    readings.push({
      userId,
      metricType,
      ts: new Date(ts).toISOString(),
      value: num,
      unit,
      sourceProvider: provider,
      sourceDevice: null,
      context: context ?? null
    });
  };
  return { readings, push };
}
