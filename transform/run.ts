import { SQL } from "bun";
import type { FhirResource } from "../shared/types";
import { loadPostgresConfig, type PostgresConfig } from "../load/config";
import { transformPatient } from "./patient";
import { transformObservation } from "./observation";
import { transformImmunization } from "./immunization";
import { transformDiagnosticReport } from "./diagnostic-report";
import { transformDocumentReference } from "./document-reference";
import { transformProcedure } from "./procedure";

type Mapper = (
  sql: SQL,
  fhirResourceId: number,
  source: string,
  resource: FhirResource,
  contentHash: string
) => Promise<void>;

const mappers: Record<string, Mapper> = {
  Patient: transformPatient,
  Observation: transformObservation,
  Immunization: transformImmunization,
  DiagnosticReport: transformDiagnosticReport,
  DocumentReference: transformDocumentReference,
  Procedure: transformProcedure
};

export async function runTransform(
  postgresConfig: PostgresConfig
): Promise<Record<string, number>> {
  const sql = new SQL(postgresConfig.connectionString);
  const countsByType: Record<string, number> = {};

  try {
    for (const [resourceType, mapper] of Object.entries(mappers)) {
      const rows = await sql`
        SELECT id, source, resource_id, content_hash, json
        FROM clinical.fhir_resources
        WHERE resource_type = ${resourceType} AND is_current
      `;

      let count = 0;
      for (const row of rows) {
        const resource: FhirResource =
          typeof row.json === "string" ? JSON.parse(row.json) : row.json;
        await mapper(sql, row.id, row.source, resource, row.content_hash);
        count += 1;
      }

      countsByType[resourceType] = count;
    }
  } finally {
    await sql.close();
  }

  return countsByType;
}

async function main(): Promise<void> {
  const countsByType = await runTransform(loadPostgresConfig());
  for (const [resourceType, count] of Object.entries(countsByType)) {
    console.log(`${resourceType}: ${count} resource(s) processed`);
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
