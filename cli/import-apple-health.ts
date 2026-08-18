import { loadAppleHealthConfig } from "../extract/apple-health/config";
import { findClinicalDocuments } from "../extract/apple-health/parse-export";
import { convertCcdaToFhir } from "../extract/apple-health/ccda-converter";
import { loadPostgresConfig, assertPostgresReachable } from "../load/config";
import { RawFhirStore } from "../load/raw-store";
import { runTransform } from "../transform/run";
import type { FhirResource } from "../shared/types";

function bareId(reference: string | undefined): string | null {
  if (!reference) return null;
  const slash = reference.lastIndexOf("/");
  return slash === -1 ? reference : reference.slice(slash + 1);
}

function patientIdFor(resource: FhirResource): string | null {
  if (resource.resourceType === "Patient") return resource.id ?? null;

  const subject = resource.subject as { reference?: string } | undefined;
  const patient = resource.patient as { reference?: string } | undefined;
  return bareId(subject?.reference) ?? bareId(patient?.reference);
}

async function main(): Promise<void> {
  const postgresConfig = loadPostgresConfig();
  await assertPostgresReachable(postgresConfig);

  const config = loadAppleHealthConfig();
  const store = new RawFhirStore(postgresConfig);

  const documents = await findClinicalDocuments(config.exportPath);
  console.log(`Found ${documents.length} clinical document(s) in export`);

  let stored = 0;
  try {
    for (const doc of documents) {
      const resources: FhirResource[] =
        doc.format === "ccda"
          ? await convertCcdaToFhir(doc.content, config.fhirConverterUrl)
          : [JSON.parse(doc.content) as FhirResource];

      for (const resource of resources) {
        if (!resource.resourceType || !resource.id) continue;
        await store.upsertResource(resource, patientIdFor(resource), "apple_health");
        stored += 1;
      }
    }
  } finally {
    await store.close();
  }

  const transformCounts = await runTransform(postgresConfig);
  for (const [resourceType, count] of Object.entries(transformCounts)) {
    console.log(`${resourceType}: ${count} resource(s) transformed`);
  }

  console.log(`Import complete. ${stored} resource(s) stored.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
