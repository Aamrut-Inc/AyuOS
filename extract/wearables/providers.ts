// The wearables AyuOS talks to directly. Client IDs/secrets come from .env
// (shared by the team; see docs/tester-setup.md). The redirect URIs are the
// ones already registered in each provider's developer console, which is why
// AyuOS answers them on localhost:8000 (see app/wearable-callback.ts).

export type WearableProvider = "oura" | "whoop";

export interface ProviderInfo {
  id: WearableProvider;
  name: string;
  authorizeUrl: string;
  tokenUrl: string;
  apiBase: string;
  scope: string;
  // Whoop rejects refresh requests that don't restate a scope.
  refreshScope?: string;
}

export const PROVIDERS: Record<WearableProvider, ProviderInfo> = {
  oura: {
    id: "oura",
    name: "Oura",
    authorizeUrl: "https://cloud.ouraring.com/oauth/authorize",
    tokenUrl: "https://api.ouraring.com/oauth/token",
    apiBase: "https://api.ouraring.com",
    scope: "personal daily activity heartrate workout session spo2 ring_configuration heart_health"
  },
  whoop: {
    id: "whoop",
    name: "Whoop",
    authorizeUrl: "https://api.prod.whoop.com/oauth/oauth2/auth",
    tokenUrl: "https://api.prod.whoop.com/oauth/oauth2/token",
    apiBase: "https://api.prod.whoop.com/developer",
    scope: "offline read:cycles read:sleep read:recovery read:workout read:body_measurement read:profile",
    refreshScope: "offline"
  }
};

export const CALLBACK_PORT = 8000;

export function redirectUriFor(provider: WearableProvider): string {
  return `http://localhost:${CALLBACK_PORT}/api/v1/oauth/${provider}/callback`;
}

export function isWearableProvider(value: string): value is WearableProvider {
  return value === "oura" || value === "whoop";
}

export interface ClientCredentials {
  clientId: string;
  clientSecret: string;
}

const PLACEHOLDER = /^(|public-client-id|private-secret-id|your-.*)$/;

export function credentialsFor(provider: WearableProvider): ClientCredentials | null {
  const prefix = provider.toUpperCase();
  const clientId = process.env[`${prefix}_CLIENT_ID`]?.trim() ?? "";
  const clientSecret = process.env[`${prefix}_CLIENT_SECRET`]?.trim() ?? "";
  if (PLACEHOLDER.test(clientId) || PLACEHOLDER.test(clientSecret)) return null;
  return { clientId, clientSecret };
}

// Single local user: readings are keyed by this id. Existing installs keep
// the id their history was stored under.
export function localUserId(): string {
  return process.env.AYUOS_USER_ID?.trim() || process.env.OPEN_WEARABLES_USER_ID?.trim() || "me";
}
