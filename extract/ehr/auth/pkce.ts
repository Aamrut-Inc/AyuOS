function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function randomUrlSafeString(byteLength = 32): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return base64UrlEncode(bytes);
}

export async function createPkcePair(): Promise<{
  codeVerifier: string;
  codeChallenge: string;
}> {
  const codeVerifier = randomUrlSafeString(64);
  const verifierBytes = new TextEncoder().encode(codeVerifier);
  const challengeBuffer = await crypto.subtle.digest("SHA-256", verifierBytes);
  const codeChallenge = base64UrlEncode(new Uint8Array(challengeBuffer));

  return { codeVerifier, codeChallenge };
}
