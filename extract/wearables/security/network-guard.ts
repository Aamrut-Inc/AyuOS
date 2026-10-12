import { PROVIDERS } from "../providers";

// Wearable code may only talk to the providers' own API and token hosts.
const ALLOWED_HOSTS = new Set(
  Object.values(PROVIDERS).flatMap((p) => [new URL(p.apiBase).hostname, new URL(p.tokenUrl).hostname])
);

export function assertAllowedOutgoingUrl(url: string): void {
  const host = new URL(url).hostname;
  if (!ALLOWED_HOSTS.has(host)) {
    throw new Error(`Blocked outgoing wearables request to ${host}. Allowed hosts: ${[...ALLOWED_HOSTS].join(", ")}`);
  }
}

export async function guardedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  assertAllowedOutgoingUrl(url);
  return fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(60000) });
}
