import type { WearableConnection } from "../extract/wearables/oauth";

const STYLE = `
  body { font-family: -apple-system, sans-serif; max-width: 900px; margin: 40px auto; padding: 0 20px; color: #222; }
  h1 { font-size: 22px; }
  h2 { font-size: 15px; color: #444; }
  table { border-collapse: collapse; width: 100%; margin-top: 12px; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #ddd; font-size: 13px; }
  th { background: #f5f5f5; }
  .source-row { display: flex; align-items: center; justify-content: space-between; padding: 14px; border: 1px solid #ddd; border-radius: 8px; margin-bottom: 10px; }
  .connected { color: #1a7f37; font-weight: 600; font-size: 13px; margin-right: 12px; }
  a.button { background: #111; color: #fff; padding: 8px 18px; border-radius: 6px; text-decoration: none; font-size: 14px; }
  a.button.disabled { background: #ccc; pointer-events: none; }
  .meta { color: #777; font-size: 12px; margin: 4px 0 16px; }
  .dropzone { border: 2px dashed #ccc; border-radius: 8px; padding: 28px; text-align: center; color: #999; font-size: 13px; transition: border-color .15s, color .15s; }
  .dropzone.drag-over { border-color: #111; color: #111; }
`;

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

function layout(title: string, body: string, script = ""): string {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>${title}</title><style>${STYLE}</style></head>
<body>${body}${script ? `<script>${script}</script>` : ""}</body>
</html>`;
}

export function loginPage(connections: WearableConnection[], ehrConnected: boolean): string {
  const byProvider = new Map(connections.map((c) => [c.provider, c.status]));
  const isConnected = (provider: string) => byProvider.get(provider) === "active";

  function sourceRow(label: string, action: string, connectedFlag: boolean): string {
    const badge = connectedFlag ? `<span class="connected">✓ Connected</span>` : "";
    return `<div class="source-row"><strong>${label}</strong><span>${badge}${action}</span></div>`;
  }

  const body = `
    <h1>Welcome to AyuOS</h1>
    <p class="meta">Please login:</p>

    ${sourceRow("Oura", `<a class="button" href="/simulate/oura">Connect</a>`, isConnected("oura"))}
    ${sourceRow("Whoop", `<a class="button" href="/simulate/whoop">Connect</a>`, isConnected("whoop"))}
    ${sourceRow("EHR (Epic)", `<a class="button" href="/connect/ehr">Connect</a>`, ehrConnected)}

    <div class="source-row" style="flex-direction: column; align-items: stretch;">
      <strong style="margin-bottom: 10px;">Apple Health</strong>
      <div class="dropzone" id="apple-health-dropzone">Drag and drop your export.zip here, or click to choose a file</div>
      <input type="file" id="apple-health-file-input" accept=".zip" style="display:none;">
    </div>
  `;
  return layout("AyuOS — Login", body, DROPZONE_SCRIPT);
}

function liveTimestamp(): string {
  return `<p class="meta">Queried live at ${new Date().toISOString()}</p>`;
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
    <h1>timeseries.readings</h1>
    <p><a href="/">← back</a></p>
    ${syncingBanner}
    ${liveTimestamp()}
    ${filterBar}
    <h2>Row counts by metric type${activeSource ? ` (${activeSource} only)` : ""}</h2>
    <table><tr><th>metric_type</th><th>count</th></tr>${summaryRows}</table>
    <h2>Most recent 100 readings${activeSource ? ` (${activeSource} only)` : ""}</h2>
    <table><tr><th>timestamp</th><th>metric_type</th><th>value</th><th>unit</th><th>source</th></tr>${dataRows}</table>
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
    <h1>clinical.fhir_resources</h1>
    <p><a href="/">← back</a></p>
    ${syncingBanner}
    ${liveTimestamp()}
    <h2>Row counts by resource type</h2>
    <table><tr><th>resource_type</th><th>count</th></tr>${summaryRows}</table>
    <h2>Most recent 100 resources</h2>
    <table><tr><th>fetched_at</th><th>resource_type</th><th>resource_id</th><th>patient_id</th><th>source</th></tr>${dataRows}</table>
  `;
  return layout("AyuOS — EHR data", body);
}
