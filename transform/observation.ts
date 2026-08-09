import type { SQL } from "bun";
import type { FhirResource } from "../shared/types";
import { bareId, categoryCodes, codings, rawRefs } from "./fhir-helpers";

interface ObservationResource extends FhirResource {
  status?: string;
  subject?: { reference?: string };
  encounter?: { reference?: string };
  performer?: Array<{ reference?: string }>;
  hasMember?: Array<{ reference?: string }>;
  derivedFrom?: Array<{ reference?: string }>;
  category?: Array<{ coding?: Array<{ code?: string }> }>;
  code?: { coding?: Array<{ system?: string; code?: string; display?: string }> };
  effectiveDateTime?: string;
  valueCodeableConcept?: {
    text?: string;
    coding?: Array<{ system?: string; code?: string }>;
  };
  valueQuantity?: { value?: number; unit?: string; code?: string };
}

export async function transformObservation(
  sql: SQL,
  fhirResourceId: number,
  source: string,
  resource: FhirResource,
  contentHash: string
): Promise<void> {
  const obs = resource as ObservationResource;

  const [existing] = await sql`
    SELECT content_hash FROM clinical.observation
    WHERE source = ${source} AND resource_id = ${resource.id}
  `;
  if (existing && existing.content_hash === contentHash) return;

  const valueCoding = obs.valueCodeableConcept?.coding?.[0];

  await sql.begin(async (tx) => {
    const [row] = await tx`
      INSERT INTO clinical.observation (
        fhir_resource_id, source, resource_id, content_hash,
        status, patient_id, encounter_id,
        performer_refs, has_member_refs, derived_from_refs,
        category_codes,
        value_text, value_code, value_code_system,
        value_quantity_value, value_quantity_unit, value_quantity_code,
        effective_datetime
      ) VALUES (
        ${fhirResourceId}, ${source}, ${resource.id}, ${contentHash},
        ${obs.status ?? null}, ${bareId(obs.subject?.reference)}, ${bareId(obs.encounter?.reference)},
        ${sql.array(rawRefs(obs.performer), "text")}, ${sql.array(rawRefs(obs.hasMember), "text")}, ${sql.array(rawRefs(obs.derivedFrom), "text")},
        ${sql.array(categoryCodes(obs.category), "text")},
        ${obs.valueCodeableConcept?.text ?? null}, ${valueCoding?.code ?? null}, ${valueCoding?.system ?? null},
        ${obs.valueQuantity?.value ?? null}, ${obs.valueQuantity?.unit ?? null}, ${obs.valueQuantity?.code ?? null},
        ${obs.effectiveDateTime ?? null}
      )
      ON CONFLICT (source, resource_id) DO UPDATE SET
        fhir_resource_id = EXCLUDED.fhir_resource_id,
        content_hash = EXCLUDED.content_hash,
        status = EXCLUDED.status,
        patient_id = EXCLUDED.patient_id,
        encounter_id = EXCLUDED.encounter_id,
        performer_refs = EXCLUDED.performer_refs,
        has_member_refs = EXCLUDED.has_member_refs,
        derived_from_refs = EXCLUDED.derived_from_refs,
        category_codes = EXCLUDED.category_codes,
        value_text = EXCLUDED.value_text,
        value_code = EXCLUDED.value_code,
        value_code_system = EXCLUDED.value_code_system,
        value_quantity_value = EXCLUDED.value_quantity_value,
        value_quantity_unit = EXCLUDED.value_quantity_unit,
        value_quantity_code = EXCLUDED.value_quantity_code,
        effective_datetime = EXCLUDED.effective_datetime,
        transformed_at = now()
      RETURNING id
    `;

    await tx`DELETE FROM clinical.observation_code_coding WHERE observation_id = ${row.id}`;
    for (const coding of codings(obs.code)) {
      if (!coding.code) continue;
      await tx`
        INSERT INTO clinical.observation_code_coding (observation_id, system, code, display)
        VALUES (${row.id}, ${coding.system ?? null}, ${coding.code}, ${coding.display ?? null})
      `;
    }
  });
}
