import { loadProviderConfig } from "../extract/ehr/config";
import { runSmartOAuth } from "../extract/ehr/auth/smart-oauth";
import { importEhr, requirePatientId } from "../extract/ehr/sync";
import { loadPostgresConfig } from "../load/config";
import { RawFhirStore } from "../load/raw-store";

async function main(): Promise<void> {
  const providerConfig = loadProviderConfig();
  const store = new RawFhirStore(loadPostgresConfig());

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

  console.log("Import complete.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
