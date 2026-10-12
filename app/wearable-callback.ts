import { randomBytes } from "node:crypto";
import { CALLBACK_PORT, isWearableProvider, type WearableProvider } from "../extract/wearables/providers";
import { exchangeCode } from "../extract/wearables/oauth";
import { WearableConnectionStore } from "../load/wearable-connections";
import { loadPostgresConfig } from "../load/config";

// Receives Oura/Whoop logins on http://localhost:8000/api/v1/oauth/<provider>/callback
// — the redirect URI already registered in both providers' developer consoles
// (it used to belong to the Docker wearables backend) — then sends the browser
// back to the AyuOS page.

const STATE_TTL_MS = 15 * 60 * 1000;
const pendingStates = new Map<string, { provider: WearableProvider; createdAt: number }>();

export function newLoginState(provider: WearableProvider): string {
  const now = Date.now();
  for (const [state, entry] of pendingStates) {
    if (now - entry.createdAt > STATE_TTL_MS) pendingStates.delete(state);
  }
  const state = randomBytes(24).toString("base64url");
  pendingStates.set(state, { provider, createdAt: now });
  return state;
}

export function startWearableCallbackServer(appOrigin: string, onConnected: (provider: WearableProvider) => void): void {
  const back = (path: string) => Response.redirect(`${appOrigin}${path}`, 303);

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const match = url.pathname.match(/^\/api\/v1\/oauth\/([a-z]+)\/callback$/);
    if (!match || !isWearableProvider(match[1])) return new Response("Not found", { status: 404 });
    const provider = match[1];

    const state = url.searchParams.get("state") ?? "";
    const pending = pendingStates.get(state);
    pendingStates.delete(state);

    const error = url.searchParams.get("error");
    if (error) {
      const query = new URLSearchParams({ provider, error, error_description: url.searchParams.get("error_description") ?? "" });
      return back(`/connect/wearables/callback?${query}`);
    }
    if (!pending || pending.provider !== provider || Date.now() - pending.createdAt > STATE_TTL_MS) {
      const query = new URLSearchParams({ provider, error: "expired_login", error_description: "The login took too long or was started elsewhere. Please try again." });
      return back(`/connect/wearables/callback?${query}`);
    }
    const code = url.searchParams.get("code");
    if (!code) return back(`/connect/wearables/callback?${new URLSearchParams({ provider, error: "missing_code" })}`);

    const store = new WearableConnectionStore(loadPostgresConfig());
    try {
      await store.save(provider, await exchangeCode(provider, code));
    } catch (e) {
      const query = new URLSearchParams({ provider, error: "token_exchange_failed", error_description: e instanceof Error ? e.message : String(e) });
      return back(`/connect/wearables/callback?${query}`);
    } finally {
      await store.close();
    }
    onConnected(provider);
    return back(`/?connected=${provider}`);
  }

  // "localhost" can resolve to IPv4 or IPv6 depending on the browser.
  for (const hostname of ["127.0.0.1", "::1"]) {
    try {
      Bun.serve({ hostname, port: CALLBACK_PORT, fetch: handle });
    } catch (error) {
      console.warn(
        `Wearable login callback can't listen on ${hostname}:${CALLBACK_PORT} — is the old Docker wearables backend still running? ` +
          (error instanceof Error ? error.message : String(error))
      );
    }
  }
}
