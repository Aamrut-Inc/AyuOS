import { loadProviderConfig } from "../extract/ehr/config";
import { runSmartOAuth } from "../extract/ehr/auth/smart-oauth";
import { fetchResourceType } from "../extract/ehr/fhir/client";
import { loadPostgresConfig } from "../load/config";
import { RawFhirStore } from "../load/raw-store";

function requirePatientId(patientId: string | undefined): string {
  if (!patientId) {
    throw new Error(
      "OAuth token response did not include a patient id. " +
        "Check that the requested scopes include launch/patient."
    );
  }
  return patientId;
}

async function main(): Promise<void> {
  const providerConfig = loadProviderConfig();
  const store = new RawFhirStore(loadPostgresConfig());

  const token = await runSmartOAuth(providerConfig);
  const patientId = requirePatientId(token.patient);

  try {
    for (const resourceType of providerConfig.resourceTypes) {
      const resources = await fetchResourceType({
        config: providerConfig,
        token,
        resourceType,
        patientId
      });

      for (const resource of resources) {
        await store.upsertResource(resource, patientId, providerConfig.name);
      }

      console.log(`${resourceType}: ${resources.length} resource(s) stored`);
    }
  } finally {
    await store.close();
  }

  console.log("Import complete.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
