export type ProviderName = "epic_sandbox" | "stanford";

export interface ProviderConfig {
  name: ProviderName;
  fhirBaseUrl: string;
  authUrl?: string;
  tokenUrl?: string;
  clientId: string;
  redirectUri: string;
  scopes: string;
  observationCategory?: string;
  resourceTypes: string[];
  allowNonFhirNetwork: boolean;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  scope?: string;
  patient?: string;
  refresh_token?: string;
  id_token?: string;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function parseProviderName(): ProviderName {
  const value = process.env.FHIR_PROVIDER?.trim() || "epic_sandbox";
  if (value !== "epic_sandbox" && value !== "stanford") {
    throw new Error(`Unsupported FHIR_PROVIDER: ${value}`);
  }
  return value;
}

function parseResourceTypes(): string[] {
  const value =
    process.env.FHIR_RESOURCE_TYPES ||
    "Patient,Condition,Observation,MedicationRequest,AllergyIntolerance,Immunization,DiagnosticReport,DocumentReference,Encounter,Procedure";

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function loadProviderConfig(): ProviderConfig {
  return {
    name: parseProviderName(),
    fhirBaseUrl: requiredEnv("FHIR_BASE_URL").replace(/\/$/, ""),
    authUrl: optionalEnv("FHIR_AUTH_URL"),
    tokenUrl: optionalEnv("FHIR_TOKEN_URL"),
    clientId: requiredEnv("FHIR_CLIENT_ID"),
    redirectUri: requiredEnv("FHIR_REDIRECT_URI"),
    scopes:
      process.env.FHIR_SCOPES?.trim() ||
      "launch/patient openid fhirUser patient/*.rs",
    observationCategory: optionalEnv("FHIR_OBSERVATION_CATEGORY"),
    resourceTypes: parseResourceTypes(),
    allowNonFhirNetwork: process.env.ALLOW_NON_FHIR_NETWORK === "true"
  };
}
