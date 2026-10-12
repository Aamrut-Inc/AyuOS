import { SQL } from "bun";
import { loadPostgresConfig } from "../../load/config";
import { TimeseriesStore } from "../../load/timeseries";
import type { WearableConnectionStore } from "../../load/wearable-connections";
import { NotAvailableError } from "./api";
import { fetchOuraPersonalInfo, fetchOuraType, OURA_DATA_TYPES, readingsFromOura } from "./oura";
import { PROVIDERS, type WearableProvider } from "./providers";
import { readingCollector, type WearableReading } from "./readings";
import { fetchWhoopBody, fetchWhoopType, readingsFromWhoop, WHOOP_DATA_TYPES } from "./whoop";

const DAY_MS = 24 * 60 * 60 * 1000;
const FULL_HISTORY_DAYS = 3650;
// Re-fetch a few days before the last sync: rings upload late, and daily
// summaries (sleep, readiness) are finalized hours after the day ends.
// Upserts make the overlap free.
const OVERLAP_MS = 3 * DAY_MS;
const BATCH_SIZE = 500;

export function syncWindowStart(lastSyncedAt: Date | null, now: Date): Date {
  return lastSyncedAt
    ? new Date(lastSyncedAt.getTime() - OVERLAP_MS)
    : new Date(now.getTime() - FULL_HISTORY_DAYS * DAY_MS);
}

// Weight/height/max HR come as "current value" snapshots: store one only when
// it differs from the latest stored for that provider.
async function changedSnapshots(userId: string, provider: string, readings: WearableReading[]): Promise<WearableReading[]> {
  if (readings.length === 0) return [];
  const sql = new SQL(loadPostgresConfig().connectionString);
  try {
    const out: WearableReading[] = [];
    for (const reading of readings) {
      const [latest] = await sql`
        SELECT value FROM timeseries.readings
        WHERE user_id = ${userId} AND source_provider = ${provider} AND metric_type = ${reading.metricType}
        ORDER BY ts DESC LIMIT 1
      `;
      if (!latest || Math.abs(Number(latest.value) - reading.value) > 0.01) out.push(reading);
    }
    return out;
  } finally {
    await sql.close();
  }
}

async function snapshotReadings(store: WearableConnectionStore, provider: WearableProvider, userId: string, now: Date) {
  const { readings, push } = readingCollector(userId, provider);
  const ts = now.toISOString();
  if (provider === "oura") {
    const info = await fetchOuraPersonalInfo(store);
    push("weight", ts, info.weight, "kg");
    if (typeof info.height === "number") push("height", ts, Math.round(info.height * 10000) / 100, "cm");
  } else {
    const body = await fetchWhoopBody(store);
    if (typeof body.height_meter === "number") push("height", ts, Math.round(body.height_meter * 10000) / 100, "cm");
    push("weight", ts, body.weight_kilogram, "kg");
    push("max_heart_rate", ts, body.max_heart_rate, "bpm");
  }
  return changedSnapshots(userId, provider, readings);
}

export interface ProviderSyncResult {
  provider: WearableProvider;
  from: string;
  readings: Record<string, number>;
  skipped: string[];
}

// Pulls everything since the provider's resume point into timeseries.readings.
// The resume point only moves forward when every data type was fetched;
// otherwise the error is thrown and the next run retries the same window.
export async function syncProvider(
  store: WearableConnectionStore,
  provider: WearableProvider,
  userId: string,
  now = new Date()
): Promise<ProviderSyncResult> {
  const start = syncWindowStart(await store.lastSyncedAt(provider), now);
  const counts: Record<string, number> = {};
  const skipped: string[] = [];
  const failures: string[] = [];
  const timeseries = new TimeseriesStore(loadPostgresConfig());

  async function save(readings: WearableReading[]) {
    for (let i = 0; i < readings.length; i += BATCH_SIZE) {
      await timeseries.upsertReadings(readings.slice(i, i + BATCH_SIZE));
    }
    for (const r of readings) counts[r.metricType] = (counts[r.metricType] ?? 0) + 1;
  }

  async function attempt(label: string, work: () => Promise<void>) {
    try {
      await work();
    } catch (error) {
      if (error instanceof NotAvailableError) skipped.push(label);
      else failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  try {
    const types: readonly string[] = provider === "oura" ? OURA_DATA_TYPES : WHOOP_DATA_TYPES;
    for (const kind of types) {
      await attempt(kind, async () => {
        const { readings, push } = readingCollector(userId, provider);
        if (provider === "oura") {
          readingsFromOura(kind, await fetchOuraType(store, kind as (typeof OURA_DATA_TYPES)[number], start, now), push);
        } else {
          readingsFromWhoop(
            kind as (typeof WHOOP_DATA_TYPES)[number],
            await fetchWhoopType(store, kind as (typeof WHOOP_DATA_TYPES)[number], start, now),
            push
          );
        }
        await save(readings);
      });
    }
    await attempt("body measurements", async () => save(await snapshotReadings(store, provider, userId, now)));
  } finally {
    await timeseries.close();
  }

  if (failures.length > 0) {
    const message = `${PROVIDERS[provider].name}: ${failures.join("; ")}`;
    await store.recordError(provider, message);
    throw new Error(message);
  }
  await store.markSynced(provider, now);
  return { provider, from: start.toISOString(), readings: counts, skipped };
}
