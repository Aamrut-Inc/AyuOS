export interface WearableReading {
  userId: string;
  metricType: string;
  ts: string;
  value: number;
  unit: string | null;
  sourceProvider: string;
  sourceDevice: string | null;
}

// Collects readings, dropping empty/non-numeric values.
export function readingCollector(userId: string, provider: string) {
  const readings: WearableReading[] = [];
  const push = (metricType: string, ts: string, value: unknown, unit: string) => {
    const num = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    if (!Number.isFinite(num)) return;
    readings.push({ userId, metricType, ts: new Date(ts).toISOString(), value: num, unit, sourceProvider: provider, sourceDevice: null });
  };
  return { readings, push };
}
