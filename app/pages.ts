import type { WearableConnection } from "../load/wearable-connections";
import type { SyncRunSummary } from "../load/sync-runs";
import { DISK_CRITICAL_BYTES, DISK_WARN_BYTES } from "../shared/disk";

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// One stylesheet for every page. Colors are tokens so dark mode (following
// the Mac's appearance) is a single override block.
const STYLE = `
  :root {
    --bg: #f4f6f6; --card: #ffffff; --text: #1d2524; --muted: #6b7776; --line: #e3e8e7;
    --brand: #1f8f7a; --brand-dark: #146673; --brand-soft: #e3f4f0;
    --ok: #1a7f5a; --ok-soft: #e2f4ec; --warn: #9a6700; --warn-soft: #fff6dd;
    --bad: #c4312b; --bad-soft: #fdecea; --off: #6b7776; --off-soft: #eef1f1;
    --shadow: 0 1px 2px rgba(16, 40, 36, .06), 0 2px 8px rgba(16, 40, 36, .05);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #121716; --card: #1b2220; --text: #e4ebe9; --muted: #95a3a0; --line: #2c3634;
      --brand: #3cb89f; --brand-dark: #2a9a86; --brand-soft: #18332d;
      --ok: #4cc79a; --ok-soft: #173229; --warn: #e3b341; --warn-soft: #33290f;
      --bad: #f2756d; --bad-soft: #3a1c1a; --off: #95a3a0; --off-soft: #242d2b;
      --shadow: none;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  a { color: var(--brand); text-decoration: none; }
  a:hover { text-decoration: underline; }
  main { max-width: 960px; margin: 0 auto; padding: 28px 24px 64px; }
  h1 { font-size: 26px; margin: 0 0 4px; letter-spacing: -0.01em; }
  h2 { font-size: 17px; margin: 28px 0 10px; }
  h3 { font-size: 15px; margin: 0; }
  .lede { color: var(--muted); margin: 0 0 22px; }

  /* Header */
  .topbar { background: var(--card); border-bottom: 1px solid var(--line); position: sticky; top: 0; z-index: 5; }
  .topbar-inner { max-width: 960px; margin: 0 auto; padding: 12px 24px; display: flex; align-items: center; gap: 24px; }
  .brand { display: flex; align-items: center; gap: 10px; color: var(--text); }
  .brand:hover { text-decoration: none; }
  .brand-name { font-size: 20px; font-weight: 700; letter-spacing: -0.02em; }
  .brand-name span { color: var(--brand); }
  .nav { display: flex; gap: 4px; margin-left: auto; flex-wrap: wrap; }
  .nav a { color: var(--muted); padding: 6px 12px; border-radius: 8px; font-size: 14px; font-weight: 500; }
  .nav a:hover { background: var(--off-soft); color: var(--text); text-decoration: none; }
  .nav a.active { background: var(--brand-soft); color: var(--brand); }

  /* Cards and layout */
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 18px 20px; box-shadow: var(--shadow); margin-bottom: 14px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 14px; }
  .grid .card { margin-bottom: 0; display: flex; flex-direction: column; }
  .card-head { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
  .card-head .pill { margin-left: auto; }
  .card-actions { margin-top: auto; padding-top: 12px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .icon { width: 36px; height: 36px; border-radius: 10px; display: grid; place-items: center; font-size: 18px; background: var(--brand-soft); flex: none; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }

  /* Buttons, pills, alerts */
  .btn, a.button, button.button { display: inline-block; background: var(--brand); color: #fff; border: 0; border-radius: 9px;
    padding: 8px 16px; font-family: inherit; font-size: 14px; font-weight: 600; line-height: 1.3; cursor: pointer; text-decoration: none; }
  .btn:hover, a.button:hover, button.button:hover { background: var(--brand-dark); text-decoration: none; }
  .btn.secondary { background: var(--off-soft); color: var(--text); }
  .btn.secondary:hover { background: var(--line); }
  .btn.big { padding: 11px 20px; font-size: 15px; }
  .pill { display: inline-block; font-size: 12px; font-weight: 600; padding: 3px 10px; border-radius: 999px; white-space: nowrap; }
  .pill.ok { background: var(--ok-soft); color: var(--ok); }
  .pill.warn { background: var(--warn-soft); color: var(--warn); }
  .pill.bad { background: var(--bad-soft); color: var(--bad); }
  .pill.off { background: var(--off-soft); color: var(--off); }
  .alert { border-radius: 12px; padding: 12px 16px; margin-bottom: 14px; font-size: 14px; border: 1px solid transparent; }
  .alert.warn { background: var(--warn-soft); border-color: color-mix(in srgb, var(--warn) 30%, transparent); }
  .alert.bad { background: var(--bad-soft); border-color: color-mix(in srgb, var(--bad) 30%, transparent); }
  .alert.ok { background: var(--ok-soft); }

  /* Setup steps */
  .steps { list-style: none; margin: 0; padding: 0; }
  .step { display: flex; gap: 14px; padding: 14px 0; border-top: 1px solid var(--line); align-items: flex-start; }
  .step:first-child { border-top: 0; padding-top: 4px; }
  .step-num { width: 30px; height: 30px; border-radius: 50%; flex: none; display: grid; place-items: center;
    font-weight: 700; font-size: 14px; background: var(--off-soft); color: var(--muted); }
  .step.done .step-num { background: var(--ok-soft); color: var(--ok); }
  .step.next .step-num { background: var(--brand); color: #fff; }
  .step-body { flex: 1; }
  .step-body p { margin: 2px 0 0; color: var(--muted); font-size: 14px; }
  .step.done h3 { color: var(--muted); }
  .step-action { flex: none; align-self: center; }

  /* Tables, text, misc (shared with older pages) */
  table { border-collapse: collapse; width: 100%; margin-top: 8px; background: var(--card); }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); font-size: 13px; vertical-align: top; }
  th { color: var(--muted); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: .03em; }
  .meta { color: var(--muted); font-size: 13px; margin: 4px 0 12px; }
  .warning { color: var(--warn); font-size: 13px; margin: 6px 0 0; }
  .failing { color: var(--bad); }
  .connected { color: var(--ok); font-weight: 600; font-size: 13px; }
  .source-row { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 16px 20px; margin-bottom: 14px;
    display: flex; align-items: center; justify-content: space-between; gap: 12px; box-shadow: var(--shadow); }
  .dropzone { border: 2px dashed var(--line); border-radius: 12px; padding: 22px; text-align: center; color: var(--muted);
    font-size: 14px; cursor: pointer; transition: border-color .15s, background .15s; }
  .dropzone:hover, .dropzone.drag-over { border-color: var(--brand); background: var(--brand-soft); color: var(--text); }
  details summary { cursor: pointer; color: var(--muted); font-size: 14px; }
  input, select { font: inherit; color: var(--text); background: var(--card); border: 1px solid var(--line); border-radius: 7px; padding: 5px 8px; }
  code { background: var(--off-soft); padding: 1px 5px; border-radius: 5px; font-size: 13px; }
  .help-section { margin-bottom: 18px; }
  .help-section ol, .help-section ul { padding-left: 22px; margin: 8px 0 0; }
  .help-section li { margin: 6px 0; }
  footer { max-width: 960px; margin: 0 auto; padding: 0 24px 32px; color: var(--muted); font-size: 12px; }
`;

