import type { SQL } from "bun";
import type { FhirResource } from "../shared/types";
import { bareId, conceptText, fhirInstant, rawRefs } from "./fhir-helpers";

type Concept = { coding?: Array<{ system?: string; code?: string; display?: string }>; text?: string };

interface EncounterResource extends FhirResource {
  status?: string;
  class?: { system?: string; code?: string; display?: string };
  type?: Concept[];
  subject?: { reference?: string };
  period?: { start?: string; end?: string };
  serviceProvider?: { reference?: string; display?: string };
  location?: Array<{ location?: { reference?: string; display?: string } }>;
  participant?: Array<{ individual?: { reference?: string } }>;
  reasonCode?: Concept[];
}

export async function transformEncounter(
  sql: SQL,
  fhirResourceId: number,
  source: string,
  resource: FhirResource,
  contentHash: string
): Promise<void> {
  const encounter = resource as EncounterResource;

  const [existing] = await sql`
    SELECT content_hash FROM clinical.encounter
    WHERE source = ${source} AND resource_id = ${resource.id}
  `;
  if (existing && existing.content_hash === contentHash) return;

  const typeText = (encounter.type || []).map(conceptText).filter((t): t is string => Boolean(t));
  const locationNames = (encounter.location || [])
    .map((l) => l.location?.display)
    .filter((t): t is string => Boolean(t));
  const participantRefs = rawRefs((encounter.participant || []).map((p) => ({ reference: p.individual?.reference })));
  const reasonText = (encounter.reasonCode || []).map(conceptText).filter((t): t is string => Boolean(t));

  await sql.begin(async (tx) => {
    const [row] = await tx`
      INSERT INTO clinical.encounter (
        fhir_resource_id, source, resource_id, content_hash,
        status, class_code, class_display, type_text, patient_id, period_start, period_end,
        service_provider_ref, service_provider_name, location_names, participant_refs, reason_text
      ) VALUES (
        ${fhirResourceId}, ${source}, ${resource.id}, ${contentHash},
        ${encounter.status ?? null}, ${encounter.class?.code ?? null}, ${encounter.class?.display ?? null},
        ${sql.array(typeText, "text")}, ${bareId(encounter.subject?.reference)},
        ${fhirInstant(encounter.period?.start)}, ${fhirInstant(encounter.period?.end)},
        ${encounter.serviceProvider?.reference ?? null}, ${encounter.serviceProvider?.display ?? null},
        ${sql.array(locationNames, "text")}, ${sql.array(participantRefs, "text")}, ${sql.array(reasonText, "text")}
      )
      ON CONFLICT (source, resource_id) DO UPDATE SET
        fhir_resource_id = EXCLUDED.fhir_resource_id,
        content_hash = EXCLUDED.content_hash,
        status = EXCLUDED.status,
        class_code = EXCLUDED.class_code,
        class_display = EXCLUDED.class_display,
        type_text = EXCLUDED.type_text,
        patient_id = EXCLUDED.patient_id,
        period_start = EXCLUDED.period_start,
        period_end = EXCLUDED.period_end,
        service_provider_ref = EXCLUDED.service_provider_ref,
        service_provider_name = EXCLUDED.service_provider_name,
        location_names = EXCLUDED.location_names,
        participant_refs = EXCLUDED.participant_refs,
        reason_text = EXCLUDED.reason_text,
        transformed_at = now()
      RETURNING id
    `;

    await tx`DELETE FROM clinical.encounter_type_coding WHERE encounter_id = ${row.id}`;
    for (const coding of (encounter.type || []).flatMap((t) => t.coding || [])) {
      if (!coding.code) continue;
      await tx`
        INSERT INTO clinical.encounter_type_coding (encounter_id, system, code, display)
        VALUES (${row.id}, ${coding.system ?? null}, ${coding.code}, ${coding.display ?? null})
      `;
    }
  });
}
