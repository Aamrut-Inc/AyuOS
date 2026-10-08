import type { WearablesConfig } from "./config";
import { guardedFetch } from "./security/network-guard";

export interface WearableReading {
  userId: string;
  metricType: string;
  ts: string;
  value: number;
  unit: string | null;
  sourceProvider: string;
  sourceDevice: string | null;
}

interface TimeseriesApiResponse {
  data: Array<{
    timestamp: string;
    type: string;
    value: number;
    unit?: string | null;
    source?: { provider?: string | null; device?: string | null };
  }>;
  pagination: {
    next_cursor: string | null;
    has_more: boolean;
    total_count: number;
  };
}

export async function* fetchTimeseries(
  config: WearablesConfig,
  userId: string,
  startTime: Date,
  endTime: Date
): AsyncGenerator<WearableReading[]> {
  let cursor: string | null = null;

  while (true) {
    const url = new URL(`${config.apiBaseUrl}/api/v1/users/${userId}/timeseries`);
    url.searchParams.set("start_time", startTime.toISOString());
    url.searchParams.set("end_time", endTime.toISOString());
    url.searchParams.set("resolution", "raw");
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("cursor", cursor);

    const response = await guardedFetch(
      url.toString(),
      { headers: { "X-Open-Wearables-API-Key": config.apiKey } },
      config
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Wearables timeseries request failed (${response.status}): ${text}`
      );
    }

    const payload = (await response.json()) as TimeseriesApiResponse;

    yield payload.data.map((sample) => ({
      userId,
      metricType: sample.type,
      ts: sample.timestamp,
      value: sample.value,
      unit: sample.unit ?? null,
      sourceProvider: sample.source?.provider ?? "unknown",
      sourceDevice: sample.source?.device ?? null
    }));

    if (!payload.pagination.has_more || !payload.pagination.next_cursor) break;
    cursor = payload.pagination.next_cursor;
  }
}

// Ask the wearables backend to pull new data from the provider now instead of
// waiting for its hourly schedule (used right after the laptop wakes). The
// backend queues the sync and resumes from its own per-connection cursor.
export async function requestProviderSync(
  config: WearablesConfig,
  provider: string,
  userId: string
): Promise<void> {
  const url = `${config.apiBaseUrl}/api/v1/providers/${provider}/users/${userId}/sync`;
  const response = await guardedFetch(
    url,
    { method: "POST", headers: { "X-Open-Wearables-API-Key": config.apiKey } },
    config
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Requesting ${provider} sync failed (${response.status}): ${text}`);
  }
}
