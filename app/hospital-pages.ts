import type { EhrConnection } from "../load/ehr-connections";
import { escapeHtml, formatWhen, layout } from "./pages";
import directory from "../extract/ehr/epic-endpoints.json";
import { EPIC_SANDBOX_BASE_URL } from "../extract/ehr/config";

const e = (value: unknown) => escapeHtml(value === null || value === undefined ? "" : String(value));

export interface DirectoryHospital {
  name: string;
  url: string;
  sandbox?: boolean;
}

export const EPIC_SANDBOX: DirectoryHospital = {
  name: "Epic sandbox (test patients, not a real hospital)",
  url: EPIC_SANDBOX_BASE_URL,
  sandbox: true
};

export function directoryHospitals(): DirectoryHospital[] {
  return [EPIC_SANDBOX, ...(directory.hospitals as DirectoryHospital[])];
}

export function findDirectoryHospital(url: string): DirectoryHospital | null {
  const normalized = url.replace(/\/+$/, "");
  return directoryHospitals().find((h) => h.url === normalized) ?? null;
}

// Home page card: one line per connected health system, each with its own
// sync button, plus "Add a hospital".
export function hospitalsCard(connections: EhrConnection[], showAddButton = true): string {
  const failed = connections.some((c) => c.lastImportStatus === "failed");
  const downloaded = connections.filter((c) => c.lastImportAt).length;
  const pill =
    connections.length === 0
      ? `<span class="pill off">Not connected</span>`
      : failed
        ? `<span class="pill warn">Needs attention</span>`
        : downloaded === 0
          ? `<span class="pill off">Not downloaded yet</span>`
          : `<span class="pill ok">${downloaded} connected</span>`;

  const rows = connections
    .map((c) => {
      const status =
        c.lastImportStatus === "running"
          ? "downloading now…"
          : c.lastImportAt
            ? `downloaded ${formatWhen(c.lastImportAt)}`
            : "not downloaded yet";
      return `
        <div class="row" style="padding: 8px 0; border-top: 1px solid var(--line);">
          <span style="min-width: 0;">
            <strong style="font-size: 14px;">${e(c.displayName)}</strong>
            <span class="meta" style="display: block; margin: 0;">${status}${
              c.lastImportStatus === "failed" ? ` · <span class="failing">last download failed</span>` : ""
            }</span>
          </span>
          <a class="btn secondary" href="/connect/ehr?hospital=${encodeURIComponent(c.slug)}">${c.lastImportAt ? "Sync" : "Connect"}</a>
        </div>`;
    })
    .join("");

  return `
    <div class="card">
      <div class="card-head"><div class="icon">🏥</div><h3>Hospital records</h3>${pill}</div>
      ${
        rows ||
        `<p class="meta">Log in with your hospital's MyChart account to download your full record. Most large US health systems use Epic.</p>`
      }
      <p class="meta" style="margin-top: 8px;">Press <strong>Sync</strong> after a visit to pick up new results.</p>
      ${showAddButton || downloaded ? `<div class="card-actions">${
        downloaded ? `<a class="btn secondary" href="/data/ehr">View records</a> ` : ""
      }${showAddButton ? `<a class="btn${connections.length ? " secondary" : ""}" href="/hospitals">+ Add a hospital</a>` : ""}</div>` : ""}
      ${
        // The status line is fixed when the page is drawn: reload while a
        // download runs so "downloading now…" turns into the result.
        connections.some((c) => c.lastImportStatus === "running") ? `<script>setTimeout(() => location.reload(), 5000)</script>` : ""
      }
    </div>
  `;
}

const PICKER_SCRIPT = `
  const input = document.getElementById('hospital-search');
  const items = Array.from(document.querySelectorAll('#hospital-list li'));
  const empty = document.getElementById('hospital-empty');
  function filter() {
    const words = input.value.toLowerCase().split(/\\s+/).filter(Boolean);
    let shown = 0;
    for (const li of items) {
      const text = li.dataset.name;
      const match = words.every((w) => text.includes(w));
      li.style.display = match && (words.length > 0 || li.dataset.featured) ? '' : 'none';
      if (li.style.display === '') shown++;
    }
    empty.style.display = shown ? 'none' : '';
  }
  input.addEventListener('input', filter);
  filter();
  input.focus();
`;

export function hospitalPickerPage(connections: EhrConnection[]): string {
  const connectedUrls = new Set(connections.map((c) => c.fhirBaseUrl));
  const items = directoryHospitals()
    .map((h) => {
      const connected = connectedUrls.has(h.url);
      return `<li data-name="${e(h.name.toLowerCase())}"${h.sandbox ? ' data-featured="1"' : ""} style="display:none; padding: 8px 0; border-bottom: 1px solid var(--line);">
        <form method="post" action="/hospitals/add" style="margin: 0; display: flex; justify-content: space-between; align-items: center;">
          <input type="hidden" name="url" value="${e(h.url)}">
          <span>${e(h.name)}</span>
          ${connected ? `<span class="pill ok">Connected</span>` : `<button class="btn" type="submit">Connect</button>`}
        </form>
      </li>`;
    })
    .join("");

  const body = `
    <h1>Hospitals</h1>
    <p class="lede">
      Connect the health systems whose MyChart you use. You log in on their own MyChart page,
      and AyuOS downloads your records straight to this Mac.
    </p>
    ${connections.length ? `<div class="grid" style="grid-template-columns: 1fr; margin-bottom: 14px;">${hospitalsCard(connections, false)}</div>` : ""}
    <h2>Add a hospital</h2>
    <div class="card">
      <input id="hospital-search" type="search" placeholder="Search, e.g. Stanford, Mayo, UCSF…"
        style="width: 100%; padding: 11px 14px; font-size: 15px; border-radius: 10px;">
      <p class="meta" style="margin: 8px 0 0;">Start typing to search ${directoryHospitals().length - 1} health systems that use Epic MyChart.</p>
      <ul id="hospital-list" style="list-style: none; padding: 0; margin: 8px 0 0;">${items}</ul>
      <p id="hospital-empty" class="meta" style="display:none;">
        No match. Not every health system uses Epic — if yours isn't listed, AyuOS can't connect to it yet.
      </p>
    </div>
  `;
  return layout("AyuOS — Add a hospital", body, PICKER_SCRIPT, "/hospitals");
}

export function hospitalUnavailablePage(name: string, status: "unknown" | "rejected" | "unreachable"): string {
  const explanation =
    status === "unknown"
      ? `AyuOS hasn't been enabled at ${name} yet. Epic rolls apps out to each health system automatically, but not all at once — try again in a day or two.`
      : status === "rejected"
        ? `${name} recognized AyuOS but refused the request. Please send the AyuOS team a screenshot of this page.`
        : `AyuOS couldn't reach ${name}'s server. Many US hospitals only accept connections from inside the US, so this is expected from other countries — try again from a US network or VPN. Otherwise, check this Mac's internet connection and try again.`;
  const title = status === "unreachable" ? `Can't reach ${name}` : `Not available at ${name} yet`;
  const body = `
    <h1>${e(title)}</h1>
    <p>${e(explanation)}</p>
    <p><a class="btn" href="/hospitals">Back to hospitals</a> &nbsp; <a href="/">Home</a></p>
  `;
  return layout(`AyuOS — ${title}`, body, "", "/hospitals");
}