// The app icon, drawn small for the header.
const LOGO_SVG = `<svg width="32" height="32" viewBox="0 0 64 64" aria-hidden="true">
  <defs><linearGradient id="ayu-g" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#29a085"/><stop offset="1" stop-color="#146673"/></linearGradient></defs>
  <rect x="2" y="2" width="60" height="60" rx="15" fill="url(#ayu-g)"/>
  <path d="M32 50 C18 40 12 33 12 24 C12 17 17 13 22.5 13 C26.5 13 30 15.5 32 19 C34 15.5 37.5 13 41.5 13 C47 13 52 17 52 24 C52 33 46 40 32 50 Z" fill="#fff"/>
  <polyline points="17,30 25,30 28,24 32,37 36,26 38,30 47,30" fill="none" stroke="#1a807a" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const NAV: Array<[string, string]> = [
  ["/", "Home"],
  ["/record", "My record"],
  ["/labs", "Lab results"],
  ["/hospitals", "Hospitals"],
  ["/help", "Help"]
];

const DROPZONE_SCRIPT = `
  const zone = document.getElementById('apple-health-dropzone');
  const input = document.getElementById('apple-health-file-input');

  async function uploadFile(file) {
    zone.textContent = 'Uploading ' + file.name + '...';
    const formData = new FormData();
    formData.append('file', file);
    try {
      const res = await fetch('/upload/apple-health', { method: 'POST', body: formData });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error || 'Upload failed');
      zone.textContent = 'Stored ' + payload.stored + ' reading(s). Redirecting...';
      window.location.href = '/data/wearables?syncing=1';
    } catch (err) {
      zone.textContent = 'Upload failed: ' + err.message + ' (drop the file again to retry)';
    }
  }

  if (zone && input) {
    zone.addEventListener('click', () => input.click());
    input.addEventListener('change', () => {
      if (input.files[0]) uploadFile(input.files[0]);
    });

    ['dragenter', 'dragover'].forEach((evt) =>
      zone.addEventListener(evt, (e) => { e.preventDefault(); zone.classList.add('drag-over'); })
    );
    ['dragleave'].forEach((evt) =>
      zone.addEventListener(evt, (e) => { e.preventDefault(); zone.classList.remove('drag-over'); })
    );
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('drag-over');
      if (e.dataTransfer.files[0]) uploadFile(e.dataTransfer.files[0]);
    });
  }
