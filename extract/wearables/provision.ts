import { readFileSync, writeFileSync } from "node:fs";
import type { WearablesConfig } from "./config";
import { guardedFetch } from "./security/network-guard";

const ENV_PATH = new URL("../../.env", import.meta.url).pathname;

interface CreateUserResponse {
  id: string;
}

async function createOpenWearablesUser(config: WearablesConfig): Promise<string> {
  const response = await guardedFetch(
    `${config.apiBaseUrl}/api/v1/users`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Open-Wearables-API-Key": config.apiKey
      },
      body: JSON.stringify({})
    },
    config
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to create Open Wearables user (${response.status}): ${text}`);
  }

  const payload = (await response.json()) as CreateUserResponse;
  return payload.id;
}

function persistUserIdToEnv(userId: string): void {
  const existing = readFileSync(ENV_PATH, "utf8");
  const line = `OPEN_WEARABLES_USER_ID=${userId}`;

  const updated = existing.match(/^OPEN_WEARABLES_USER_ID=.*$/m)
    ? existing.replace(/^OPEN_WEARABLES_USER_ID=.*$/m, line)
    : `${existing.replace(/\n$/, "")}\n${line}\n`;

  writeFileSync(ENV_PATH, updated);
  process.env.OPEN_WEARABLES_USER_ID = userId;
}

export async function getOrCreateUserId(config: WearablesConfig): Promise<string> {
  if (config.userId) return config.userId;

  const userId = await createOpenWearablesUser(config);
  persistUserIdToEnv(userId);
  console.log(`Created Open Wearables user ${userId} and saved it to .env`);
  return userId;
}
