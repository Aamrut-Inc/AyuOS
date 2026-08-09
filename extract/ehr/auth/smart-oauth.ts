import type { ProviderConfig, TokenResponse } from "../config";
import { guardedFetch } from "../security/network-guard";
import { createPkcePair, randomUrlSafeString } from "./pkce";
import { startLocalCallbackServer } from "./local-callback";

interface SmartConfiguration {
  authorization_endpoint?: string;
  token_endpoint?: string;
}

async function discoverSmartConfiguration(
  config: ProviderConfig
): Promise<SmartConfiguration> {
  const discoveryUrl = `${config.fhirBaseUrl}/.well-known/smart-configuration`;
  const response = await guardedFetch(
    discoveryUrl,
    { method: "GET" },
    config,
    "SMART discovery"
  );

  if (!response.ok) {
    throw new Error(
      `SMART discovery failed (${response.status} ${response.statusText})`
    );
  }

  return response.json() as Promise<SmartConfiguration>;
}

async function resolveEndpoints(config: ProviderConfig): Promise<{
  authUrl: string;
  tokenUrl: string;
}> {
  if (config.authUrl && config.tokenUrl) {
    return { authUrl: config.authUrl, tokenUrl: config.tokenUrl };
  }

  const smartConfig = await discoverSmartConfiguration(config);
  const authUrl = config.authUrl || smartConfig.authorization_endpoint;
  const tokenUrl = config.tokenUrl || smartConfig.token_endpoint;

  if (!authUrl || !tokenUrl) {
    throw new Error("Could not resolve SMART authorization/token endpoints");
  }

  return { authUrl, tokenUrl };
}

function buildAuthorizeUrl(params: {
  authUrl: string;
  config: ProviderConfig;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(params.authUrl);

  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", params.config.clientId);
  url.searchParams.set("redirect_uri", params.config.redirectUri);
  url.searchParams.set("scope", params.config.scopes);
  url.searchParams.set("aud", params.config.fhirBaseUrl);
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");

  return url.toString();
}

async function exchangeCodeForToken(params: {
  tokenUrl: string;
  code: string;
  codeVerifier: string;
  config: ProviderConfig;
}): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.config.redirectUri,
    client_id: params.config.clientId,
    code_verifier: params.codeVerifier
  });

  const response = await guardedFetch(
    params.tokenUrl,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json"
      },
      body
    },
    params.config,
    "token exchange"
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Token exchange failed (${response.status} ${response.statusText}): ${text}`
    );
  }

  return response.json() as Promise<TokenResponse>;
}

export async function runSmartOAuth(config: ProviderConfig): Promise<TokenResponse> {
  const endpoints = await resolveEndpoints(config);
  const { codeVerifier, codeChallenge } = await createPkcePair();
  const state = randomUrlSafeString(32);
  const callbackServer = await startLocalCallbackServer(
    config.redirectUri,
    state
  );

  const authorizeUrl = buildAuthorizeUrl({
    authUrl: endpoints.authUrl,
    config,
    state,
    codeChallenge
  });

  console.log("Open this URL in your browser to authorize the import:");
  console.log(authorizeUrl);

  try {
    const callback = await callbackServer.result;
    return await exchangeCodeForToken({
      tokenUrl: endpoints.tokenUrl,
      code: callback.code,
      codeVerifier,
      config
    });
  } finally {
    callbackServer.stop();
  }
}