`;

export function layout(title: string, body: string, script = "", active = ""): string {
  const nav = NAV.map(([href, label]) => `<a href="${href}"${href === active ? ' class="active"' : ""}>${label}</a>`).join("");
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<header class="topbar"><div class="topbar-inner">
  <a class="brand" href="/">${LOGO_SVG}<span class="brand-name">Ayu<span>OS</span></span></a>
  <nav class="nav">${nav}</nav>
</div></header>
<main>${body}</main>
<footer>Everything in AyuOS stays on this Mac.</footer>
${script ? `<script>${script}</script>` : ""}
</body>
</html>`;
}

interface LoginPageMeta {
  ehrLastFetched: string | null;
  ehrResourceCount: number;
  lastReadingByProvider: Map<string, string>;
  jobs: SyncRunSummary[];
  syncing: boolean;
  freeDiskBytes: number | null;
  fileVaultOn?: boolean | null;
  hospitalsCard?: string;
  checklist?: { wearable: boolean; hospital: boolean; labs: boolean };
  // Extra source cards (e.g. lab PDF upload) and their client-side script.
  extraCards?: string;
  extraScript?: string;
}

// Wearables sync every 30 minutes; one that hasn't managed to for this long
// has a problem worth surfacing even before its login is known to be dead.
const PROVIDER_STALE_MS = 6 * 60 * 60 * 1000;

const JOB_LABELS: Record<string, string> = {
  "wearables-oura": "Oura",
  "wearables-whoop": "Whoop",
  "apple-health-upload": "Apple Health upload",
  "lab-pdf-upload": "Lab PDF upload"
};

function jobLabel(job: string): string {
  if (job.startsWith("ehr-import:")) return `EHR import (${job.slice("ehr-import:".length)})`;
  return JOB_LABELS[job] ?? job;
}

interface Checklist {
  wearable: boolean;
  hospital: boolean;
  labs: boolean;
}

