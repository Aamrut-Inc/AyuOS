import { PROVIDERS, type WearableProvider } from "./providers";
import { guardedFetch } from "./security/network-guard";
import type { WearableConnectionStore } from "../../load/wearable-connections";

// A provider API response that means "this data isn't available for this
// account" (no membership, scope not granted): skipping it is fine, and it
// mustn't hold the sync's resume point back.
export class NotAvailableError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const MAX_RATE_LIMIT_RETRIES = 4;

// GET a provider API path with a valid token: refreshes once on 401, waits
// out 429 rate limits (Whoop allows 100 requests/minute).
export async function providerGet<T>(
  store: WearableConnectionStore,
  provider: WearableProvider,
  path: string,
  params: Record<string, string> = {}
): Promise<T> {
  const url = new URL(`${PROVIDERS[provider].apiBase}${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  let forcedRefresh = false;
  for (let attempt = 0; ; attempt++) {
    const token = await store.accessToken(provider, forcedRefresh);
    const response = await guardedFetch(url.toString(), {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" }
    });

    if (response.ok) return (await response.json()) as T;

    const text = await response.text();
    const message = `${PROVIDERS[provider].name} ${path} failed (${response.status}): ${text.slice(0, 200)}`;
    if (response.status === 401) {
      if (!forcedRefresh) {
        forcedRefresh = true;
        continue;
      }
      // Still refused with a token that was just renewed: the login works,
      // but the user didn't share this data type with AyuOS.
      throw new NotAvailableError(message, response.status);
    }
    if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
      const retryAfter = Number(response.headers.get("retry-after"));
      await Bun.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 15000 * (attempt + 1));
      continue;
    }
    if (response.status === 403 || response.status === 404) throw new NotAvailableError(message, response.status);
    throw new Error(message);
  }
}
