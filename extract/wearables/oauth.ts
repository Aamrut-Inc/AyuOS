import type { WearablesConfig } from "./config";
import { guardedFetch } from "./security/network-guard";

export type WearableProvider = "oura" | "whoop";

interface AuthorizationUrlResponse {
  authorization_url: string;
  state: string;
}

export async function getAuthorizationUrl(
  config: WearablesConfig,
  provider: WearableProvider,
  userId: string,
  redirectUri: string
): Promise<string> {
  const url = new URL(`${config.apiBaseUrl}/api/v1/oauth/${provider}/authorize`);
  url.searchParams.set("user_id", userId);
  url.searchParams.set("redirect_uri", redirectUri);

  const response = await guardedFetch(
    url.toString(),
    { headers: { "X-Open-Wearables-API-Key": config.apiKey } },
    config
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to get authorization URL (${response.status}): ${text}`);
  }

  const payload = (await response.json()) as AuthorizationUrlResponse;
  return payload.authorization_url;
}

export interface WearableConnection {
  provider: string;
  status: string;
}

export async function getConnections(
  config: WearablesConfig,
  userId: string
): Promise<WearableConnection[]> {
  const response = await guardedFetch(
    `${config.apiBaseUrl}/api/v1/users/${userId}/connections`,
    { headers: { "X-Open-Wearables-API-Key": config.apiKey } },
    config
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to get connections (${response.status}): ${text}`);
  }

  return (await response.json()) as WearableConnection[];
}

export function waitForConnectCallback(redirectUri: string): Promise<{
  result: Promise<void>;
  stop: () => void;
}> {
  const callbackUrl = new URL(redirectUri);
  const port = Number(callbackUrl.port || "80");
  const path = callbackUrl.pathname;

  let resolveResult!: () => void;

  const result = new Promise<void>((resolve) => {
    resolveResult = resolve;
  });

  const server = Bun.serve({
    hostname: callbackUrl.hostname,
    port,
    fetch(req) {
      const url = new URL(req.url);

      if (url.pathname !== path) {
        return new Response("Not found", { status: 404 });
      }

      resolveResult();
      return new Response(
        "Wearable connected. You can close this tab and return to the terminal."
      );
    }
  });

  return Promise.resolve({
    result,
    stop: () => server.stop(true)
  });
}