// The numbered setup guide at the top of the home page. Each step says what
// to do and has a button for it; the first unfinished step is highlighted.
// Once everything is set up it shrinks to a one-line confirmation.
export function setupGuide(checklist: Checklist | undefined): string {
  if (!checklist) return "";
  if (checklist.wearable && checklist.hospital && checklist.labs) {
    return `<div class="alert ok row"><span>✓ <strong>You're all set.</strong> AyuOS keeps your data up to date in the background.</span><a href="/help">Setup guide</a></div>`;
  }

  const steps = [
    {
      done: true,
      title: "AyuOS is running",
      text: "It starts with your Mac and keeps collecting in the background — you never need to open it to stay in sync.",
      action: ""
    },
    {
      done: checklist.wearable,
      title: "Connect your wearable",
      text: "Log into your Oura or Whoop account. Your full history downloads, then new data arrives every 30 minutes.",
      action: `<a class="btn" href="/connect/oura">Connect Oura</a> <a class="btn secondary" href="/connect/whoop">Connect Whoop</a>`
    },
    {
      done: checklist.hospital,
      title: "Add your hospital",
      text: "Find your health system and log in with your MyChart account. Your records — labs, medications, conditions, visits — download to this Mac.",
      action: `<a class="btn" href="/hospitals">Find my hospital</a>`
    },
    {
      done: checklist.labs,
      title: "Add lab reports (optional)",
      text: "Drop lab report PDFs below. AyuOS reads them on this Mac and asks you to check the values before saving.",
      action: `<a class="btn secondary" href="#labs">Upload PDFs</a>`
    },
    {
      done: false,
      title: "See everything in one place",
      text: "Your health record combines all of it: problems, medications, labs, visits and wearable trends.",
      action: `<a class="btn secondary" href="/record">Open my record</a>`
    }
  ];
  const next = steps.findIndex((step) => !step.done);
  const items = steps
    .map(
      (step, i) => `
      <li class="step ${step.done ? "done" : i === next ? "next" : ""}">
        <div class="step-num">${step.done ? "✓" : i + 1}</div>
        <div class="step-body"><h3>${step.title}</h3><p>${step.text}</p></div>
        ${step.done || !step.action ? "" : `<div class="step-action">${step.action}</div>`}
      </li>`
    )
    .join("");

  return `
    <section class="card">
      <div class="row"><h2 style="margin: 0;">Set up AyuOS</h2><a href="/help">Step-by-step guide →</a></div>
      <ol class="steps" style="margin-top: 10px;">${items}</ol>
    </section>`;
}

export function fileVaultNotice(on: boolean | null | undefined): string {
  if (on !== false) return "";
  return `
    <div class="alert warn">
      <strong>Turn on FileVault to encrypt your health data on this Mac.</strong>
      It's off, so anyone with this computer's disk could read the files AyuOS stores.
      Open <a href="x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension">System Settings → Privacy &amp; Security → FileVault</a>
      and click <em>Turn On</em> (keep the recovery key somewhere safe).
    </div>`;
}

export function diskWarning(freeBytes: number | null): string {
  if (freeBytes === null || freeBytes >= DISK_WARN_BYTES) return "";
  const gb = (freeBytes / 2 ** 30).toFixed(1);
  const critical = freeBytes < DISK_CRITICAL_BYTES;
  return `
    <div class="alert ${critical ? "bad" : "warn"}">
      <strong>${critical ? "Your disk is almost full" : "Disk space is running low"}</strong> — ${gb} GB free.
      ${critical ? "Syncing will stop when it fills up." : "Syncing stops if the disk fills up."}
      Free some space (empty the Trash, delete large downloads, or clear app caches).
    </div>`;
}

