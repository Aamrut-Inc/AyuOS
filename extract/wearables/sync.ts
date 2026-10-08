import { SQL } from "bun";
import type { WearablesConfig } from "./config";
import { fetchTimeseries } from "./client";
import { getConnections } from "./oauth";
import { loadPostgresConfig } from "../../load/config";
import { TimeseriesStore } from "../../load/timeseries";

// Effectively "everything available" for a first-ever sync — real device
// history doesn't go back further than this in practice, so there's no
// harm asking further back than data actually exists.
const FULL_HISTORY_LOOKBACK_DAYS = 3650;

// On incremental syncs, re-request a little before the last known reading
// rather than starting exactly at it: devices upload late (a ring that
// hasn't synced to the phone for a day or two), and sleep/readiness land
// hours after the period they describe. Upserts make the overlap free.
const INCREMENTAL_OVERLAP_MS = 3 * 24 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

async function latestReadingByProvider(userId: string): Promise<Map<string, Date>> {
  const sql = new SQL(loadPostgresConfig().connectionString);
  try {
    const rows = await sql`
      SELECT source_provider, max(ts) AS latest
      FROM timeseries.readings WHERE user_id = ${userId}
      GROUP BY source_provider
    `;
    return new Map(rows.map((row: any) => [row.source_provider, new Date(row.latest)]));
  } finally {
    await sql.close();
  }
}

// The timeseries API returns every provider in one stream, so one request
// window has to cover all of them: start from whichever connected provider
// is furthest behind. A provider connected later than the others (no local
// readings yet) therefore still gets its full history pulled, rather than
// only what's newer than some other provider's latest reading.
export function syncWindowStart(
  connectedProviders: string[],
  latestByProvider: Map<string, Date>,
  now: Date
): Date {
  const fullHistory = new Date(now.getTime() - FULL_HISTORY_LOOKBACK_DAYS * DAY_MS);
  if (connectedProviders.length === 0) {
    const latest = [...latestByProvider.values()].sort((a, b) => b.getTime() - a.getTime())[0];
    return latest ? new Date(latest.getTime() - INCREMENTAL_OVERLAP_MS) : fullHistory;
  }

  let start = now;
  for (const provider of connectedProviders) {
    const latest = latestByProvider.get(provider);
    const providerStart = latest ? new Date(latest.getTime() - INCREMENTAL_OVERLAP_MS) : fullHistory;
    if (providerStart < start) start = providerStart;
  }
  return start;
}

// A provider whose backend connection hasn't synced since our newest local
// reading for it (e.g. a broken connection still marked active) can't have
// anything new, so it shouldn't drag the window back on every run.
export function providersWithPossibleNewData(
  connections: Array<{ provider: string; status: string; last_synced_at?: string | null }>,
  latestByProvider: Map<string, Date>
): string[] {
  return connections
    .filter((c) => c.status === "active")
    .filter((c) => {
      const latest = latestByProvider.get(c.provider);
      if (!latest || !c.last_synced_at) return true;
      return new Date(c.last_synced_at).getTime() > latest.getTime() - INCREMENTAL_OVERLAP_MS;
    })
    .map((c) => c.provider);
}

export async function syncWearables(
  config: WearablesConfig,
  userId: string
): Promise<Record<string, number>> {
  const connections = await getConnections(config, userId);
  const latestByProvider = await latestReadingByProvider(userId);
  const providers = providersWithPossibleNewData(connections, latestByProvider);

  const endTime = new Date();
  const startTime = syncWindowStart(providers, latestByProvider, endTime);

  const store = new TimeseriesStore(loadPostgresConfig());
  const countsByType: Record<string, number> = {};

  try {
    for await (const batch of fetchTimeseries(config, userId, startTime, endTime)) {
      await store.upsertReadings(batch);
      for (const reading of batch) {
        countsByType[reading.metricType] = (countsByType[reading.metricType] ?? 0) + 1;
      }
    }
  } finally {
    await store.close();
  }

  return countsByType;
}
