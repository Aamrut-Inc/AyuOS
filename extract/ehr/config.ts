export type ProviderName = "epic_sandbox" | "stanford";

export interface ProviderConfig {
  name: ProviderName;
  fhirBaseUrl: string;
  authUrl?: string;
  tokenUrl?: string;
  clientId: string;
  redirectUri: string;
  scopes: string;
  searchCategories: Record<string, string[]>;
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

function parseList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

// Every patient-scoped resource type worth keeping for a full history pull.
// Types the server or the granted scopes don't allow are skipped at fetch time.
const DEFAULT_RESOURCE_TYPES = [
  "Patient",
  "AllergyIntolerance",
  "CarePlan",
  "CareTeam",
  "Condition",
  "Device",
  "DiagnosticReport",
  "DocumentReference",
  "Encounter",
  "FamilyMemberHistory",
  "Goal",
  "Immunization",
  "MedicationRequest",
  "MedicationStatement",
  "Observation",
  "Procedure",
  "QuestionnaireResponse",
  "ServiceRequest",
  "Specimen"
];

// Categories searched in addition to one uncategorized search per type.
// Observation covers the HL7 base categories, US Core additions, and Epic's
// own Observation APIs (labor-delivery, lda, smartdata, ...).
const DEFAULT_OBSERVATION_CATEGORIES = [
  "laboratory",
  "vital-signs",
  "social-history",
  "survey",
  "exam",
  "imaging",
  "procedure",
  "therapy",
  "activity",
  "sdoh",
  "functional-status",
  "functional-mental-status",
  "disability-status",
  "cognitive-status",
  "core-characteristics",
  "genomics",
  "labor-delivery",
  "obstetrics-gynecology",
  "lda",
  "smartdata"
];

const DEFAULT_SEARCH_CATEGORIES: Record<string, string[]> = {
  Condition: ["problem-list-item", "encounter-diagnosis", "health-concern", "medical-history"],
  DocumentReference: ["clinical-note"]
};

function parseResourceTypes(): string[] {
  const value = process.env.FHIR_RESOURCE_TYPES?.trim();
  return value ? parseList(value) : DEFAULT_RESOURCE_TYPES;
}

function parseSearchCategories(): Record<string, string[]> {
  const observation = process.env.FHIR_OBSERVATION_CATEGORIES?.trim();
  return {
    ...DEFAULT_SEARCH_CATEGORIES,
    Observation: observation ? parseList(observation) : DEFAULT_OBSERVATION_CATEGORIES
  };
}

// One read/search scope per resource type, so the consent screen asks for
// exactly what the import will fetch.
function defaultScopes(resourceTypes: string[]): string {
  return ["launch/patient", "openid", "fhirUser", ...resourceTypes.map((type) => `patient/${type}.rs`)].join(" ");
}

export function loadProviderConfig(): ProviderConfig {
  const resourceTypes = parseResourceTypes();
  return {
    name: parseProviderName(),
    fhirBaseUrl: requiredEnv("FHIR_BASE_URL").replace(/\/$/, ""),
    authUrl: optionalEnv("FHIR_AUTH_URL"),
    tokenUrl: optionalEnv("FHIR_TOKEN_URL"),
    clientId: requiredEnv("FHIR_CLIENT_ID"),
    redirectUri: requiredEnv("FHIR_REDIRECT_URI"),
    scopes: process.env.FHIR_SCOPES?.trim() || defaultScopes(resourceTypes),
    searchCategories: parseSearchCategories(),
    resourceTypes,
    allowNonFhirNetwork: process.env.ALLOW_NON_FHIR_NETWORK === "true"
  };
}