function syncActivity(jobs: SyncRunSummary[]): string {
  const rows = jobs
    .map((j) => {
      const state =
        j.lastStatus === "running"
          ? `<span class="pill off">Running…</span>`
          : j.lastStatus === "success"
            ? `<span class="pill ok">OK</span>`
            : `<span class="pill bad">Failing${j.consecutiveFailures > 1 ? ` ×${j.consecutiveFailures}` : ""}</span>`;
      const error =
        j.lastStatus === "failed" && j.lastError
          ? `<div class="warning">${escapeHtml(j.lastError.slice(0, 300))}</div>`
          : "";
      return `<tr><td>${escapeHtml(jobLabel(j.job))}</td><td>${state}${error}</td><td>${formatWhen(j.lastSuccessAt)}</td></tr>`;
    })
    .join("");
  const failing = jobs.filter((j) => j.lastStatus === "failed").length;
  return `
    <details class="card" ${failing ? "open" : ""}>
      <summary>Sync activity ${failing ? `<span class="pill bad">${failing} problem${failing > 1 ? "s" : ""}</span>` : `<span class="pill ok">All good</span>`}</summary>
      <p class="meta" style="margin-top: 10px;">Wearables sync every 30 minutes and catch up as soon as your Mac wakes. Hospital records and uploads happen when you start them.</p>
      ${rows ? `<table><tr><th>What</th><th>Status</th><th>Last success</th></tr>${rows}</table>` : `<p class="meta">Nothing has synced yet.</p>`}
    </details>`;
}

function statusPill(kind: "ok" | "warn" | "bad" | "off", text: string): string {
  return `<span class="pill ${kind}">${text}</span>`;
}

export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "never";
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function loginPage(connections: WearableConnection[], ehrConnected: boolean, meta: LoginPageMeta): string {
  void ehrConnected;
  const byProvider = new Map(connections.map((c) => [c.provider as string, c]));

  function wearableCard(provider: "oura" | "whoop", name: string, icon: string): string {
    const connection = byProvider.get(provider);
    const lastReading = meta.lastReadingByProvider.get(provider) ?? null;
    let pill = statusPill("off", "Not connected");
    let note = `<p class="meta">Log in once; AyuOS downloads your full history and keeps it up to date.</p>`;
    let actions = `<a class="btn" href="/connect/${provider}">Connect ${name}</a>`;

    if (connection) {
      const lastSync = connection.lastSyncedAt ?? connection.connectedAt;
      if (connection.status === "needs_reconnect") {
        pill = statusPill("bad", "Needs reconnecting");
        note = `<p class="warning">${name}'s login expired or was revoked, so new data can't be fetched. Reconnect to fix it.</p>`;
        actions = `<a class="btn" href="/connect/${provider}">Reconnect ${name}</a>`;
      } else if (Date.now() - new Date(lastSync).getTime() > PROVIDER_STALE_MS) {
        pill = statusPill("warn", "Not syncing");
        note = `<p class="warning">No successful sync since ${formatWhen(lastSync)}${
          connection.lastError ? ` — ${escapeHtml(connection.lastError.slice(0, 160))}` : ""
        }</p>`;
        actions = `<a class="btn secondary" href="/connect/${provider}">Reconnect</a>`;
      } else {
        pill = statusPill("ok", "Connected");
        note = `<p class="meta">Synced ${formatWhen(lastSync)} · newest reading ${formatWhen(lastReading)}</p>`;
        actions = `<a class="btn secondary" href="/data/wearables?source=${provider}">View data</a>`;
      }
    }
    return `
      <div class="card">
        <div class="card-head"><div class="icon">${icon}</div><h3>${name}</h3>${pill}</div>
        ${note}
        <div class="card-actions">${actions}</div>
      </div>`;
  }

  const appleLast = meta.lastReadingByProvider.get("apple_health");
  const appleCard = `
    <div class="card">
      <div class="card-head"><div class="icon">❤️</div><h3>Apple Health</h3>${appleLast ? statusPill("ok", "Imported") : statusPill("off", "Optional")}</div>
      <p class="meta">Export from the Health app on your iPhone and drop the <code>export.zip</code> here. <a href="/help#apple-health">How?</a></p>
      <div class="dropzone" id="apple-health-dropzone">Drop export.zip here, or click to choose</div>
      <input type="file" id="apple-health-file-input" accept=".zip" style="display:none;">
      ${appleLast ? `<p class="meta" style="margin: 8px 0 0;">Newest reading ${formatWhen(appleLast)} · <a href="/data/wearables?source=apple_health">View data</a></p>` : ""}
    </div>`;

  const body = `
    <h1>Your health, in one place</h1>
    <p class="lede">AyuOS collects your wearable, hospital and lab data on this Mac — automatically and privately.</p>
    ${diskWarning(meta.freeDiskBytes)}
    ${fileVaultNotice(meta.fileVaultOn)}
    ${meta.syncing ? `<div class="alert ok">Sync started — new data will appear over the next few minutes.</div>` : ""}
    ${setupGuide(meta.checklist)}

    <div class="row" style="margin: 22px 0 12px;">
      <a class="btn big" href="/record">Open my health record</a>
      <form method="post" action="/sync/now" style="margin: 0;"><button class="btn secondary" type="submit">Sync wearables now</button></form>
    </div>

    <h2>Your data sources</h2>
    <div class="grid">
      ${wearableCard("oura", "Oura", "💍")}
      ${wearableCard("whoop", "Whoop", "⌚")}
      ${meta.hospitalsCard ?? ""}
      ${meta.extraCards ?? ""}
      ${appleCard}
    </div>

    <h2>Behind the scenes</h2>
    ${syncActivity(meta.jobs)}
  `;
  return layout("AyuOS", body, DROPZONE_SCRIPT + (meta.extraScript ?? ""), "/");
}

