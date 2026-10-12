import type { ProviderConfig } from "../config";
import { assertAllowedOutgoingUrl } from "../security/network-guard";
import { resolveEndpoints } from "./smart-oauth";

// Whether a hospital's Epic server already knows this app's client ID (Epic
// rolls apps out to hospitals gradually), checked without logging in:
//   known       - the server accepts the request and would show its login page
//   unknown     - the server doesn't recognize the client (not rolled out yet)
//   rejected    - recognized, but the request is refused (redirect URI, APIs)
//   unreachable - couldn't ask (offline, or the hospital only accepts US traffic)
export type ClientStatus = "known" | "unknown" | "rejected" | "unreachable";

export async function checkClientKnown(config: ProviderConfig): Promise<ClientStatus> {
  let authUrl: string;
  try {
    authUrl = (await resolveEndpoints(config)).authUrl;
    assertAllowedOutgoingUrl(authUrl, config, "client check");
  } catch {
    return "unreachable";
  }

  const url = new URL(authUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", "launch/patient openid fhirUser patient/Patient.rs");
  url.searchParams.set("state", "client-check");
  url.searchParams.set("aud", config.fhirBaseUrl);
  url.searchParams.set("code_challenge", "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  url.searchParams.set("code_challenge_method", "S256");

  try {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15000) });
    const location = response.headers.get("location");
    if (!location) return "unknown";
    return /[?&]error=/.test(location) ? "rejected" : "known";
  } catch {
    return "unreachable";
  }
}
