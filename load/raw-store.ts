import { SQL } from "bun";
import type { FhirResource } from "../shared/types";
import type { PostgresConfig } from "./config";

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Buffer.from(digest).toString("hex");
}

export class RawFhirStore {
  private readonly sql: SQL;

  constructor(config: PostgresConfig) {
    this.sql = new SQL(config.connectionString);
  }

  async upsertResource(
    resource: FhirResource,
    patientId: string | null,
    source: string
  ): Promise<void> {
    if (!resource.resourceType) {
      throw new Error("FHIR resource missing resourceType");
    }

    if (!resource.id) {
      throw new Error(`FHIR ${resource.resourceType} resource missing id`);
    }

    const json = JSON.stringify(resource);
    const contentHash = await sha256Hex(json);

    await this.sql.begin(async (tx) => {
      const [current] = await tx`
        SELECT id, version, content_hash
        FROM clinical.fhir_resources
        WHERE source = ${source}
          AND resource_type = ${resource.resourceType}
          AND resource_id = ${resource.id}
          AND is_current
        FOR UPDATE
      `;

      if (current && current.content_hash === contentHash) {
        return;
      }

      if (current) {
        await tx`
          UPDATE clinical.fhir_resources
          SET is_current = false
          WHERE id = ${current.id}
        `;
      }

      const nextVersion = current ? current.version + 1 : 1;

      await tx`
        INSERT INTO clinical.fhir_resources (
          source,
          patient_id,
          resource_type,
          resource_id,
          version,
          is_current,
          json,
          content_hash
        )
        VALUES (
          ${source},
          ${patientId},
          ${resource.resourceType},
          ${resource.id},
          ${nextVersion},
          true,
          ${json}::jsonb,
          ${contentHash}
        )
      `;
    });
  }

  async close(): Promise<void> {
    await this.sql.close();
  }
}
