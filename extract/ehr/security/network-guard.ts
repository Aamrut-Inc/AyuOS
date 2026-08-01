import type { ProviderConfig } from "../types";

function hostnameFor(url: string): string {
  return new URL(url).hostname;
}

export function allowedProviderHosts(config: ProviderConfig): Set<string> {
  const hosts = new Set<string>([hostnameFor(config.fhirBaseUrl)]);

  if (config.authUrl) hosts.add(hostnameFor(config.authUrl));
  if (config.tokenUrl) hosts.add(hostnameFor(config.tokenUrl));

  return hosts;
}

export function assertAllowedOutgoingUrl(
  url: string,
  config: ProviderConfig,
  purpose: string
): void {
  if (config.allowNonFhirNetwork) return;

  const target = new URL(url);
  const allowedHosts = allowedProviderHosts(config);

  if (!allowedHosts.has(target.hostname)) {
    throw new Error(
      `Blocked outgoing ${purpose} request to ${target.hostname}. ` +
        `Allowed provider hosts: ${Array.from(allowedHosts).join(", ")}`
    );
  }
}

export async function guardedFetch(
  url: string,
  init: RequestInit,
  config: ProviderConfig,
  purpose: string
): Promise<Response> {
  assertAllowedOutgoingUrl(url, config, purpose);
  return fetch(url, init);
}