function liveTimestamp(): string {
  return `<p class="meta">Queried live at ${new Date().toISOString()}</p>`;
}

function viewCompleteDatabaseBlock(): string {
  return `
    <details style="margin-top: 20px;">
      <summary style="cursor: pointer; color: #555; font-size: 13px;">View complete database</summary>
      <p class="meta">
        This page only shows the most recent 100 rows. To browse everything, connect any
        Postgres client (e.g. <a href="https://eggerapps.at/postico2/" target="_blank">Postico</a>)
        with these details. The password is unique to this computer and kept in the macOS Keychain;
        print it in Terminal with
        <code>security find-generic-password -s AyuOS -a database-password -w</code>
      </p>
      <table>
        <tr><th>Host</th><td>127.0.0.1</td></tr>
        <tr><th>Port</th><td>${process.env.AYUOS_DB_PORT ?? 5435}</td></tr>
        <tr><th>Database</th><td>ayuos</td></tr>
        <tr><th>User</th><td>ayuos</td></tr>
      </table>
    </details>
  `;
}

interface WearableRow {
  metric_type: string;
  ts: string;
  value: number;
  unit: string | null;
  source_provider: string;
}

export function wearablesDataPage(
  rows: WearableRow[],
  summary: Array<{ metric_type: string; count: number }>,
  bySource: Array<{ source_provider: string; count: number }>,
  activeSource: string | null,
  syncing = false
): string {
  const summaryRows = summary
    .map((s) => `<tr><td>${s.metric_type}</td><td>${s.count}</td></tr>`)
    .join("");

  const dataRows = rows
    .map(
      (r) =>
        `<tr><td>${r.ts}</td><td>${r.metric_type}</td><td>${r.value}</td><td>${r.unit ?? ""}</td><td>${r.source_provider}</td></tr>`
    )
    .join("");

  const syncingBanner = syncing
    ? `<p class="meta">Sync running in the background — <a href="/data/wearables">refresh</a> in a bit to see more rows arrive.</p>`
    : "";

  const totalCount = bySource.reduce((sum, s) => sum + s.count, 0);
  const filterLink = (label: string, source: string | null, count: number) => {
    const isActive = activeSource === source;
    const href = source ? `/data/wearables?source=${source}` : "/data/wearables";
    return isActive
      ? `<strong>${label} (${count})</strong>`
      : `<a href="${href}">${label} (${count})</a>`;
  };

  const filterBar = `
    <p class="meta">
      Filter by source:
      ${filterLink("All", null, totalCount)}
      ${bySource.map((s) => ` · ${filterLink(s.source_provider, s.source_provider, s.count)}`).join("")}
    </p>
  `;

  const body = `
    <h1>Wearable readings</h1>
    <p class="lede">Every reading from your wearables and Apple Health. <a href="/">← Home</a></p>
    ${syncingBanner}
    ${liveTimestamp()}
    ${filterBar}
    <h2>Row counts by metric type${activeSource ? ` (${activeSource} only)` : ""}</h2>
    <table><tr><th>metric_type</th><th>count</th></tr>${summaryRows}</table>
    <h2>Most recent 100 readings${activeSource ? ` (${activeSource} only)` : ""}</h2>
    <table><tr><th>timestamp</th><th>metric_type</th><th>value</th><th>unit</th><th>source</th></tr>${dataRows}</table>
    ${viewCompleteDatabaseBlock()}
  `;
  return layout("AyuOS — wearable data", body);
}

