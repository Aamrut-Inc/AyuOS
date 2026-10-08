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
import { AttachmentStore } from "../load/attachment-store";
import { runTransform } from "../transform/run";
import { loginPage, wearablesDataPage, ehrDataPage } from "./pages";
import { Scheduler } from "./scheduler";
import { recordPage } from "./record";
import { importLabPdf, reparseLabPdf } from "./lab-import";
import { warmPdfReader } from "../extract/lab-pdf/pdf-text";
import { LAB_DROPZONE_SCRIPT, labReviewPage, labsPage, labUploadCard } from "./lab-pages";
import { LabStore, type ReviewedResult } from "../load/lab-store";
import { parseReference, parseValue } from "../transform/lab-results";
import { ensureStack } from "./stack";

const PORT = Number(process.env.AYUOS_PORT ?? 3000);
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
      const labs = new LabStore(loadPostgresConfig());
      let jobs;
      let labDocs;
      try {
        jobs = await runs.summaries();
        labDocs = await labs.listDocuments();
      } finally {
        await runs.close();
        await labs.close();
      }
      const labCard = labUploadCard(
        labDocs.filter((d) => d.status === "needs_review").length,
        labDocs.reduce((sum, d) => sum + d.confirmed, 0)
      );

      return html(
        loginPage(connections, ehrConnected, {
          ehrLastFetched,
          ehrResourceCount,
          lastReadingByProvider,
          jobs,
          syncing: url.searchParams.get("syncing") === "1",
          extraCards: labCard,
          extraScript: LAB_DROPZONE_SCRIPT
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
            const attachments = new AttachmentStore(postgresConfig);
            let fetched: Record<string, number>;
            try {
              fetched = await importEhr(providerConfig, token, patientId, store, attachments);
            } finally {
              await store.close();
              await attachments.close();
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

    if (url.pathname === "/record") {
      return html(await recordPage(loadPostgresConfig(), wearablesConfig.userId));
    }

    const attachmentMatch = url.pathname.match(/^\/attachments\/(\d+)$/);
    if (attachmentMatch) {
      const sql = new SQL(loadPostgresConfig().connectionString);
      try {
        const [row] = await sql`
          SELECT file_path, content_type FROM clinical.fhir_attachments
          WHERE id = ${Number(attachmentMatch[1])} AND file_path IS NOT NULL
        `;
        if (!row) return new Response("Not found", { status: 404 });
        return new Response(Bun.file(row.file_path), {
          headers: {
            "content-type": row.content_type ?? "application/octet-stream",
            // Clinical notes are HTML from an outside system: show, never run.
            "content-security-policy": "sandbox",
            "x-content-type-options": "nosniff"
          }
        });
      } finally {
        await sql.close();
      }
    }

    if (url.pathname === "/upload/lab-pdf" && req.method === "POST") {
      try {
        const formData = await req.formData();
        const files = formData.getAll("file").filter((f): f is File => f instanceof File);
        if (files.length === 0) {
          return Response.json({ error: "No file uploaded" }, { status: 400 });
        }
        const documents = [];
        for (const file of files) {
          documents.push(
            await recordRun("lab-pdf-upload", "manual", async () =>
              importLabPdf(loadPostgresConfig(), file.name, new Uint8Array(await file.arrayBuffer()))
            )
          );
        }
        return Response.json({ documents });
      } catch (error) {
        console.error("Lab PDF upload failed:", error instanceof Error ? error.message : error);
        return Response.json(
          { error: error instanceof Error ? error.message : "Upload failed" },
          { status: 500 }
        );
      }
    }

    if (url.pathname === "/labs") {
      const labs = new LabStore(loadPostgresConfig());
      try {
        return html(labsPage(await labs.listDocuments(), await labs.confirmedResults()));
      } finally {
        await labs.close();
      }
    }

    const labMatch = url.pathname.match(/^\/labs\/(\d+)(\/file|\/review|\/reparse)?$/);
    if (labMatch) {
      const documentId = Number(labMatch[1]);
      const action = labMatch[2];
      const labs = new LabStore(loadPostgresConfig());
      try {
        const doc = await labs.getDocument(documentId);
        if (!doc) return new Response("Not found", { status: 404 });

        if (action === "/file") {
          return new Response(Bun.file(doc.file_path), {
            headers: {
              "content-type": "application/pdf",
              "content-disposition": `inline; filename="${doc.filename.replace(/"/g, "")}"`
            }
          });
        }

        if (action === "/reparse" && req.method === "POST") {
          await reparseLabPdf(loadPostgresConfig(), documentId).catch((error) => {
            console.error("Lab PDF re-read failed:", error instanceof Error ? error.message : error);
          });
          return Response.redirect(`http://127.0.0.1:${PORT}/labs/${documentId}`, 303);
        }

        if (action === "/review" && req.method === "POST") {
          const form = await req.formData();
          const field = (name: string) => String(form.get(name) ?? "").trim();
          const collectedDate = /^\d{4}-\d{2}-\d{2}$/.test(field("collected_date")) ? field("collected_date") : null;
          const reviewed: ReviewedResult[] = (await labs.resultsForDocument(documentId)).map((r) => {
            const value = parseValue(field(`value_${r.id}`));
            const ref = parseReference(field(`ref_${r.id}`));
            const flag = field(`flag_${r.id}`);
            return {
              id: r.id,
              accept: form.get(`accept_${r.id}`) === "on",
              analyteName: field(`name_${r.id}`) || r.analyte_name,
              valueNum: value.valueNum,
              valueText: value.valueText,
              comparator: value.comparator,
              unit: field(`unit_${r.id}`) || null,
              refText: ref.refText,
              refLow: ref.refLow,
              refHigh: ref.refHigh,
              flag: ["H", "L", "A"].includes(flag) ? flag : null
            };
          });
          await labs.saveReview(documentId, collectedDate, reviewed);
          return Response.redirect(`http://127.0.0.1:${PORT}/labs`, 303);
        }

        return html(labReviewPage(doc, await labs.resultsForDocument(documentId)));
      } finally {
        await labs.close();
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
warmPdfReader().catch((error) => {
  console.warn("Lab PDF reader unavailable:", error instanceof Error ? error.message : error);
});
// Off for test instances pointed at a scratch database.
if (process.env.AYUOS_DISABLE_SCHEDULER !== "1") await scheduler.start();
