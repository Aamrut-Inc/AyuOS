import type { ProviderConfig, TokenResponse } from "./config";
import { fetchResourceType, FhirHttpError } from "./fhir/client";
import { RawFhirStore } from "../../load/raw-store";

export function requirePatientId(patientId: string | undefined): string {
  if (!patientId) {
    throw new Error(
      "OAuth token response did not include a patient id. " +
        "Check that the requested scopes include launch/patient."
    );
  }
  return patientId;
}

export async function importEhr(
  config: ProviderConfig,
  token: TokenResponse,
  patientId: string,
  store: RawFhirStore
): Promise<Record<string, number>> {
  const countsByType: Record<string, number> = {};

  for (const resourceType of config.resourceTypes) {
    let resources;
    try {
      resources = await fetchResourceType({
        config,
        token,
        resourceType,
        patientId
      });
    } catch (error) {
      // Not supported by this server or not covered by the granted scopes —
      // skip it rather than losing every other resource type in the import.
      if (error instanceof FhirHttpError && error.status >= 400 && error.status < 500) {
        console.warn(`${resourceType}: not available (HTTP ${error.status}), skipping`);
        continue;
      }
      throw error;
    }

    for (const resource of resources) {
      await store.upsertResource(resource, patientId, config.name);
    }

    countsByType[resourceType] = resources.length;
  }

  return countsByType;
}
