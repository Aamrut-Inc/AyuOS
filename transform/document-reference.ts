import type { SQL } from "bun";
import type { FhirResource } from "../shared/types";
import { bareId, categoryCodes, codings, rawRefs } from "./fhir-helpers";

interface DocumentReferenceResource extends FhirResource {
  status?: string;
  subject?: { reference?: string };
  category?: Array<{ coding?: Array<{ code?: string }> }>;
  type?: { coding?: Array<{ system?: string; code?: string; display?: string }> };
  date?: string;
  author?: Array<{ reference?: string }>;
  content?: Array<{ attachment?: { contentType?: string; url?: string; title?: string } }>;
  context?: {
    encounter?: Array<{ reference?: string }>;
    period?: { start?: string; end?: string };
  };
}

export async function transformDocumentReference(
  sql: SQL,
  fhirResourceId: number,
  source: string,
  resource: FhirResource,
  contentHash: string
): Promise<void> {
  const doc = resource as DocumentReferenceResource;

  const [existing] = await sql`
    SELECT content_hash FROM clinical.document_reference
    WHERE source = ${source} AND resource_id = ${resource.id}
  `;
  if (existing && existing.content_hash === contentHash) return;

  const encounterIds = (doc.context?.encounter || [])
    .map((e) => bareId(e.reference))
    .filter((id): id is string => id !== null);

  await sql.begin(async (tx) => {
    const [row] = await tx`
      INSERT INTO clinical.document_reference (
        fhir_resource_id, source, resource_id, content_hash,
        status, patient_id, category_codes,
        date, author_refs, encounter_ids,
        context_period_start, context_period_end
      ) VALUES (
        ${fhirResourceId}, ${source}, ${resource.id}, ${contentHash},
        ${doc.status ?? null}, ${bareId(doc.subject?.reference)}, ${sql.array(categoryCodes(doc.category), "text")},
        ${doc.date ?? null}, ${sql.array(rawRefs(doc.author), "text")}, ${sql.array(encounterIds, "text")},
        ${doc.context?.period?.start ?? null}, ${doc.context?.period?.end ?? null}
      )
      ON CONFLICT (source, resource_id) DO UPDATE SET
        fhir_resource_id = EXCLUDED.fhir_resource_id,
        content_hash = EXCLUDED.content_hash,
        status = EXCLUDED.status,
        patient_id = EXCLUDED.patient_id,
        category_codes = EXCLUDED.category_codes,
        date = EXCLUDED.date,
        author_refs = EXCLUDED.author_refs,
        encounter_ids = EXCLUDED.encounter_ids,
        context_period_start = EXCLUDED.context_period_start,
        context_period_end = EXCLUDED.context_period_end,
        transformed_at = now()
      RETURNING id
    `;

    await tx`DELETE FROM clinical.document_reference_type_coding WHERE document_reference_id = ${row.id}`;
    for (const coding of codings(doc.type)) {
      if (!coding.code) continue;
      await tx`
        INSERT INTO clinical.document_reference_type_coding (document_reference_id, system, code, display)
        VALUES (${row.id}, ${coding.system ?? null}, ${coding.code}, ${coding.display ?? null})
      `;
    }

    await tx`DELETE FROM clinical.document_reference_content WHERE document_reference_id = ${row.id}`;
    let position = 0;
    for (const content of doc.content || []) {
      const attachment = content.attachment;
      await tx`
        INSERT INTO clinical.document_reference_content (document_reference_id, content_type, url, title, position)
        VALUES (${row.id}, ${attachment?.contentType ?? null}, ${attachment?.url ?? null}, ${attachment?.title ?? null}, ${position})
      `;
      position += 1;
    }
  });
}
