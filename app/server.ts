import { SQL } from "bun";
import { loadWearablesConfig } from "../extract/wearables/config";
import { getOrCreateUserId } from "../extract/wearables/provision";
import { getConnections, getAuthorizationUrl, type WearableProvider } from "../extract/wearables/oauth";
import { syncWearables } from "../extract/wearables/sync";
import { requestProviderSync } from "../extract/wearables/client";
import { parseVitalsFromZip } from "../extract/apple-health/parse-vitals";
import { TimeseriesStore } from "../load/timeseries";
import { loadProviderConfig } from "../extract/ehr/config";
import { beginSmartOAuth, type PendingAuthorization } from "../extract/ehr/auth/smart-oauth";
import { importEhr, requirePatientId } from "../extract/ehr/sync";
import { loadPostgresConfig } from "../load/config";
import { SyncRunStore } from "../load/sync-runs";
import { RawFhirStore } from "../load/raw-store";
import { runTransform } from "../transform/run";
import { loginPage, wearablesDataPage, ehrDataPage } from "./pages";
import { Scheduler } from "./scheduler";
import { ensureStack } from "./stack";

const PORT = 3000;
const wearablesConfig = loadWearablesConfig();

try {
  await ensureStack(loadPostgresConfig());
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1); // the login agent restarts us and we try again
}

// Only one EHR OAuth attempt can hold the local callback port (8765) at a
// time. If a previous /connect/ehr click never completed (user navigated
// away, refreshed, clicked twice), cancel it before starting a new one —
// otherwise the next attempt fails with EADDRINUSE.
let pendingEhrAuth: PendingAuthorization | null = null;

const WEARABLES_MIRROR_INTERVAL_MS = 15 * 60 * 1000;
// Give the backend's provider pull (nudged on wake) time to land before
// copying from it.
const WEARABLES_MIRROR_WAKE_DELAY_MS = 3 * 60 * 1000;

const scheduler = new Scheduler(loadPostgresConfig(), [
  {
    // The backend polls Oura/Whoop hourly on its own; after the laptop wakes,
    // nudge it so the gap is filled now instead of up to an hour later.
    name: "wearables-provider-pull",
    intervalMs: Infinity,
    onWakeOnly: true,
    run: async () => {
      if (!wearablesConfig.userId) return { skipped: "no wearables user yet" };
      const connections = await getConnections(wearablesConfig, wearablesConfig.userId);
      const providers = connections.filter((c) => c.status === "active").map((c) => c.provider);
      for (const provider of providers) {
        await requestProviderSync(wearablesConfig, provider, wearablesConfig.userId);
      }
      return { requested: providers };
    }
  },
  {
    // Copies new readings from the wearables backend into timeseries.readings.
    name: "wearables-mirror",
    intervalMs: WEARABLES_MIRROR_INTERVAL_MS,
    wakeDelayMs: WEARABLES_MIRROR_WAKE_DELAY_MS,
    run: async () => {
      if (!wearablesConfig.userId) return { skipped: "no wearables user yet" };
      return syncWearables(wearablesConfig, wearablesConfig.userId);
    }
  }
]);

