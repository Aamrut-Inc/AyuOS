import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { FhirResource, ProviderConfig } from "../types";

function nowIso(): string {
  return new Date().toISOString();
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Buffer.from(digest).toString("hex");
}

export class RawFhirStore {
  private readonly db: Database;

  constructor(private readonly config: ProviderConfig) {
    mkdirSync(dirname(config.sqlitePath), { recursive: true });
    this.db = new Database(config.sqlitePath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
  }

  init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS fhir_resources (
        source TEXT NOT NULL,
        patient_id TEXT,
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        PRIMARY KEY (source, resource_type, resource_id)
      );

      CREATE INDEX IF NOT EXISTS idx_fhir_resources_type
        ON fhir_resources(resource_type);

      CREATE INDEX IF NOT EXISTS idx_fhir_resources_patient
        ON fhir_resources(patient_id);

      CREATE TABLE IF NOT EXISTS fhir_attachments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        patient_id TEXT,
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        path TEXT NOT NULL,
        content_type TEXT NOT NULL,
        json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        content_raw BLOB,
        content_plaintext TEXT,
        fetched_at TEXT NOT NULL,
        UNIQUE (source, resource_type, resource_id, path)
      );

      CREATE INDEX IF NOT EXISTS idx_fhir_attachments_resource
        ON fhir_attachments(source, resource_type, resource_id);
    `);
  }

  async upsertResource(resource: FhirResource, patientId: string | null): Promise<void> {
    if (!resource.resourceType) {
      throw new Error("FHIR resource missing resourceType");
    }

    if (!resource.id) {
      throw new Error(`FHIR ${resource.resourceType} resource missing id`);
    }

    const json = JSON.stringify(resource);
    const contentHash = await sha256Hex(json);

    this.db
      .query(
        `
        INSERT INTO fhir_resources (
          source,
          patient_id,
          resource_type,
          resource_id,
          json,
          content_hash,
          fetched_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source, resource_type, resource_id)
        DO UPDATE SET
          patient_id = excluded.patient_id,
          json = excluded.json,
          content_hash = excluded.content_hash,
          fetched_at = excluded.fetched_at
      `
      )
      .run(
        this.config.name,
        patientId,
        resource.resourceType,
        resource.id,
        json,
        contentHash,
        nowIso()
      );
  }

  close(): void {
    this.db.close();
  }
}
