import { SQL } from "bun";
import { loadPostgresConfig } from "../../load/config";
import { TimeseriesStore } from "../../load/timeseries";
import type { WearableConnectionStore } from "../../load/wearable-connections";
import { WearableRecordStore } from "../../load/wearable-records";
import { NotAvailableError } from "./api";
import { ReconnectRequiredError } from "./oauth";
import { OURA_TYPES } from "./oura";
import { PROVIDERS, type WearableProvider } from "./providers";
import { readingCollector, type DataTypeSpec, type WearableReading } from "./readings";
import { WHOOP_TYPES } from "./whoop";

const DAY_MS = 24 * 60 * 60 * 1000;
const FULL_HISTORY_DAYS = 3650;
// Re-fetch a few days before the last sync: rings upload late, and daily
// summaries (sleep, readiness) are finalized hours after the day ends.
// Upserts make the overlap free.
const OVERLAP_MS = 3 * DAY_MS;
const BATCH_SIZE = 500;

// Types synced before resume points were kept per type: they continue from
// the provider-wide resume point instead of re-downloading years of history.
// Every other type, including ones whose documents are now kept whole,
// downloads its full history once.
const RESUME_FROM_PROVIDER = new Set(["oura:heartrate"]);

export function providerTypes(provider: WearableProvider): DataTypeSpec[] {
  return provider === "oura" ? OURA_TYPES : WHOOP_TYPES;
}

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

export interface ProviderSyncResult {
  provider: WearableProvider;
  // Readings saved per metric, and documents new or changed per data type.
  readings: Record<string, number>;
  documents: Record<string, number>;
  skipped: string[];
}

// Pulls every data type since its own resume point: documents into
// wearables.records, values into timeseries.readings. A type's resume point
// moves forward only when it was fetched and saved; if any type failed, the
// error is thrown (the others keep their progress) and the next run retries.
export async function syncProvider(
  store: WearableConnectionStore,
  provider: WearableProvider,
  userId: string,
  now = new Date()
): Promise<ProviderSyncResult> {
  const providerLast = await store.lastSyncedAt(provider);
  const readingCounts: Record<string, number> = {};
  const documentCounts: Record<string, number> = {};
  const skipped: string[] = [];
  const failures: string[] = [];
  const config = loadPostgresConfig();
  const timeseries = new TimeseriesStore(config);
  const records = new WearableRecordStore(config);

  async function saveReadings(readings: WearableReading[]) {
    for (let i = 0; i < readings.length; i += BATCH_SIZE) {
      await timeseries.upsertReadings(readings.slice(i, i + BATCH_SIZE));
    }
    for (const r of readings) readingCounts[r.metricType] = (readingCounts[r.metricType] ?? 0) + 1;
  }

  try {
    for (const type of providerTypes(provider)) {
      try {
        let last = await store.typeSyncedAt(provider, type.name);
        if (!last && RESUME_FROM_PROVIDER.has(`${provider}:${type.name}`)) last = providerLast;
        const items = await type.fetch(store, syncWindowStart(last, now), now);

        if (type.record) {
          const written = await records.upsert(provider, type.name, items.map(type.record));
          if (written > 0) documentCounts[type.name] = written;
        }
        const { readings, push } = readingCollector(userId, provider);
        type.readings(items, push, now);
        await saveReadings(type.history === "snapshot" ? await changedSnapshots(userId, provider, readings) : readings);

        if (type.history === "window") await store.markTypeSynced(provider, type.name, now);
      } catch (error) {
        if (error instanceof NotAvailableError) {
          skipped.push(type.name);
          continue;
        }
        failures.push(`${type.name}: ${error instanceof Error ? error.message : String(error)}`);
        // A dead login fails every type the same way.
        if (error instanceof ReconnectRequiredError) break;
      }
    }
  } finally {
    await timeseries.close();
    await records.close();
  }

  if (failures.length > 0) {
    const message = `${PROVIDERS[provider].name}: ${failures.join("; ")}`;
    await store.recordError(provider, message);
    throw new Error(message);
  }
  await store.markSynced(provider, now);
  return { provider, readings: readingCounts, documents: documentCounts, skipped };
}
