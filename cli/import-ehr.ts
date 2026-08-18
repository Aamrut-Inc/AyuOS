import { loadProviderConfig } from "../extract/ehr/config";
import { runSmartOAuth } from "../extract/ehr/auth/smart-oauth";
import { importEhr, requirePatientId } from "../extract/ehr/sync";
import { loadPostgresConfig, assertPostgresReachable } from "../load/config";
import { RawFhirStore } from "../load/raw-store";
import { runTransform } from "../transform/run";

async function main(): Promise<void> {
  const postgresConfig = loadPostgresConfig();
  await assertPostgresReachable(postgresConfig);

  const providerConfig = loadProviderConfig();
  const store = new RawFhirStore(postgresConfig);

  const token = await runSmartOAuth(providerConfig);
  const patientId = requirePatientId(token.patient);

  try {
    const countsByType = await importEhr(providerConfig, token, patientId, store);
    for (const [type, count] of Object.entries(countsByType)) {
      console.log(`${type}: ${count} resource(s) stored`);
    }
  } finally {
    await store.close();
  }

  const transformCounts = await runTransform(postgresConfig);
  for (const [resourceType, count] of Object.entries(transformCounts)) {
    console.log(`${resourceType}: ${count} resource(s) transformed`);
  }

  console.log("Import complete.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
