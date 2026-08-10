import type { WearablesConfig } from "./config";
import { fetchTimeseries } from "./client";
import { loadPostgresConfig } from "../../load/config";
import { TimeseriesStore } from "../../load/timeseries";

export async function syncWearables(
  config: WearablesConfig,
  userId: string
): Promise<Record<string, number>> {
  const store = new TimeseriesStore(loadPostgresConfig());

  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - config.syncDays * 24 * 60 * 60 * 1000);

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
