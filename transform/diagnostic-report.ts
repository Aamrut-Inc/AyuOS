import type { SQL } from "bun";
import type { FhirResource } from "../shared/types";
import { bareId, bareIds, categoryCodes, codings } from "./fhir-helpers";

interface DiagnosticReportResource extends FhirResource {
  status?: string;
  subject?: { reference?: string };
  encounter?: { reference?: string };
  category?: Array<{ coding?: Array<{ code?: string }> }>;
  code?: { coding?: Array<{ system?: string; code?: string; display?: string }> };
  conclusionCode?: Array<{ coding?: Array<{ system?: string; code?: string; display?: string }> }>;
  effectiveDateTime?: string;
  issued?: string;
  conclusion?: string;
  result?: Array<{ reference?: string }>;
  presentedForm?: Array<{ contentType?: string; url?: string; title?: string }>;
}

export async function transformDiagnosticReport(
  sql: SQL,
  fhirResourceId: number,
  source: string,
  resource: FhirResource,
  contentHash: string
): Promise<void> {
  const report = resource as DiagnosticReportResource;

  const [existing] = await sql`
    SELECT content_hash FROM clinical.diagnostic_report
    WHERE source = ${source} AND resource_id = ${resource.id}
  `;
  if (existing && existing.content_hash === contentHash) return;

  await sql.begin(async (tx) => {
    const [row] = await tx`
      INSERT INTO clinical.diagnostic_report (
        fhir_resource_id, source, resource_id, content_hash,
        status, patient_id, encounter_id, category_codes,
        effective_datetime, issued, conclusion_text, result_observation_ids
      ) VALUES (
        ${fhirResourceId}, ${source}, ${resource.id}, ${contentHash},
        ${report.status ?? null}, ${bareId(report.subject?.reference)}, ${bareId(report.encounter?.reference)},
        ${sql.array(categoryCodes(report.category), "text")},
        ${report.effectiveDateTime ?? null}, ${report.issued ?? null}, ${report.conclusion ?? null},
        ${sql.array(bareIds(report.result), "text")}
      )
      ON CONFLICT (source, resource_id) DO UPDATE SET
        fhir_resource_id = EXCLUDED.fhir_resource_id,
        content_hash = EXCLUDED.content_hash,
        status = EXCLUDED.status,
        patient_id = EXCLUDED.patient_id,
        encounter_id = EXCLUDED.encounter_id,
        category_codes = EXCLUDED.category_codes,
        effective_datetime = EXCLUDED.effective_datetime,
        issued = EXCLUDED.issued,
        conclusion_text = EXCLUDED.conclusion_text,
        result_observation_ids = EXCLUDED.result_observation_ids,
        transformed_at = now()
      RETURNING id
    `;

    await tx`DELETE FROM clinical.diagnostic_report_coding WHERE diagnostic_report_id = ${row.id}`;
    for (const coding of codings(report.code)) {
      if (!coding.code) continue;
      await tx`
        INSERT INTO clinical.diagnostic_report_coding (diagnostic_report_id, field, system, code, display)
        VALUES (${row.id}, 'code', ${coding.system ?? null}, ${coding.code}, ${coding.display ?? null})
      `;
    }
    for (const concept of report.conclusionCode || []) {
      for (const coding of concept.coding || []) {
        if (!coding.code) continue;
        await tx`
          INSERT INTO clinical.diagnostic_report_coding (diagnostic_report_id, field, system, code, display)
          VALUES (${row.id}, 'conclusion_code', ${coding.system ?? null}, ${coding.code}, ${coding.display ?? null})
        `;
      }
    }

    await tx`DELETE FROM clinical.diagnostic_report_presented_form WHERE diagnostic_report_id = ${row.id}`;
    for (const form of report.presentedForm || []) {
      await tx`
        INSERT INTO clinical.diagnostic_report_presented_form (diagnostic_report_id, content_type, url, title)
        VALUES (${row.id}, ${form.contentType ?? null}, ${form.url ?? null}, ${form.title ?? null})
      `;
    }
  });
}
