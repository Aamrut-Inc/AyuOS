import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { getOrCreateSecret } from "./keychain";

// AES-256-GCM for small secrets stored in the database (OAuth tokens). The key
// lives in the Keychain, so a copy of the database alone can't use them.

function key(): Buffer {
  return Buffer.from(getOrCreateSecret("token-encryption-key"), "hex");
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), body.toString("base64")].join(":");
}

export function decryptSecret(sealed: string): string {
  const [version, iv, tag, body] = sealed.split(":");
  if (version !== "v1" || !iv || !tag || !body) throw new Error("Unrecognized encrypted value");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8");
}
