import { SQL } from "bun";
import type { WearablesConfig } from "./config";
import { fetchTimeseries } from "./client";
import { loadPostgresConfig } from "../../load/config";
import { TimeseriesStore } from "../../load/timeseries";

// Effectively "everything available" for a first-ever sync — real device
// history doesn't go back further than this in practice, so there's no
// harm asking further back than data actually exists.
const FULL_HISTORY_LOOKBACK_DAYS = 3650;

// On incremental syncs, re-request a little before the last known reading
// rather than starting exactly at it, in case anything landed out of order.
const INCREMENTAL_OVERLAP_MS = 24 * 60 * 60 * 1000;

async function getLastSyncedTimestamp(userId: string): Promise<Date | null> {
  const sql = new SQL(loadPostgresConfig().connectionString);
  try {
    const [row] = await sql`
      SELECT max(ts) AS latest FROM timeseries.readings WHERE user_id = ${userId}
    `;
    return row?.latest ? new Date(row.latest) : null;
  } finally {
    await sql.close();
  }
}

export async function syncWearables(
  config: WearablesConfig,
  userId: string
): Promise<Record<string, number>> {
  const store = new TimeseriesStore(loadPostgresConfig());

  const endTime = new Date();
  const lastSynced = await getLastSyncedTimestamp(userId);
  const startTime = lastSynced
    ? new Date(lastSynced.getTime() - INCREMENTAL_OVERLAP_MS)
    : new Date(endTime.getTime() - FULL_HISTORY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

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