interface EhrRow {
  source: string;
  resource_type: string;
  resource_id: string;
  patient_id: string | null;
  fetched_at: string;
}

export function ehrDataPage(
  rows: EhrRow[],
  summary: Array<{ resource_type: string; count: number }>,
  syncing = false
): string {
  const summaryRows = summary
    .map((s) => `<tr><td>${s.resource_type}</td><td>${s.count}</td></tr>`)
    .join("");

  const dataRows = rows
    .map(
      (r) =>
        `<tr><td>${r.fetched_at}</td><td>${r.resource_type}</td><td>${r.resource_id}</td><td>${r.patient_id ?? ""}</td><td>${r.source}</td></tr>`
    )
    .join("");

  const syncingBanner = syncing
    ? `<p class="meta">Import running in the background — <a href="/data/ehr">refresh</a> in a bit to see more rows arrive.</p>`
    : "";

  const body = `
    <h1>Hospital records (raw)</h1>
    <p class="lede">Every record downloaded from your hospitals, as received. <a href="/record">See them organized →</a></p>
    ${syncingBanner}
    ${liveTimestamp()}
    <h2>Row counts by resource type</h2>
    <table><tr><th>resource_type</th><th>count</th></tr>${summaryRows}</table>
    <h2>Most recent 100 resources</h2>
    <table><tr><th>fetched_at</th><th>resource_type</th><th>resource_id</th><th>patient_id</th><th>source</th></tr>${dataRows}</table>
    ${viewCompleteDatabaseBlock()}
  `;
  return layout("AyuOS — EHR data", body);
}

const PROVIDER_NAMES: Record<string, string> = { oura: "Oura", whoop: "Whoop" };

// Shown when the wearable's own login page refuses or the user cancels.
export function wearableConnectErrorPage(provider: string, error: string, description: string | null): string {
  const name = PROVIDER_NAMES[provider] ?? provider;
  const explanation =
    error === "access_denied"
      ? `The ${name} login was cancelled, or access wasn't approved. Nothing was connected.`
      : error === "request_forbidden"
        ? `${name} didn't allow this account to connect to AyuOS. This usually means the AyuOS app at ${name} hasn't been approved for this account yet — for example, an app still in development at ${name} only accepts accounts the developer has added. Ask the AyuOS team to check the ${name} developer dashboard, then try again.`
        : `${name} returned an error during login, so nothing was connected.`;
  const body = `
    <h1>Couldn't connect ${escapeHtml(name)}</h1>
    <p>${escapeHtml(explanation)}</p>
    <p class="meta">Details from ${escapeHtml(name)}: ${escapeHtml(error)}${description ? ` — ${escapeHtml(description)}` : ""}</p>
    <p><a class="btn" href="/connect/${encodeURIComponent(provider)}">Try again</a> &nbsp; <a href="/">Back to AyuOS</a> &nbsp; <a href="/help#troubleshooting">Help</a></p>
  `;
  return layout(`AyuOS — Couldn't connect ${name}`, body);
}
