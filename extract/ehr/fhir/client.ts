import type { FhirResource, ProviderConfig, TokenResponse } from "../types";
import { guardedFetch } from "../security/network-guard";

interface BundleLink {
  relation?: string;
  url?: string;
}

interface BundleEntry {
  resource?: FhirResource;
}

interface FhirBundle {
  resourceType?: string;
  entry?: BundleEntry[];
  link?: BundleLink[];
}

function resourceSearchUrl(
  config: ProviderConfig,
  resourceType: string,
  patientId: string
): string {
  if (resourceType === "Patient") {
    const url = new URL(`${config.fhirBaseUrl}/Patient`);
    url.searchParams.set("_id", patientId);
    return url.toString();
  }

  const url = new URL(`${config.fhirBaseUrl}/${resourceType}`);
  url.searchParams.set("patient", patientId);

  if (resourceType === "Observation") {
    if (!config.observationCategory) {
      throw new Error(
        "Observation search requires FHIR_OBSERVATION_CATEGORY to be set (Epic rejects Observation.Search without a code or category)"
      );
    }
    url.searchParams.set("category", config.observationCategory);
  }

  return url.toString();
}

async function fhirGet(
  url: string,
  token: TokenResponse,
  config: ProviderConfig
): Promise<unknown> {
  const response = await guardedFetch(
    url,
    {
      method: "GET",
      headers: {
        authorization: `Bearer ${token.access_token}`,
        accept: "application/fhir+json, application/json"
      }
    },
    config,
    "FHIR read"
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `FHIR request failed (${response.status} ${response.statusText}) for ${url}: ${text}`
    );
  }

  return response.json();
}

function nextPageUrl(bundle: FhirBundle): string | undefined {
  return bundle.link?.find((link) => link.relation === "next")?.url;
}

export async function fetchResourceType(params: {
  config: ProviderConfig;
  token: TokenResponse;
  resourceType: string;
  patientId: string;
}): Promise<FhirResource[]> {
  const firstUrl = resourceSearchUrl(
    params.config,
    params.resourceType,
    params.patientId
  );

  const resources: FhirResource[] = [];
  let url: string | undefined = firstUrl;

  while (url) {
    const payload = (await fhirGet(url, params.token, params.config)) as FhirBundle;

    if (payload.resourceType !== "Bundle") {
      throw new Error(
        `Expected Bundle for ${params.resourceType}, received ${payload.resourceType}`
      );
    }

    for (const entry of payload.entry || []) {
      if (entry.resource && entry.resource.resourceType !== "OperationOutcome") {
        resources.push(entry.resource);
      }
    }

    url = nextPageUrl(payload);
  }

  return resources;
}
