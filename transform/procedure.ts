import type { SQL } from "bun";
import type { FhirResource } from "../shared/types";
import { bareId, bareIds, codings, rawRefs } from "./fhir-helpers";

interface ProcedureResource extends FhirResource {
  status?: string;
  subject?: { reference?: string };
  category?: { coding?: Array<{ system?: string; code?: string; display?: string }> };
  code?: { coding?: Array<{ system?: string; code?: string; display?: string }> };
  reasonCode?: Array<{ coding?: Array<{ system?: string; code?: string; display?: string }> }>;
  performedDateTime?: string;
  report?: Array<{ reference?: string }>;
  performer?: Array<{ actor?: { reference?: string } }>;
}

export async function transformProcedure(
  sql: SQL,
  fhirResourceId: number,
  source: string,
  resource: FhirResource,
  contentHash: string
): Promise<void> {
  const proc = resource as ProcedureResource;

  const [existing] = await sql`
    SELECT content_hash FROM clinical.procedure
    WHERE source = ${source} AND resource_id = ${resource.id}
  `;
  if (existing && existing.content_hash === contentHash) return;

  const categoryCoding = proc.category?.coding?.[0];
  const performerRefs = rawRefs((proc.performer || []).map((p) => ({ reference: p.actor?.reference })));

  await sql.begin(async (tx) => {
    const [row] = await tx`
      INSERT INTO clinical.procedure (
        fhir_resource_id, source, resource_id, content_hash,
        status, patient_id,
        category_code, category_system, category_display,
        performed_datetime, report_diagnostic_report_ids, performer_refs
      ) VALUES (
        ${fhirResourceId}, ${source}, ${resource.id}, ${contentHash},
        ${proc.status ?? null}, ${bareId(proc.subject?.reference)},
        ${categoryCoding?.code ?? null}, ${categoryCoding?.system ?? null}, ${categoryCoding?.display ?? null},
        ${proc.performedDateTime ?? null}, ${sql.array(bareIds(proc.report), "text")}, ${sql.array(performerRefs, "text")}
      )
      ON CONFLICT (source, resource_id) DO UPDATE SET
        fhir_resource_id = EXCLUDED.fhir_resource_id,
        content_hash = EXCLUDED.content_hash,
        status = EXCLUDED.status,
        patient_id = EXCLUDED.patient_id,
        category_code = EXCLUDED.category_code,
        category_system = EXCLUDED.category_system,
        category_display = EXCLUDED.category_display,
        performed_datetime = EXCLUDED.performed_datetime,
        report_diagnostic_report_ids = EXCLUDED.report_diagnostic_report_ids,
        performer_refs = EXCLUDED.performer_refs,
        transformed_at = now()
      RETURNING id
    `;

    await tx`DELETE FROM clinical.procedure_coding WHERE procedure_id = ${row.id}`;
    for (const coding of codings(proc.code)) {
      if (!coding.code) continue;
      await tx`
        INSERT INTO clinical.procedure_coding (procedure_id, field, system, code, display)
        VALUES (${row.id}, 'code', ${coding.system ?? null}, ${coding.code}, ${coding.display ?? null})
      `;
    }
    for (const concept of proc.reasonCode || []) {
      for (const coding of concept.coding || []) {
        if (!coding.code) continue;
        await tx`
          INSERT INTO clinical.procedure_coding (procedure_id, field, system, code, display)
          VALUES (${row.id}, 'reason_code', ${coding.system ?? null}, ${coding.code}, ${coding.display ?? null})
        `;
      }
    }
  });
}
