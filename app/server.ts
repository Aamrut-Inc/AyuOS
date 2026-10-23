import { SQL } from "bun";
import { syncProvider } from "../extract/wearables/sync";
import { authorizeUrl } from "../extract/wearables/oauth";
import {
  credentialsFor,
  isWearableProvider,
  localUserId,
  PROVIDERS,
  saveCredentials,
  type WearableProvider
} from "../extract/wearables/providers";
import { WearableConnectionStore } from "../load/wearable-connections";
import { newLoginState, startWearableCallbackServer } from "./wearable-callback";
import { parseVitalsFromZip } from "../extract/apple-health/parse-vitals";
import { TimeseriesStore } from "../load/timeseries";
import { loadProviderConfig, type Hospital } from "../extract/ehr/config";
import { checkClientKnown } from "../extract/ehr/auth/check-client";
import { EhrConnectionStore } from "../load/ehr-connections";
import {
  findDirectoryHospital,
  hospitalPickerPage,
  hospitalUnavailablePage,
  hospitalsCard
} from "./hospital-pages";
import { beginSmartOAuth, type PendingAuthorization } from "../extract/ehr/auth/smart-oauth";
import { importEhr, requirePatientId } from "../extract/ehr/sync";
import { loadPostgresConfig } from "../load/config";
import { SyncRunStore } from "../load/sync-runs";
import { RawFhirStore } from "../load/raw-store";
import { AttachmentStore } from "../load/attachment-store";
import { runTransform } from "../transform/run";
import { loginPage, wearablesDataPage, ehrDataPage, wearableConnectErrorPage, wearableSetupPage } from "./pages";
import { Scheduler } from "./scheduler";
import { recordPage } from "./record";
import { helpPage } from "./help-page";
import { importLabPdf, reparseLabPdf } from "./lab-import";
import { warmPdfReader } from "../extract/lab-pdf/pdf-text";
import { LAB_DROPZONE_SCRIPT, labReviewPage, labsPage, labUploadCard } from "./lab-pages";
import { LabStore, type ReviewedResult } from "../load/lab-store";
import { parseReference, parseValue } from "../transform/lab-results";
import { ensureStack } from "./stack";
import { freeDiskBytes } from "../shared/disk";
import { ensurePrivateDataDir, fileVaultOn } from "../shared/data-protection";

const PORT = Number(process.env.AYUOS_PORT ?? 3000);
const userId = localUserId();

ensurePrivateDataDir();

try {
  await ensureStack();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1); // the login agent restarts us and we try again
}

// A hospital configured the old way (FHIR_BASE_URL in .env) shows up in the
// hospital list like one picked in the app, keeping its source name.
async function seedHospitalFromEnv(): Promise<void> {
  const baseUrl = process.env.FHIR_BASE_URL?.trim();
  if (!baseUrl) return;
  const store = new EhrConnectionStore(loadPostgresConfig());
  try {
    if ((await store.list()).length > 0) return;
    const config = loadProviderConfig();
    const listed = findDirectoryHospital(config.fhirBaseUrl);
    await store.add(listed?.name ?? config.name, config.fhirBaseUrl, listed?.sandbox ?? false, config.name);
  } catch (error) {
    console.warn("Could not add the .env hospital:", error instanceof Error ? error.message : error);
  } finally {
    await store.close();
  }
}
await seedHospitalFromEnv();

// Only one EHR OAuth attempt can hold the local callback port (8765) at a
// time. If a previous /connect/ehr click never completed (user navigated
// away, refreshed, clicked twice), cancel it before starting a new one —
// otherwise the next attempt fails with EADDRINUSE.
let pendingEhrAuth: PendingAuthorization | null = null;

// Oura and Whoop are pulled directly, each on its own schedule and resume
// point; a wake from sleep runs both straight away (see Scheduler).
const WEARABLE_SYNC_INTERVAL_MS = 30 * 60 * 1000;

