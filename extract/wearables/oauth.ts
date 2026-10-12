import { credentialsFor, PROVIDERS, redirectUriFor, type WearableProvider } from "./providers";
import { guardedFetch } from "./security/network-guard";

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scope: string | null;
}

// A refresh/exchange the provider refused outright (revoked or reused refresh
// token, wrong credentials): only a fresh login fixes it.
export class ReconnectRequiredError extends Error {}

export function authorizeUrl(provider: WearableProvider, state: string): string {
  const info = PROVIDERS[provider];
  const credentials = credentialsFor(provider);
  if (!credentials) {
    throw new Error(`${info.name} isn't set up on this computer yet (missing client ID/secret — run scripts/start.command).`);
  }
  const url = new URL(info.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", credentials.clientId);
  url.searchParams.set("redirect_uri", redirectUriFor(provider));
  url.searchParams.set("scope", info.scope);
  url.searchParams.set("state", state);
  return url.toString();
}

async function tokenRequest(provider: WearableProvider, params: Record<string, string>): Promise<TokenSet> {
  const info = PROVIDERS[provider];
  const credentials = credentialsFor(provider);
  if (!credentials) throw new ReconnectRequiredError(`${info.name} client credentials are missing`);

  const response = await guardedFetch(info.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ ...params, client_id: credentials.clientId, client_secret: credentials.clientSecret })
  });
  const text = await response.text();
  if (!response.ok) {
    const message = `${info.name} token request failed (${response.status}): ${text.slice(0, 300)}`;
    // 400/401 from the token endpoint means the grant itself is dead.
    if (response.status === 400 || response.status === 401) throw new ReconnectRequiredError(message);
    throw new Error(message);
  }

  const body = JSON.parse(text) as { access_token: string; refresh_token?: string; expires_in?: number; scope?: string };
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : null,
    scope: body.scope ?? null
  };
}

export function exchangeCode(provider: WearableProvider, code: string): Promise<TokenSet> {
  return tokenRequest(provider, { grant_type: "authorization_code", code, redirect_uri: redirectUriFor(provider) });
}

export function refreshTokens(provider: WearableProvider, refreshToken: string): Promise<TokenSet> {
  const scope = PROVIDERS[provider].refreshScope;
  return tokenRequest(provider, { grant_type: "refresh_token", refresh_token: refreshToken, ...(scope ? { scope } : {}) });
}
