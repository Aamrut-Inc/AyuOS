import { SQL } from "bun";
import type { WearablesConfig } from "./config";
import { fetchTimeseries } from "./client";
import { loadPostgresConfig } from "../../load/config";
import { TimeseriesStore } from "../../load/timeseries";

// The request covers all of time; what keeps it incremental is asking only
// for rows the wearables backend *stored* since our last successful copy.
// Filtering on storage time rather than reading time is what catches history
// that arrives late: the backfill after connecting a new device (old readings
// saved minutes later), or a ring that syncs to the phone days afterwards.
const FULL_HISTORY_LOOKBACK_DAYS = 3650;

// Re-ask for a little before the last copy started, so rows committed while
// that copy was running aren't missed. Upserts make the overlap free.
const WRITTEN_SINCE_OVERLAP_MS = 10 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

async function lastSuccessfulCopyStartedAt(): Promise<Date | null> {
  const sql = new SQL(loadPostgresConfig().connectionString);
  try {
    const [row] = await sql`
      SELECT max(started_at) AS at FROM ops.sync_runs
      WHERE job = 'wearables-mirror' AND status = 'success'
    `;
    return row?.at ? new Date(row.at) : null;
  } finally {
    await sql.close();
  }
}

export function writtenSince(lastCopyStartedAt: Date | null): Date | null {
  return lastCopyStartedAt ? new Date(lastCopyStartedAt.getTime() - WRITTEN_SINCE_OVERLAP_MS) : null;
}

export async function syncWearables(
  config: WearablesConfig,
  userId: string
): Promise<Record<string, number>> {
  const now = new Date();
  const startTime = new Date(now.getTime() - FULL_HISTORY_LOOKBACK_DAYS * DAY_MS);
  // Readings can carry timestamps slightly in the future (timezone quirks).
  const endTime = new Date(now.getTime() + DAY_MS);
  const since = writtenSince(await lastSuccessfulCopyStartedAt());

  const store = new TimeseriesStore(loadPostgresConfig());
  const countsByType: Record<string, number> = {};

  try {
    for await (const batch of fetchTimeseries(config, userId, startTime, endTime, since)) {
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
