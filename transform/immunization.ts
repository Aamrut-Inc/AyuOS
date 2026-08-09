import type { SQL } from "bun";
import type { FhirResource } from "../shared/types";
import { bareId, codings, rawRefs } from "./fhir-helpers";

interface ImmunizationResource extends FhirResource {
  status?: string;
  patient?: { reference?: string };
  occurrenceDateTime?: string;
  doseQuantity?: { value?: number; unit?: string };
  site?: { coding?: Array<{ system?: string; code?: string; display?: string }> };
  route?: { coding?: Array<{ system?: string; code?: string; display?: string }> };
  lotNumber?: string;
  manufacturer?: { display?: string };
  vaccineCode?: { coding?: Array<{ system?: string; code?: string; display?: string }> };
  performer?: Array<{ actor?: { reference?: string } }>;
}

export async function transformImmunization(
  sql: SQL,
  fhirResourceId: number,
  source: string,
  resource: FhirResource,
  contentHash: string
): Promise<void> {
  const imm = resource as ImmunizationResource;

  const [existing] = await sql`
    SELECT content_hash FROM clinical.immunization
    WHERE source = ${source} AND resource_id = ${resource.id}
  `;
  if (existing && existing.content_hash === contentHash) return;

  const siteCoding = imm.site?.coding?.[0];
  const routeCoding = imm.route?.coding?.[0];
  const performerRefs = rawRefs((imm.performer || []).map((p) => ({ reference: p.actor?.reference })));

  await sql.begin(async (tx) => {
    const [row] = await tx`
      INSERT INTO clinical.immunization (
        fhir_resource_id, source, resource_id, content_hash,
        status, patient_id, occurrence_datetime,
        dose_quantity_value, dose_quantity_unit,
        site_code, site_system, site_display,
        route_code, route_system, route_display,
        lot_number, manufacturer_display, performer_refs
      ) VALUES (
        ${fhirResourceId}, ${source}, ${resource.id}, ${contentHash},
        ${imm.status ?? null}, ${bareId(imm.patient?.reference)}, ${imm.occurrenceDateTime ?? null},
        ${imm.doseQuantity?.value ?? null}, ${imm.doseQuantity?.unit ?? null},
        ${siteCoding?.code ?? null}, ${siteCoding?.system ?? null}, ${siteCoding?.display ?? null},
        ${routeCoding?.code ?? null}, ${routeCoding?.system ?? null}, ${routeCoding?.display ?? null},
        ${imm.lotNumber ?? null}, ${imm.manufacturer?.display ?? null}, ${sql.array(performerRefs, "text")}
      )
      ON CONFLICT (source, resource_id) DO UPDATE SET
        fhir_resource_id = EXCLUDED.fhir_resource_id,
        content_hash = EXCLUDED.content_hash,
        status = EXCLUDED.status,
        patient_id = EXCLUDED.patient_id,
        occurrence_datetime = EXCLUDED.occurrence_datetime,
        dose_quantity_value = EXCLUDED.dose_quantity_value,
        dose_quantity_unit = EXCLUDED.dose_quantity_unit,
        site_code = EXCLUDED.site_code,
        site_system = EXCLUDED.site_system,
        site_display = EXCLUDED.site_display,
        route_code = EXCLUDED.route_code,
        route_system = EXCLUDED.route_system,
        route_display = EXCLUDED.route_display,
        lot_number = EXCLUDED.lot_number,
        manufacturer_display = EXCLUDED.manufacturer_display,
        performer_refs = EXCLUDED.performer_refs,
        transformed_at = now()
      RETURNING id
    `;

    await tx`DELETE FROM clinical.immunization_vaccine_coding WHERE immunization_id = ${row.id}`;
    for (const coding of codings(imm.vaccineCode)) {
      if (!coding.code) continue;
      await tx`
        INSERT INTO clinical.immunization_vaccine_coding (immunization_id, system, code, display)
        VALUES (${row.id}, ${coding.system ?? null}, ${coding.code}, ${coding.display ?? null})
      `;
    }
  });
}
