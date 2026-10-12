import { syncProvider } from "../extract/wearables/sync";
import { localUserId, type WearableProvider } from "../extract/wearables/providers";
import { loadPostgresConfig } from "../load/config";
import { ensureDatabase } from "../load/database";
import { WearableConnectionStore } from "../load/wearable-connections";

// Pulls new data from every connected wearable (what the app does every 30
// minutes). Connect wearables from the app's home page first.
async function main(): Promise<void> {
  await ensureDatabase();
  const store = new WearableConnectionStore(loadPostgresConfig());
  try {
    const connections = await store.list();
    if (connections.length === 0) console.log("No wearables connected yet — connect them from the AyuOS home page.");
    for (const { provider } of connections) {
      const result = await syncProvider(store, provider as WearableProvider, localUserId());
      console.log(provider, result.readings, result.skipped.length ? `skipped: ${result.skipped.join(", ")}` : "");
    }
  } finally {
    await store.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
