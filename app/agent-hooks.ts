import { SQL } from "bun";
import { loadPostgresConfig } from "../load/config";
import { afterClinicalData, afterWearableData, nightly } from "../agent/jobs/index";

// The health agent's background work, hooked into the app's sync code. None
// of it may fail the sync that triggered it: errors are logged and the next
// sync or the nightly run catches up. The agent schema only exists after
// `bun run migrate` (run by the installer), so a missing schema is skipped.

async function withMain<T>(work: (main: SQL) => Promise<T>): Promise<T | null> {
  const main = new SQL(loadPostgresConfig().connectionString);
  try {
    const [schema] = await main`SELECT 1 AS ok FROM pg_namespace WHERE nspname = 'agent'`;
    if (!schema) return null;
    return await work(main);
  } finally {
    await main.close();
  }
}

function logFailure(what: string) {
  return (error: unknown) => {
    console.error(`Agent ${what} failed:`, error instanceof Error ? error.message : error);
    return null;
  };
}

// After an Oura/Whoop sync or an Apple Health upload: rebuild the offset
// history and refresh the daily view (4.6, 5.2).
export function agentAfterWearableSync(): Promise<unknown> {
  return withMain(afterWearableData).catch(logFailure("refresh after wearable sync"));
}

// After an EHR import: extract text of newly downloaded notes (14.1).
export function agentAfterEhrImport(): Promise<unknown> {
  return withMain(afterClinicalData).catch(logFailure("note extraction after EHR import"));
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Nightly: everything above plus log retention (16.2).
export const agentNightlyJob = {
  name: "agent-nightly",
  intervalMs: DAY_MS,
  // Lets the wearable syncs that run on wake/start go first.
  wakeDelayMs: 5 * 60 * 1000,
  run: async () => (await withMain(nightly)) ?? { skipped: "agent schema not migrated" }
};
