import { SQL } from "bun";
import { createHash } from "node:crypto";
import type { PostgresConfig } from "./config";

export interface WearableRecord {
  recordId: string;
  json: unknown;
  day: string | null;
  startTime: string | null;
  endTime: string | null;
}

const BATCH_SIZE = 500;

// Every Oura/Whoop document as the provider sent it, with version history:
// an unchanged document is skipped, a changed one becomes the new current
// version and the old one is kept (same scheme as clinical.fhir_resources).
// Only one sync per provider runs at a time (see app/scheduler.ts), so a
// batch can compare and write without row locks.
export class WearableRecordStore {
  private readonly sql: SQL;

  constructor(config: PostgresConfig) {
    this.sql = new SQL(config.connectionString);
  }

  // Returns how many documents were new or changed.
  async upsert(provider: string, dataType: string, records: WearableRecord[]): Promise<number> {
    // A provider can return the same document twice across pages: keep the last.
    const byId = new Map(records.map((r) => [r.recordId, r]));
    const unique = [...byId.values()];
    let written = 0;
    for (let i = 0; i < unique.length; i += BATCH_SIZE) {
      written += await this.upsertBatch(provider, dataType, unique.slice(i, i + BATCH_SIZE));
    }
    return written;
  }

  private async upsertBatch(provider: string, dataType: string, records: WearableRecord[]): Promise<number> {
    const hashed = records.map((r) => {
      const json = JSON.stringify(r.json);
      return { ...r, text: json, hash: createHash("sha256").update(json).digest("hex") };
    });
    return this.sql.begin(async (tx) => {
      const current = await tx`
        SELECT record_id, version, content_hash FROM wearables.records
        WHERE provider = ${provider} AND data_type = ${dataType} AND is_current
          AND record_id IN ${tx(hashed.map((r) => r.recordId))}
      `;
      const existing = new Map<string, { version: number; content_hash: string }>(current.map((row: any) => [row.record_id, row]));
      const changed = hashed.filter((r) => existing.get(r.recordId)?.content_hash !== r.hash);
      if (changed.length === 0) return 0;

      const superseded = changed.filter((r) => existing.has(r.recordId)).map((r) => r.recordId);
      if (superseded.length > 0) {
        await tx`
          UPDATE wearables.records SET is_current = false
          WHERE provider = ${provider} AND data_type = ${dataType} AND is_current
            AND record_id IN ${tx(superseded)}
        `;
      }
      for (const r of changed) {
        const version = (existing.get(r.recordId)?.version ?? 0) + 1;
        await tx`
          INSERT INTO wearables.records (provider, data_type, record_id, version, json, content_hash, day, start_time, end_time)
          VALUES (${provider}, ${dataType}, ${r.recordId}, ${version}, ${r.text}::text::jsonb, ${r.hash},
                  ${r.day}, ${r.startTime}, ${r.endTime})
        `;
      }
      return changed.length;
    });
  }

  async close(): Promise<void> {
    await this.sql.close();
  }
}
