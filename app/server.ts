import { SQL } from "bun";
import { loadWearablesConfig } from "../extract/wearables/config";
import { getOrCreateUserId } from "../extract/wearables/provision";
import { getConnections, type WearableProvider } from "../extract/wearables/oauth";
import { syncWearables } from "../extract/wearables/sync";
import { parseVitalsFromZip } from "../extract/apple-health/parse-vitals";
import { TimeseriesStore } from "../load/timeseries";
import { loadProviderConfig } from "../extract/ehr/config";
import { beginSmartOAuth, type PendingAuthorization } from "../extract/ehr/auth/smart-oauth";
import { importEhr, requirePatientId } from "../extract/ehr/sync";
import { loadPostgresConfig } from "../load/config";
import { RawFhirStore } from "../load/raw-store";
import { loginPage, wearablesDataPage, ehrDataPage } from "./pages";

const PORT = 3000;
const wearablesConfig = loadWearablesConfig();

// Only one EHR OAuth attempt can hold the local callback port (8765) at a
// time. If a previous /connect/ehr click never completed (user navigated
// away, refreshed, clicked twice), cancel it before starting a new one —
// otherwise the next attempt fails with EADDRINUSE.
let pendingEhrAuth: PendingAuthorization | null = null;

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
      try {
        const [row] = await sql`
          SELECT EXISTS(SELECT 1 FROM clinical.fhir_resources WHERE is_current) AS connected
        `;
        ehrConnected = Boolean(row?.connected);
      } finally {
        await sql.close();
      }

      return html(loginPage(connections, ehrConnected));
    }

    const simulateMatch = url.pathname.match(/^\/simulate\/(oura|whoop)$/);
    if (simulateMatch) {
      const provider = simulateMatch[1] as WearableProvider;
      void provider; // both providers trigger the same full sync — see plan notes
      const userId = await getOrCreateUserId(wearablesConfig);
      syncWearables(wearablesConfig, userId).catch((error) => {
        console.error("Background wearables sync failed:", error instanceof Error ? error.message : error);
      });
      return Response.redirect(`http://127.0.0.1:${PORT}/data/wearables?syncing=1`, 302);
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
          const patientId = requirePatientId(token.patient);
          const store = new RawFhirStore(loadPostgresConfig());
          try {
            await importEhr(providerConfig, token, patientId, store);
          } finally {
            await store.close();
          }
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

        return new Response(JSON.stringify({ stored: readings.length }), {
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
