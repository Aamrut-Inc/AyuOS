import type { SQL } from "bun";
import type { FhirResource } from "../shared/types";
import { bareId, codings, conceptText, fhirInstant } from "./fhir-helpers";

type Concept = { coding?: Array<{ system?: string; code?: string; display?: string }>; text?: string };

interface AllergyIntoleranceResource extends FhirResource {
  clinicalStatus?: Concept;
  verificationStatus?: Concept;
  type?: string;
  category?: string[];
  criticality?: string;
  code?: Concept;
  patient?: { reference?: string };
  onsetDateTime?: string;
  onsetString?: string;
  recordedDate?: string;
  reaction?: Array<{ manifestation?: Concept[]; severity?: string }>;
}

export async function transformAllergyIntolerance(
  sql: SQL,
  fhirResourceId: number,
  source: string,
  resource: FhirResource,
  contentHash: string
): Promise<void> {
  const allergy = resource as AllergyIntoleranceResource;

  const [existing] = await sql`
    SELECT content_hash FROM clinical.allergy_intolerance
    WHERE source = ${source} AND resource_id = ${resource.id}
  `;
  if (existing && existing.content_hash === contentHash) return;

  const reactions = (allergy.reaction || [])
    .flatMap((r) => (r.manifestation || []).map(conceptText))
    .filter((t): t is string => Boolean(t));
  const severities = (allergy.reaction || []).map((r) => r.severity).filter((s): s is string => Boolean(s));
  const onsetText = allergy.onsetDateTime ?? allergy.onsetString ?? null;

  await sql.begin(async (tx) => {
    const [row] = await tx`
      INSERT INTO clinical.allergy_intolerance (
        fhir_resource_id, source, resource_id, content_hash,
        clinical_status, verification_status, type, categories, criticality, patient_id,
        substance_text, onset_datetime, onset_text, recorded_date, reactions, reaction_severities
      ) VALUES (
        ${fhirResourceId}, ${source}, ${resource.id}, ${contentHash},
        ${codings(allergy.clinicalStatus)[0]?.code ?? null},
        ${codings(allergy.verificationStatus)[0]?.code ?? null},
        ${allergy.type ?? null}, ${sql.array(allergy.category ?? [], "text")}, ${allergy.criticality ?? null},
        ${bareId(allergy.patient?.reference)},
        ${conceptText(allergy.code)}, ${fhirInstant(onsetText)}, ${onsetText}, ${fhirInstant(allergy.recordedDate)},
        ${sql.array(reactions, "text")}, ${sql.array(severities, "text")}
      )
      ON CONFLICT (source, resource_id) DO UPDATE SET
        fhir_resource_id = EXCLUDED.fhir_resource_id,
        content_hash = EXCLUDED.content_hash,
        clinical_status = EXCLUDED.clinical_status,
        verification_status = EXCLUDED.verification_status,
        type = EXCLUDED.type,
        categories = EXCLUDED.categories,
        criticality = EXCLUDED.criticality,
        patient_id = EXCLUDED.patient_id,
        substance_text = EXCLUDED.substance_text,
        onset_datetime = EXCLUDED.onset_datetime,
        onset_text = EXCLUDED.onset_text,
        recorded_date = EXCLUDED.recorded_date,
        reactions = EXCLUDED.reactions,
        reaction_severities = EXCLUDED.reaction_severities,
        transformed_at = now()
      RETURNING id
    `;

    await tx`DELETE FROM clinical.allergy_intolerance_coding WHERE allergy_intolerance_id = ${row.id}`;
    for (const coding of codings(allergy.code)) {
      if (!coding.code) continue;
      await tx`
        INSERT INTO clinical.allergy_intolerance_coding (allergy_intolerance_id, system, code, display)
        VALUES (${row.id}, ${coding.system ?? null}, ${coding.code}, ${coding.display ?? null})
      `;
    }
  });
}
