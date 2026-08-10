import type { WearablesConfig } from "../config";

export function assertAllowedOutgoingUrl(url: string, config: WearablesConfig): void {
  const target = new URL(url);
  const allowedHost = new URL(config.apiBaseUrl).hostname;

  if (target.hostname !== allowedHost) {
    throw new Error(
      `Blocked outgoing wearables request to ${target.hostname}. ` +
        `Allowed host: ${allowedHost}`
    );
  }
}

export async function guardedFetch(
  url: string,
  init: RequestInit,
  config: WearablesConfig
): Promise<Response> {
  assertAllowedOutgoingUrl(url, config);
  return fetch(url, init);
}
