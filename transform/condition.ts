import type { SQL } from "bun";
import type { FhirResource } from "../shared/types";
import { bareId, categoryCodes, codings, conceptText, fhirInstant } from "./fhir-helpers";

type Concept = { coding?: Array<{ system?: string; code?: string; display?: string }>; text?: string };

interface ConditionResource extends FhirResource {
  clinicalStatus?: Concept;
  verificationStatus?: Concept;
  category?: Concept[];
  code?: Concept;
  subject?: { reference?: string };
  encounter?: { reference?: string };
  onsetDateTime?: string;
  onsetString?: string;
  onsetPeriod?: { start?: string };
  abatementDateTime?: string;
  abatementString?: string;
  abatementPeriod?: { start?: string };
  recordedDate?: string;
}

export async function transformCondition(
  sql: SQL,
  fhirResourceId: number,
  source: string,
  resource: FhirResource,
  contentHash: string
): Promise<void> {
  const condition = resource as ConditionResource;

  const [existing] = await sql`
    SELECT content_hash FROM clinical.condition
    WHERE source = ${source} AND resource_id = ${resource.id}
  `;
  if (existing && existing.content_hash === contentHash) return;

  const onsetText = condition.onsetDateTime ?? condition.onsetPeriod?.start ?? condition.onsetString ?? null;
  const abatementText =
    condition.abatementDateTime ?? condition.abatementPeriod?.start ?? condition.abatementString ?? null;

  await sql.begin(async (tx) => {
    const [row] = await tx`
      INSERT INTO clinical.condition (
        fhir_resource_id, source, resource_id, content_hash,
        clinical_status, verification_status, category_codes, patient_id, encounter_id, code_text,
        onset_datetime, onset_text, abatement_datetime, abatement_text, recorded_date
      ) VALUES (
        ${fhirResourceId}, ${source}, ${resource.id}, ${contentHash},
        ${codings(condition.clinicalStatus)[0]?.code ?? null},
        ${codings(condition.verificationStatus)[0]?.code ?? null},
        ${sql.array(categoryCodes(condition.category), "text")},
        ${bareId(condition.subject?.reference)}, ${bareId(condition.encounter?.reference)},
        ${conceptText(condition.code)},
        ${fhirInstant(onsetText)}, ${onsetText}, ${fhirInstant(abatementText)}, ${abatementText},
        ${fhirInstant(condition.recordedDate)}
      )
      ON CONFLICT (source, resource_id) DO UPDATE SET
        fhir_resource_id = EXCLUDED.fhir_resource_id,
        content_hash = EXCLUDED.content_hash,
        clinical_status = EXCLUDED.clinical_status,
        verification_status = EXCLUDED.verification_status,
        category_codes = EXCLUDED.category_codes,
        patient_id = EXCLUDED.patient_id,
        encounter_id = EXCLUDED.encounter_id,
        code_text = EXCLUDED.code_text,
        onset_datetime = EXCLUDED.onset_datetime,
        onset_text = EXCLUDED.onset_text,
        abatement_datetime = EXCLUDED.abatement_datetime,
        abatement_text = EXCLUDED.abatement_text,
        recorded_date = EXCLUDED.recorded_date,
        transformed_at = now()
      RETURNING id
    `;

    await tx`DELETE FROM clinical.condition_coding WHERE condition_id = ${row.id}`;
    for (const coding of codings(condition.code)) {
      if (!coding.code) continue;
      await tx`
        INSERT INTO clinical.condition_coding (condition_id, system, code, display)
        VALUES (${row.id}, ${coding.system ?? null}, ${coding.code}, ${coding.display ?? null})
      `;
    }
  });
}
