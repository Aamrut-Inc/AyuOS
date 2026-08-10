import type { FhirResource } from "../../shared/types";

const API_VERSION = "2024-05-01-preview";
const ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost"]);

interface ConvertResponse {
  result?: {
    resourceType?: string;
    entry?: Array<{ resource?: FhirResource }>;
  };
  error?: { code?: string; message?: string };
}

function assertLocalOnly(url: string): void {
  const hostname = new URL(url).hostname;
  if (!ALLOWED_HOSTS.has(hostname)) {
    throw new Error(
      `Refusing to send C-CDA content to non-local host ${hostname}. ` +
        `The FHIR converter must run on localhost — this data never leaves the machine.`
    );
  }
}

export async function convertCcdaToFhir(
  ccdaXml: string,
  fhirConverterUrl: string
): Promise<FhirResource[]> {
  assertLocalOnly(fhirConverterUrl);

  const url = `${fhirConverterUrl.replace(/\/$/, "")}/convertToFhir?api-version=${API_VERSION}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      InputDataFormat: "Ccda",
      RootTemplateName: "CCD",
      InputDataString: ccdaXml
    })
  });

  const payload = (await response.json()) as ConvertResponse;

  if (!response.ok || !payload.result) {
    throw new Error(
      `FHIR converter request failed (${response.status}): ${payload.error?.message ?? "unknown error"}`
    );
  }

  return (payload.result.entry ?? [])
    .map((entry) => entry.resource)
    .filter((resource): resource is FhirResource => Boolean(resource));
}
