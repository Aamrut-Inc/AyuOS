import { SQL } from "bun";
import type { PostgresConfig } from "./config";
import type { WearableReading } from "../extract/wearables/readings";

const READING_COLUMNS = [
  "user_id",
  "metric_type",
  "ts",
  "value",
  "unit",
  "source_provider",
  "source_device",
  "context"
] as const;

function monthBounds(date: Date): { start: Date; end: Date; label: string } {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  const label = `${start.getUTCFullYear()}_${String(start.getUTCMonth() + 1).padStart(2, "0")}`;
  return { start, end, label };
}

export class TimeseriesStore {
  private readonly sql: SQL;
  private readonly ensuredPartitions = new Set<string>();

  constructor(config: PostgresConfig) {
    this.sql = new SQL(config.connectionString);
  }

  private async ensurePartition(date: Date): Promise<void> {
    const { start, end, label } = monthBounds(date);
    if (this.ensuredPartitions.has(label)) return;

    await this.sql.unsafe(`
      CREATE TABLE IF NOT EXISTS timeseries.readings_${label}
      PARTITION OF timeseries.readings
      FOR VALUES FROM ('${start.toISOString()}') TO ('${end.toISOString()}')
    `);

    this.ensuredPartitions.add(label);
  }

  async upsertReadings(input: WearableReading[]): Promise<void> {
    // One INSERT ... ON CONFLICT can't touch the same row twice, and sources
    // do repeat a reading (Oura at 30-day request boundaries, or the same
    // instant from two feeds): keep the last of each key.
    const byKey = new Map<string, WearableReading>();
    for (const r of input) {
      byKey.set(`${r.userId}|${r.metricType}|${new Date(r.ts).toISOString()}|${r.sourceProvider}`, r);
    }
    const readings = [...byKey.values()];
    if (readings.length === 0) return;

    for (const reading of readings) {
      await this.ensurePartition(new Date(reading.ts));
    }

    const rows = readings.map((r) => ({
      user_id: r.userId,
      metric_type: r.metricType,
      ts: r.ts,
      value: r.value,
      unit: r.unit,
      source_provider: r.sourceProvider,
      source_device: r.sourceDevice,
      context: r.context ?? null
    }));

    await this.sql`
      INSERT INTO timeseries.readings ${this.sql(rows, ...READING_COLUMNS)}
      ON CONFLICT (user_id, metric_type, ts, source_provider) DO UPDATE SET
        value = EXCLUDED.value,
        unit = EXCLUDED.unit,
        source_device = EXCLUDED.source_device,
        context = EXCLUDED.context,
        fetched_at = now()
    `;
  }

  async close(): Promise<void> {
    await this.sql.close();
  }
}
