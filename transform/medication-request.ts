import type { SQL } from "bun";
import type { FhirResource } from "../shared/types";
import { bareId, codings, conceptText, fhirInstant } from "./fhir-helpers";

type Concept = { coding?: Array<{ system?: string; code?: string; display?: string }>; text?: string };

interface MedicationRequestResource extends FhirResource {
  status?: string;
  intent?: string;
  subject?: { reference?: string };
  encounter?: { reference?: string };
  authoredOn?: string;
  medicationCodeableConcept?: Concept;
  medicationReference?: { reference?: string; display?: string };
  dosageInstruction?: Array<{ text?: string; patientInstruction?: string }>;
  requester?: { reference?: string; display?: string };
  reasonCode?: Concept[];
}

export async function transformMedicationRequest(
  sql: SQL,
  fhirResourceId: number,
  source: string,
  resource: FhirResource,
  contentHash: string
): Promise<void> {
  const request = resource as MedicationRequestResource;

  const [existing] = await sql`
    SELECT content_hash FROM clinical.medication_request
    WHERE source = ${source} AND resource_id = ${resource.id}
  `;
  if (existing && existing.content_hash === contentHash) return;

  // Epic usually references a Medication resource and puts its name in
  // `display`; other servers inline a medicationCodeableConcept.
  const medicationText = conceptText(request.medicationCodeableConcept) ?? request.medicationReference?.display ?? null;
  const dosageText =
    (request.dosageInstruction || [])
      .map((d) => d.text ?? d.patientInstruction)
      .filter(Boolean)
      .join("; ") || null;
  const reasonText = (request.reasonCode || []).map(conceptText).filter((t): t is string => Boolean(t));

  await sql.begin(async (tx) => {
    const [row] = await tx`
      INSERT INTO clinical.medication_request (
        fhir_resource_id, source, resource_id, content_hash,
        status, intent, patient_id, encounter_id, authored_on,
        medication_text, medication_ref, dosage_text, requester_ref, reason_text
      ) VALUES (
        ${fhirResourceId}, ${source}, ${resource.id}, ${contentHash},
        ${request.status ?? null}, ${request.intent ?? null},
        ${bareId(request.subject?.reference)}, ${bareId(request.encounter?.reference)},
        ${fhirInstant(request.authoredOn)},
        ${medicationText}, ${request.medicationReference?.reference ?? null}, ${dosageText},
        ${request.requester?.reference ?? null}, ${sql.array(reasonText, "text")}
      )
      ON CONFLICT (source, resource_id) DO UPDATE SET
        fhir_resource_id = EXCLUDED.fhir_resource_id,
        content_hash = EXCLUDED.content_hash,
        status = EXCLUDED.status,
        intent = EXCLUDED.intent,
        patient_id = EXCLUDED.patient_id,
        encounter_id = EXCLUDED.encounter_id,
        authored_on = EXCLUDED.authored_on,
        medication_text = EXCLUDED.medication_text,
        medication_ref = EXCLUDED.medication_ref,
        dosage_text = EXCLUDED.dosage_text,
        requester_ref = EXCLUDED.requester_ref,
        reason_text = EXCLUDED.reason_text,
        transformed_at = now()
      RETURNING id
    `;

    await tx`DELETE FROM clinical.medication_request_coding WHERE medication_request_id = ${row.id}`;
    for (const coding of codings(request.medicationCodeableConcept)) {
      if (!coding.code) continue;
      await tx`
        INSERT INTO clinical.medication_request_coding (medication_request_id, system, code, display)
        VALUES (${row.id}, ${coding.system ?? null}, ${coding.code}, ${coding.display ?? null})
      `;
    }
  });
}
