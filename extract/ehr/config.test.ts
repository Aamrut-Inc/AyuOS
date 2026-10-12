import { afterEach, expect, test } from "bun:test";
import { loadProviderConfig } from "./config";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

function load(redirectUri: string, listen?: string) {
  process.env.FHIR_BASE_URL = "https://fhir.example.com/R4";
  process.env.FHIR_CLIENT_ID = "test";
  process.env.FHIR_REDIRECT_URI = redirectUri;
  if (listen) process.env.FHIR_CALLBACK_LISTEN_URI = listen;
  else delete process.env.FHIR_CALLBACK_LISTEN_URI;
  return loadProviderConfig();
}

test("a loopback redirect URI is also where the callback listens", () => {
  expect(load("http://127.0.0.1:8765").callbackListenUri).toBe("http://127.0.0.1:8765");
});

test("a public https forwarding page listens on the default loopback port", () => {
  const config = load("https://ishaan-netizen.github.io/ayuos-callback/");
  expect(config.redirectUri).toBe("https://ishaan-netizen.github.io/ayuos-callback/");
  expect(config.callbackListenUri).toBe("http://127.0.0.1:8765");
});

test("the listen address can be overridden", () => {
  expect(load("https://example.com/cb", "http://127.0.0.1:9999").callbackListenUri).toBe("http://127.0.0.1:9999");
});
