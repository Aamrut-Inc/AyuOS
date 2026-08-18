import { loadWearablesConfig, requireUserId } from "../extract/wearables/config";
import { syncWearables } from "../extract/wearables/sync";
import { loadPostgresConfig, assertPostgresReachable } from "../load/config";

async function main(): Promise<void> {
  await assertPostgresReachable(loadPostgresConfig());

  const config = loadWearablesConfig();
  const userId = requireUserId(config);

  const countsByType = await syncWearables(config, userId);

  for (const [type, count] of Object.entries(countsByType)) {
    console.log(`${type}: ${count} reading(s) stored`);
  }
  console.log("Import complete.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
