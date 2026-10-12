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

// Home page card: one row per connected health system, each with its own
// sync button, plus "Add a hospital".
export function hospitalsCard(connections: EhrConnection[]): string {
  const rows = connections
    .map((c) => {
      const failed = c.lastImportStatus === "failed";
      return `
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-top: 1px solid #eee;">
          <span>
            ${e(c.displayName)}
            <span class="meta" style="display: block; margin: 2px 0 0;">
              ${c.lastImportAt ? `Last download: ${formatWhen(c.lastImportAt)}` : "Not downloaded yet"}
              ${c.lastImportStatus === "running" ? " · downloading now…" : ""}
              ${failed ? `<span class="failing"> · last download failed</span>` : ""}
              · <a href="/record">View records</a>
            </span>
            ${failed && c.lastImportError ? `<span class="warning" style="display: block;">${e(c.lastImportError.slice(0, 200))}</span>` : ""}
          </span>
          <a class="button" href="/connect/ehr?hospital=${encodeURIComponent(c.slug)}">${c.lastImportAt ? "Sync" : "Connect"}</a>
        </div>`;
    })
    .join("");

  return `
    <div class="source-row" style="flex-direction: column; align-items: stretch;">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <strong>Hospital records (Epic MyChart)</strong>
        <a href="/hospitals">+ Add a hospital</a>
      </div>
      ${rows || `<p class="meta" style="margin: 8px 0 0;">No hospital connected yet. <a href="/hospitals">Find yours</a> — most large US health systems use Epic.</p>`}
      <p class="meta" style="margin: 8px 0 0;">
        Hospital records are a one-time download (the hospital's login only lasts an hour):
        press <strong>Sync</strong> after a visit to pick up new results.
      </p>
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

export function hospitalPickerPage(connectedUrls: Set<string>): string {
  const items = directoryHospitals()
    .map((h) => {
      const connected = connectedUrls.has(h.url);
      return `<li data-name="${e(h.name.toLowerCase())}"${h.sandbox ? ' data-featured="1"' : ""} style="display:none; padding: 6px 0; border-bottom: 1px solid #eee;">
        <form method="post" action="/hospitals/add" style="margin: 0; display: flex; justify-content: space-between; align-items: center;">
          <input type="hidden" name="url" value="${e(h.url)}">
          <span>${e(h.name)}</span>
          ${connected ? `<span class="connected">✓ Connected</span>` : `<button class="button" type="submit">Connect</button>`}
        </form>
      </li>`;
    })
    .join("");

  const body = `
    <h1>Add a hospital</h1>
    <p><a href="/">← back</a></p>
    <p class="meta">
      Search for the health system whose MyChart you use. You'll log in on its own MyChart page,
      and AyuOS downloads your records straight to this computer.
    </p>
    <input id="hospital-search" type="search" placeholder="Search, e.g. Stanford, Mayo, UCSF…"
      style="width: 100%; padding: 10px; font-size: 15px; border: 1px solid #ccc; border-radius: 6px;">
    <ul id="hospital-list" style="list-style: none; padding: 0;">${items}</ul>
    <p id="hospital-empty" class="meta" style="display:none;">
      No match. Not every health system uses Epic — if yours isn't listed, AyuOS can't connect to it yet.
    </p>
  `;
  return layout("AyuOS — Add a hospital", body, PICKER_SCRIPT);
}

export function hospitalUnavailablePage(name: string, status: "unknown" | "rejected"): string {
  const explanation =
    status === "unknown"
      ? `AyuOS hasn't been enabled at ${name} yet. Epic rolls apps out to each health system automatically, but not all at once — try again in a day or two.`
      : `${name} recognized AyuOS but refused the request. Please send the AyuOS team a screenshot of this page.`;
  const body = `
    <h1>Not available at ${e(name)} yet</h1>
    <p>${e(explanation)}</p>
    <p><a class="button" href="/hospitals">Back to hospitals</a> &nbsp; <a href="/">Home</a></p>
  `;
  return layout("AyuOS — Not available yet", body);
}
