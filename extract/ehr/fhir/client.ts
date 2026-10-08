import type { ProviderConfig, TokenResponse } from "../config";
import type { FhirResource } from "../../../shared/types";
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

// Raised for non-2xx FHIR responses so callers can tell "this server doesn't
// support/allow this search" (4xx) apart from network failures.
export class FhirHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function resourceSearchUrl(
  config: ProviderConfig,
  resourceType: string,
  patientId: string,
  category?: string
): string {
  if (resourceType === "Patient") {
    const url = new URL(`${config.fhirBaseUrl}/Patient`);
    url.searchParams.set("_id", patientId);
    return url.toString();
  }

  const url = new URL(`${config.fhirBaseUrl}/${resourceType}`);
  url.searchParams.set("patient", patientId);
  if (category) url.searchParams.set("category", category);

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
    throw new FhirHttpError(
      `FHIR request failed (${response.status} ${response.statusText}) for ${url}: ${text}`,
      response.status
    );
  }

  return response.json();
}

function nextPageUrl(bundle: FhirBundle): string | undefined {
  return bundle.link?.find((link) => link.relation === "next")?.url;
}

async function fetchAllPages(
  firstUrl: string,
  resourceType: string,
  token: TokenResponse,
  config: ProviderConfig
): Promise<FhirResource[]> {
  const resources: FhirResource[] = [];
  let url: string | undefined = firstUrl;

  while (url) {
    const payload = (await fhirGet(url, token, config)) as FhirBundle;

    if (payload.resourceType !== "Bundle") {
      throw new Error(
        `Expected Bundle for ${resourceType}, received ${payload.resourceType}`
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

// Some servers (Epic in particular) only answer certain resource types per
// category, e.g. Observation is rejected without a category and Condition
// splits problem list / encounter diagnoses / history into separate searches.
// A full pull therefore runs one uncategorized search plus one per configured
// category. Searches the server doesn't support come back as 4xx and are
// skipped; the same resource can match several searches, so results are
// de-duplicated by id. Throws only if every search for the type was refused.
export async function fetchResourceType(params: {
  config: ProviderConfig;
  token: TokenResponse;
  resourceType: string;
  patientId: string;
}): Promise<FhirResource[]> {
  const { config, token, resourceType, patientId } = params;
  const categories = resourceType === "Patient" ? [] : config.searchCategories[resourceType] ?? [];
  const searches: Array<string | undefined> = [undefined, ...categories];

  const byId = new Map<string, FhirResource>();
  const refusals: FhirHttpError[] = [];

  for (const category of searches) {
    const url = resourceSearchUrl(config, resourceType, patientId, category);
    let resources: FhirResource[];
    try {
      resources = await fetchAllPages(url, resourceType, token, config);
    } catch (error) {
      if (error instanceof FhirHttpError && error.status >= 400 && error.status < 500) {
        refusals.push(error);
        continue;
      }
      throw error;
    }
    for (const resource of resources) {
      byId.set(resource.id ?? JSON.stringify(resource), resource);
    }
  }

  if (refusals.length === searches.length) {
    throw refusals[refusals.length - 1];
  }

  return [...byId.values()];
}
