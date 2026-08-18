import { loadWearablesConfig } from "../extract/wearables/config";
import { getOrCreateUserId } from "../extract/wearables/provision";
import {
  getAuthorizationUrl,
  waitForConnectCallback,
  type WearableProvider
} from "../extract/wearables/oauth";
import { syncWearables } from "../extract/wearables/sync";
import { loadPostgresConfig, assertPostgresReachable } from "../load/config";

const REDIRECT_URI = "http://127.0.0.1:8766/connected";

function parseProvider(): WearableProvider {
  const arg = process.argv[2]?.trim();
  if (arg !== "oura" && arg !== "whoop") {
    throw new Error(`Usage: bun run cli/connect-wearables.ts <oura|whoop>`);
  }
  return arg;
}

async function main(): Promise<void> {
  const provider = parseProvider();
  await assertPostgresReachable(loadPostgresConfig());

  const config = loadWearablesConfig();

  const userId = await getOrCreateUserId(config);
  const authorizationUrl = await getAuthorizationUrl(config, provider, userId, REDIRECT_URI);

  console.log(`Open this URL in your browser to connect ${provider}:`);
  console.log(authorizationUrl);

  const callback = await waitForConnectCallback(REDIRECT_URI);

  Bun.spawn(["open", authorizationUrl]);

  try {
    await callback.result;
  } finally {
    callback.stop();
  }

  console.log(`${provider} connected. Running first sync...`);
  const countsByType = await syncWearables(config, userId);

  for (const [type, count] of Object.entries(countsByType)) {
    console.log(`${type}: ${count} reading(s) stored`);
  }
  console.log("Connect + sync complete.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
