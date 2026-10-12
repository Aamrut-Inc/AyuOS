// Short name for the connected health system ("epic_sandbox", "stanford",
// "ucsf", ...). Stored as the `source` of every record, so records from
// different hospitals stay distinguishable.
export type ProviderName = string;

export interface ProviderConfig {
  name: ProviderName;
  fhirBaseUrl: string;
  authUrl?: string;
  tokenUrl?: string;
  clientId: string;
  redirectUri: string;
  // Where the local process listens for the login callback. Same as
  // redirectUri when that is a loopback address; when redirectUri is a public
  // https forwarding page (required by Epic for production apps), the page
  // bounces the browser here.
  callbackListenUri: string;
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
  if (!/^[a-z0-9_]{2,40}$/.test(value)) {
    throw new Error(
      `FHIR_PROVIDER must be a short lowercase name like "stanford" or "ucsf" (letters, digits, underscores): ${value}`
    );
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
  // Binary isn't searched, but reading attachment files needs it.
  const scopes = [...resourceTypes.map((type) => `patient/${type}.rs`), "patient/Binary.r"];
  return ["launch/patient", "openid", "fhirUser", ...scopes].join(" ");
}

const DEFAULT_CALLBACK_LISTEN_URI = "http://127.0.0.1:8765";

function callbackListenUri(redirectUri: string): string {
  const explicit = optionalEnv("FHIR_CALLBACK_LISTEN_URI");
  if (explicit) return explicit;
  const host = new URL(redirectUri).hostname;
  return host === "127.0.0.1" || host === "localhost" ? redirectUri : DEFAULT_CALLBACK_LISTEN_URI;
}

// A health system the user connected (from Epic's directory). Without one,
// the hospital comes from FHIR_PROVIDER / FHIR_BASE_URL in .env.
export interface Hospital {
  slug: string;
  fhirBaseUrl: string;
  sandbox: boolean;
}

export const EPIC_SANDBOX_BASE_URL = "https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4";

// Real hospitals use the app's production client ID (FHIR_CLIENT_ID); Epic's
// test sandbox uses its non-production one (FHIR_SANDBOX_CLIENT_ID).
function clientIdFor(sandbox: boolean): string {
  if (sandbox) {
    return optionalEnv("FHIR_SANDBOX_CLIENT_ID") ?? requiredEnv("FHIR_CLIENT_ID");
  }
  return requiredEnv("FHIR_CLIENT_ID");
}

export function loadProviderConfig(hospital?: Hospital): ProviderConfig {
  const resourceTypes = parseResourceTypes();
  const redirectUri = requiredEnv("FHIR_REDIRECT_URI");
  const name = hospital?.slug ?? parseProviderName();
  const fhirBaseUrl = (hospital?.fhirBaseUrl ?? requiredEnv("FHIR_BASE_URL")).replace(/\/+$/, "");
  const sandbox = hospital?.sandbox ?? fhirBaseUrl === EPIC_SANDBOX_BASE_URL;
  return {
    name,
    fhirBaseUrl,
    // Explicit endpoint overrides only make sense for the .env hospital.
    authUrl: hospital ? undefined : optionalEnv("FHIR_AUTH_URL"),
    tokenUrl: hospital ? undefined : optionalEnv("FHIR_TOKEN_URL"),
    clientId: clientIdFor(sandbox),
    redirectUri,
    callbackListenUri: callbackListenUri(redirectUri),
    scopes: process.env.FHIR_SCOPES?.trim() || defaultScopes(resourceTypes),
    searchCategories: parseSearchCategories(),
    resourceTypes,
    allowNonFhirNetwork: process.env.ALLOW_NON_FHIR_NETWORK === "true"
  };
}
