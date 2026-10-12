import { SQL } from "bun";
import type { PostgresConfig } from "./config";
import type { Hospital } from "../extract/ehr/config";

export interface EhrConnection extends Hospital {
  displayName: string;
  createdAt: string;
  lastImportAt: string | null;
  lastImportStatus: string | null;
  lastImportError: string | null;
}

// Short, stable name for a health system, used as `source` on its records.
export function slugFor(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "hospital"
  );
}

export class EhrConnectionStore {
  private readonly sql: SQL;

  constructor(config: PostgresConfig) {
    this.sql = new SQL(config.connectionString);
  }

  async list(): Promise<EhrConnection[]> {
    const rows = await this.sql`
      SELECT c.*, r.started_at AS last_import_at, r.status AS last_import_status, r.error AS last_import_error
      FROM ops.ehr_connections c
      LEFT JOIN LATERAL (
        SELECT started_at, status, error FROM ops.sync_runs
        WHERE job = 'ehr-import:' || c.slug ORDER BY started_at DESC LIMIT 1
      ) r ON true
      ORDER BY c.created_at
    `;
    return rows.map((r: any) => ({
      slug: r.slug,
      displayName: r.display_name,
      fhirBaseUrl: r.fhir_base_url,
      sandbox: r.sandbox,
      createdAt: new Date(r.created_at).toISOString(),
      lastImportAt: r.last_import_at ? new Date(r.last_import_at).toISOString() : null,
      lastImportStatus: r.last_import_status,
      lastImportError: r.last_import_error
    }));
  }

  async get(slug: string): Promise<EhrConnection | null> {
    return (await this.list()).find((c) => c.slug === slug) ?? null;
  }

  // Adds a hospital (or returns the existing one for the same address).
  async add(displayName: string, fhirBaseUrl: string, sandbox: boolean, slug = slugFor(displayName)): Promise<string> {
    const url = fhirBaseUrl.replace(/\/+$/, "");
    const [existing] = await this.sql`SELECT slug FROM ops.ehr_connections WHERE fhir_base_url = ${url}`;
    if (existing) return existing.slug;

    let unique = slug;
    for (let n = 2; (await this.sql`SELECT 1 FROM ops.ehr_connections WHERE slug = ${unique}`).length > 0; n++) {
      unique = `${slug}_${n}`;
    }
    await this.sql`
      INSERT INTO ops.ehr_connections (slug, display_name, fhir_base_url, sandbox)
      VALUES (${unique}, ${displayName}, ${url}, ${sandbox})
    `;
    return unique;
  }

  async remove(slug: string): Promise<void> {
    await this.sql`DELETE FROM ops.ehr_connections WHERE slug = ${slug}`;
  }

  async close(): Promise<void> {
    await this.sql.close();
  }
}
