import type { SQL } from "bun";
import type { FhirResource } from "../shared/types";

interface PatientResource extends FhirResource {
  name?: Array<{ use?: string; family?: string; given?: string[] }>;
  gender?: string;
  birthDate?: string;
  address?: Array<{
    line?: string[];
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
  }>;
  telecom?: Array<{ system?: string; value?: string }>;
  maritalStatus?: { coding?: Array<{ code?: string; display?: string }>; text?: string };
  communication?: Array<{
    language?: { coding?: Array<{ code?: string }> };
    preferred?: boolean;
  }>;
  identifier?: Array<{ system?: string; value?: string }>;
}

export async function transformPatient(
  sql: SQL,
  fhirResourceId: number,
  source: string,
  resource: FhirResource,
  contentHash: string
): Promise<void> {
  const patient = resource as PatientResource;

  const [existing] = await sql`
    SELECT content_hash FROM clinical.patient
    WHERE source = ${source} AND resource_id = ${resource.id}
  `;
  if (existing && existing.content_hash === contentHash) return;

  const officialName = patient.name?.find((n) => n.use === "official") || patient.name?.[0];
  const address = patient.address?.[0];
  const phone = (patient.telecom || [])
    .filter((t) => t.system === "phone")
    .map((t) => t.value)
    .filter((v): v is string => Boolean(v));
  const email = (patient.telecom || [])
    .filter((t) => t.system === "email")
    .map((t) => t.value)
    .filter((v): v is string => Boolean(v));
  const maritalCoding = patient.maritalStatus?.coding?.[0];
  const preferredLanguage =
    patient.communication?.find((c) => c.preferred)?.language?.coding?.[0]?.code ??
    patient.communication?.[0]?.language?.coding?.[0]?.code ??
    null;

  await sql.begin(async (tx) => {
    const [row] = await tx`
      INSERT INTO clinical.patient (
        fhir_resource_id, source, resource_id, content_hash,
        family_name, given_names, gender, birth_date,
        address_line, address_city, address_state, address_postal_code, address_country,
        phone, email, marital_status_code, marital_status_display, language
      ) VALUES (
        ${fhirResourceId}, ${source}, ${resource.id}, ${contentHash},
        ${officialName?.family ?? null}, ${sql.array(officialName?.given ?? [], "text")},
        ${patient.gender ?? null}, ${patient.birthDate ?? null},
        ${address?.line?.join(", ") ?? null}, ${address?.city ?? null},
        ${address?.state ?? null}, ${address?.postalCode ?? null}, ${address?.country ?? null},
        ${sql.array(phone, "text")}, ${sql.array(email, "text")},
        ${maritalCoding?.code ?? null}, ${maritalCoding?.display ?? patient.maritalStatus?.text ?? null},
        ${preferredLanguage}
      )
      ON CONFLICT (source, resource_id) DO UPDATE SET
        fhir_resource_id = EXCLUDED.fhir_resource_id,
        content_hash = EXCLUDED.content_hash,
        family_name = EXCLUDED.family_name,
        given_names = EXCLUDED.given_names,
        gender = EXCLUDED.gender,
        birth_date = EXCLUDED.birth_date,
        address_line = EXCLUDED.address_line,
        address_city = EXCLUDED.address_city,
        address_state = EXCLUDED.address_state,
        address_postal_code = EXCLUDED.address_postal_code,
        address_country = EXCLUDED.address_country,
        phone = EXCLUDED.phone,
        email = EXCLUDED.email,
        marital_status_code = EXCLUDED.marital_status_code,
        marital_status_display = EXCLUDED.marital_status_display,
        language = EXCLUDED.language,
        transformed_at = now()
      RETURNING id
    `;

    await tx`DELETE FROM clinical.patient_identifier WHERE patient_id = ${row.id}`;
    for (const identifier of patient.identifier || []) {
      if (!identifier.value) continue;
      await tx`
        INSERT INTO clinical.patient_identifier (patient_id, system, value)
        VALUES (${row.id}, ${identifier.system ?? null}, ${identifier.value})
      `;
    }
  });
}