function wearableJob(provider: WearableProvider) {
  return {
    name: `wearables-${provider}`,
    intervalMs: WEARABLE_SYNC_INTERVAL_MS,
    run: async () => {
      const store = new WearableConnectionStore(loadPostgresConfig());
      try {
        const connection = (await store.list()).find((c) => c.provider === provider);
        if (!connection) return { skipped: "not connected" };
        if (connection.status === "needs_reconnect") {
          throw new Error(`${PROVIDERS[provider].name}'s login expired or was revoked — click Reconnect on the home page.`);
        }
        return await syncProvider(store, provider, userId);
      } finally {
        await store.close();
      }
    }
  };
}

const scheduler = new Scheduler(loadPostgresConfig(), [wearableJob("oura"), wearableJob("whoop")]);

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

    // Only this machine's own pages may talk to the app. A Host check stops
    // DNS rebinding (an outside domain re-pointed at 127.0.0.1 reading the
    // health record); an Origin check stops other sites' forms from posting
    // uploads/reviews here (CSRF).
    const allowedHosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
    if (!allowedHosts.has(req.headers.get("host") ?? "")) {
      return new Response("Forbidden", { status: 403 });
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      const origin = req.headers.get("origin");
      const site = req.headers.get("sec-fetch-site");
      const sameOrigin = origin
        ? [...allowedHosts].some((h) => origin === `http://${h}`)
        : site === null || site === "same-origin" || site === "none";
      if (!sameOrigin) return new Response("Forbidden", { status: 403 });
    }

    if (url.pathname === "/") {
      const wearables = new WearableConnectionStore(loadPostgresConfig());
      let connections;
      try {
        connections = await wearables.list();
      } finally {
        await wearables.close();
      }

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
      const hospitals = new EhrConnectionStore(loadPostgresConfig());
      let hospitalConnections;
      try {
        hospitalConnections = await hospitals.list();
      } finally {
        await hospitals.close();
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
          freeDiskBytes: freeDiskBytes(),
          fileVaultOn: fileVaultOn(),
          syncing: url.searchParams.get("syncing") === "1",
          hospitalsCard: hospitalsCard(hospitalConnections),
          wearablesConfigured: { oura: credentialsFor("oura") !== null, whoop: credentialsFor("whoop") !== null },
          checklist: {
            wearable: connections.some((c) => c.status === "active"),
            hospital: hospitalConnections.some((c) => c.lastImportStatus === "success"),
            labs: labDocs.length > 0
          },
          extraCards: labCard,
          extraScript: LAB_DROPZONE_SCRIPT
        })
      );
    }

    const connectMatch = url.pathname.match(/^\/connect\/(oura|whoop)$/);
    if (connectMatch) {
      const provider = connectMatch[1] as WearableProvider;
      if (!credentialsFor(provider)) {
        return Response.redirect(`http://127.0.0.1:${PORT}/setup/wearables?then=${provider}`, 302);
      }
      return Response.redirect(authorizeUrl(provider, newLoginState(provider)), 302);
    }

    if (url.pathname === "/setup/wearables") {
      const configured = { oura: credentialsFor("oura") !== null, whoop: credentialsFor("whoop") !== null };
      if (req.method !== "POST") {
        const then = url.searchParams.get("then");
        return html(wearableSetupPage(configured, then && isWearableProvider(then) ? then : null));
      }

      const form = await req.formData();
      const field = (name: string) => String(form.get(name) ?? "").trim();
      const then = field("then");
      const next = isWearableProvider(then) ? then : null;
      for (const provider of ["oura", "whoop"] as const) {
        const clientId = field(`${provider}_client_id`);
        const clientSecret = field(`${provider}_client_secret`);
        if (!clientId && !clientSecret) continue;
        if (!clientId || !clientSecret) {
          return html(wearableSetupPage(configured, next, `Enter both the ${PROVIDERS[provider].name} client ID and the client secret.`));
        }
        try {
          saveCredentials(provider, { clientId, clientSecret });
        } catch (error) {
          return html(wearableSetupPage(configured, next, error instanceof Error ? error.message : String(error)));
        }
      }
      // Straight on to the provider's login when setup was started from a Connect button.
      if (next && credentialsFor(next)) return Response.redirect(`http://127.0.0.1:${PORT}/connect/${next}`, 303);
      return Response.redirect(`http://127.0.0.1:${PORT}/`, 303);
    }

    if (url.pathname === "/connect/wearables/callback") {
      // Only reached with an error now: successful logins go straight home
      // (see app/wearable-callback.ts).
      return html(
        wearableConnectErrorPage(
          url.searchParams.get("provider") ?? "the device",
          url.searchParams.get("error") ?? "unknown_error",
          url.searchParams.get("error_description")
        )
      );
    }

    if (url.pathname === "/sync/now" && req.method === "POST") {
      void scheduler.runNow("wearables-oura", "manual");
      void scheduler.runNow("wearables-whoop", "manual");
      return Response.redirect(`http://127.0.0.1:${PORT}/?syncing=1`, 303);
    }

    if (url.pathname === "/api/status") {
      const runs = new SyncRunStore(loadPostgresConfig());
      try {
        return Response.json({ jobs: await runs.summaries(), freeDiskBytes: freeDiskBytes() });
      } finally {
        await runs.close();
      }
    }

    if (url.pathname === "/hospitals") {
      const store = new EhrConnectionStore(loadPostgresConfig());
      try {
        return html(hospitalPickerPage(await store.list()));
      } finally {
        await store.close();
      }
    }

    if (url.pathname === "/hospitals/add" && req.method === "POST") {
      const form = await req.formData();
      const listed = findDirectoryHospital(String(form.get("url") ?? ""));
      if (!listed) return new Response("Unknown hospital", { status: 400 });

      const hospital: Hospital = { slug: "check", fhirBaseUrl: listed.url, sandbox: Boolean(listed.sandbox) };
      // Check Epic has rolled the app out there before sending the user to a
      // login page that would only show "an error has occurred". If we can't
      // ask (e.g. a US-only hospital from abroad), let them try anyway.
      const status = await checkClientKnown(loadProviderConfig(hospital));
      if (status === "unknown" || status === "rejected") {
        return html(hospitalUnavailablePage(listed.name, status));
      }

      const store = new EhrConnectionStore(loadPostgresConfig());
      try {
        const slug = await store.add(listed.name, listed.url, Boolean(listed.sandbox));
        return Response.redirect(`http://127.0.0.1:${PORT}/connect/ehr?hospital=${encodeURIComponent(slug)}`, 303);
      } finally {
        await store.close();
      }
    }

    if (url.pathname === "/connect/ehr") {
      const store = new EhrConnectionStore(loadPostgresConfig());
      let connection;
      try {
        const slug = url.searchParams.get("hospital");
        const all = await store.list();
        connection = slug ? all.find((c) => c.slug === slug) : all.length === 1 ? all[0] : undefined;
      } finally {
        await store.close();
      }
      if (!connection) return Response.redirect(`http://127.0.0.1:${PORT}/hospitals`, 302);

      if (pendingEhrAuth) {
        pendingEhrAuth.cancel();
        pendingEhrAuth = null;
      }

      const providerConfig = loadProviderConfig(connection);
      const pending = await beginSmartOAuth(
        providerConfig,
        `http://127.0.0.1:${PORT}/?syncing=1`
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

    if (url.pathname === "/help") {
      return html(helpPage());
    }

    if (url.pathname === "/record") {
      return html(await recordPage(loadPostgresConfig(), userId));
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

// Oura/Whoop logins come back here; pull the new device's history right away.
startWearableCallbackServer(`http://127.0.0.1:${PORT}`, (provider) => {
  void scheduler.runNow(`wearables-${provider}`, "connect");
});
warmPdfReader().catch((error) => {
  console.warn("Lab PDF reader unavailable:", error instanceof Error ? error.message : error);
});
// Off for test instances pointed at a scratch database.
if (process.env.AYUOS_DISABLE_SCHEDULER !== "1") await scheduler.start();