// One-off, user-triggered work (EHR import, Apple Health upload) is logged to
// the same run history as scheduled jobs so the status panel covers both.
async function recordRun<T>(job: string, trigger: string, work: () => Promise<T>): Promise<T> {
  const runs = new SyncRunStore(loadPostgresConfig());
  const runId = await runs.start(job, trigger);
  try {
    const result = await work();
    await runs.succeed(runId, result);
    return result;
  } catch (error) {
    await runs.fail(runId, error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    await runs.close();
  }
}

function html(body: string): Response {
  return new Response(body, { headers: { "content-type": "text/html" } });
}

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/") {
      const userId = await getOrCreateUserId(wearablesConfig);
      const connections = await getConnections(wearablesConfig, userId);

      const sql = new SQL(loadPostgresConfig().connectionString);
      let ehrConnected = false;
      let ehrLastFetched: string | null = null;
      let ehrResourceCount = 0;
      const lastReadingByProvider = new Map<string, string>();
      try {
        const [ehrRow] = await sql`
          SELECT count(*) AS n, max(fetched_at) AS latest
          FROM clinical.fhir_resources WHERE is_current
        `;
        ehrResourceCount = Number(ehrRow?.n ?? 0);
        ehrConnected = ehrResourceCount > 0;
        ehrLastFetched = ehrRow?.latest ?? null;

        const readingRows = await sql`
          SELECT source_provider, max(ts) AS latest
          FROM timeseries.readings WHERE user_id = ${userId}
          GROUP BY source_provider
        `;
        for (const row of readingRows) {
          lastReadingByProvider.set(row.source_provider, row.latest);
        }
      } finally {
        await sql.close();
      }

      const runs = new SyncRunStore(loadPostgresConfig());
      let jobs;
      try {
        jobs = await runs.summaries();
      } finally {
        await runs.close();
      }

      return html(
        loginPage(connections, ehrConnected, {
          ehrLastFetched,
          ehrResourceCount,
          lastReadingByProvider,
          jobs,
          syncing: url.searchParams.get("syncing") === "1"
        })
      );
    }

    const simulateMatch = url.pathname.match(/^\/simulate\/(oura|whoop)$/);
    if (simulateMatch) {
      const provider = simulateMatch[1] as WearableProvider;
      void provider; // both providers trigger the same full sync — see plan notes
      await getOrCreateUserId(wearablesConfig);
      void scheduler.runNow("wearables-mirror", "manual");
      return Response.redirect(`http://127.0.0.1:${PORT}/data/wearables?syncing=1`, 302);
    }

    const connectMatch = url.pathname.match(/^\/connect\/(oura|whoop)$/);
    if (connectMatch) {
      const provider = connectMatch[1] as WearableProvider;
      const userId = await getOrCreateUserId(wearablesConfig);
      const authorizeUrl = await getAuthorizationUrl(
        wearablesConfig,
        provider,
        userId,
        `http://127.0.0.1:${PORT}/connect/wearables/callback`
      );
      return Response.redirect(authorizeUrl, 302);
    }

    if (url.pathname === "/connect/wearables/callback") {
      // The wearables service just finished OAuth and bounced the browser back
      // here. Pull the newly-synced data into AyuOS's own timeseries.readings —
      // without this, the connection succeeds server-side but never shows up
      // in our own UI, which reads from our local copy, not the wearables DB.
      await getOrCreateUserId(wearablesConfig);
      void scheduler.runNow("wearables-mirror", "connect");
      return Response.redirect(`http://127.0.0.1:${PORT}/data/wearables?syncing=1`, 302);
    }

    if (url.pathname === "/sync/now" && req.method === "POST") {
      void scheduler
        .runNow("wearables-provider-pull", "manual")
        .finally(() => Bun.sleep(WEARABLES_MIRROR_WAKE_DELAY_MS))
        .then(() => scheduler.runNow("wearables-mirror", "manual"));
      return Response.redirect(`http://127.0.0.1:${PORT}/?syncing=1`, 303);
    }

    if (url.pathname === "/api/status") {
      const runs = new SyncRunStore(loadPostgresConfig());
      try {
        return Response.json({ jobs: await runs.summaries() });
      } finally {
        await runs.close();
      }
    }

    if (url.pathname === "/connect/ehr") {
      if (pendingEhrAuth) {
        pendingEhrAuth.cancel();
        pendingEhrAuth = null;
      }

      const providerConfig = loadProviderConfig();
      const pending = await beginSmartOAuth(
        providerConfig,
        `http://127.0.0.1:${PORT}/data/ehr?syncing=1`
      );
      pendingEhrAuth = pending;

      pending
        .waitForToken()
        .then(async (token) => {
          await recordRun(`ehr-import:${providerConfig.name}`, "manual", async () => {
            const patientId = requirePatientId(token.patient);
            const postgresConfig = loadPostgresConfig();
            const store = new RawFhirStore(postgresConfig);
            let fetched: Record<string, number>;
            try {
              fetched = await importEhr(providerConfig, token, patientId, store);
            } finally {
              await store.close();
            }
            // Keep clinical.patient/observation/etc. in sync with the raw data
            // we just stored — without this, new data silently doesn't show up
            // in the structured tables until someone remembers to run it by hand.
            const transformed = await runTransform(postgresConfig);
            return { fetched, transformed };
          });
        })
        .catch((error) => {
          console.error("Background EHR import failed:", error instanceof Error ? error.message : error);
        })
        .finally(() => {
          if (pendingEhrAuth === pending) pendingEhrAuth = null;
        });

      return Response.redirect(pending.authorizeUrl, 302);
    }

    if (url.pathname === "/upload/apple-health" && req.method === "POST") {
      try {
        const formData = await req.formData();
        const file = formData.get("file");
        if (!(file instanceof File)) {
          return new Response("No file uploaded", { status: 400 });
        }

        const userId = await getOrCreateUserId(wearablesConfig);
        const zipData = Buffer.from(await file.arrayBuffer());
        const { stored } = await recordRun("apple-health-upload", "manual", async () => {
          const readings = await parseVitalsFromZip(zipData, userId);
          const store = new TimeseriesStore(loadPostgresConfig());
          try {
            const BATCH_SIZE = 500; // keep bulk INSERT parameter count well under Postgres's limit
            for (let i = 0; i < readings.length; i += BATCH_SIZE) {
              await store.upsertReadings(readings.slice(i, i + BATCH_SIZE));
            }
          } finally {
            await store.close();
          }
          return { stored: readings.length };
        });

        return new Response(JSON.stringify({ stored }), {
          headers: { "content-type": "application/json" }
        });
      } catch (error) {
        console.error("Apple Health upload failed:", error instanceof Error ? error.message : error);
        return new Response(
          JSON.stringify({ error: error instanceof Error ? error.message : "Upload failed" }),
          { status: 500, headers: { "content-type": "application/json" } }
        );
      }
    }

    if (url.pathname === "/data/wearables") {
      const userId = await getOrCreateUserId(wearablesConfig);
      const source = url.searchParams.get("source"); // null = all sources
      const sql = new SQL(loadPostgresConfig().connectionString);
      try {
        const bySource = await sql`
          SELECT source_provider, count(*)::int AS count
          FROM timeseries.readings
          WHERE user_id = ${userId}
          GROUP BY source_provider
          ORDER BY count DESC
        `;
        const summary = source
          ? await sql`
              SELECT metric_type, count(*)::int AS count
              FROM timeseries.readings
              WHERE user_id = ${userId} AND source_provider = ${source}
              GROUP BY metric_type
              ORDER BY count DESC
            `
          : await sql`
              SELECT metric_type, count(*)::int AS count
              FROM timeseries.readings
              WHERE user_id = ${userId}
              GROUP BY metric_type
              ORDER BY count DESC
            `;
        const rows = source
          ? await sql`
              SELECT metric_type, ts, value, unit, source_provider
              FROM timeseries.readings
              WHERE user_id = ${userId} AND source_provider = ${source}
              ORDER BY ts DESC
              LIMIT 100
            `
          : await sql`
              SELECT metric_type, ts, value, unit, source_provider
              FROM timeseries.readings
              WHERE user_id = ${userId}
              ORDER BY ts DESC
              LIMIT 100
            `;
        const syncing = url.searchParams.get("syncing") === "1";
        return html(
          wearablesDataPage(rows as any, summary as any, bySource as any, source, syncing)
        );
      } finally {
        await sql.close();
      }
    }

    if (url.pathname === "/data/ehr") {
      const sql = new SQL(loadPostgresConfig().connectionString);
      try {
        const summary = await sql`
          SELECT resource_type, count(*)::int AS count
          FROM clinical.fhir_resources
          WHERE is_current
          GROUP BY resource_type
          ORDER BY count DESC
        `;
        const rows = await sql`
          SELECT source, resource_type, resource_id, patient_id, fetched_at
          FROM clinical.fhir_resources
          WHERE is_current
          ORDER BY fetched_at DESC
          LIMIT 100
        `;
        const syncing = url.searchParams.get("syncing") === "1";
        return html(ehrDataPage(rows as any, summary as any, syncing));
      } finally {
        await sql.close();
      }
    }

    return new Response("Not found", { status: 404 });
  }
});

console.log(`AyuOS app running at http://127.0.0.1:${PORT}`);
await scheduler.start();
