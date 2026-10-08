import type { LabDocument, LabResultRow } from "../load/lab-store";
import { DEFAULT_ACCEPT } from "../transform/lab-results";
import { escapeHtml, formatWhen, layout } from "./pages";

const e = (value: unknown) => escapeHtml(value === null || value === undefined ? "" : String(value));

export const LAB_DROPZONE_SCRIPT = `
  const labZone = document.getElementById('lab-pdf-dropzone');
  const labInput = document.getElementById('lab-pdf-file-input');

  async function uploadLabPdfs(files) {
    const list = Array.from(files).filter((f) => f.name.toLowerCase().endsWith('.pdf'));
    if (!list.length) { labZone.textContent = 'Please choose PDF files.'; return; }
    labZone.textContent = 'Reading ' + list.length + ' PDF(s)... scanned pages take a few seconds each.';
    const formData = new FormData();
    list.forEach((f) => formData.append('file', f));
    try {
      const res = await fetch('/upload/lab-pdf', { method: 'POST', body: formData });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error || 'Upload failed');
      const docs = payload.documents;
      window.location.href = docs.length === 1 ? '/labs/' + docs[0].documentId : '/labs';
    } catch (err) {
      labZone.textContent = 'Upload failed: ' + err.message + ' (drop the files again to retry)';
    }
  }

  if (labZone && labInput) {
    labZone.addEventListener('click', () => labInput.click());
    labInput.addEventListener('change', () => { if (labInput.files.length) uploadLabPdfs(labInput.files); });
    ['dragenter', 'dragover'].forEach((evt) =>
      labZone.addEventListener(evt, (ev) => { ev.preventDefault(); labZone.classList.add('drag-over'); })
    );
    labZone.addEventListener('dragleave', (ev) => { ev.preventDefault(); labZone.classList.remove('drag-over'); });
    labZone.addEventListener('drop', (ev) => {
      ev.preventDefault();
      labZone.classList.remove('drag-over');
      if (ev.dataTransfer.files.length) uploadLabPdfs(ev.dataTransfer.files);
    });
  }
`;

export function labUploadCard(pendingReview: number, confirmedCount: number): string {
  return `
    <div class="source-row" style="flex-direction: column; align-items: stretch;">
      <strong style="margin-bottom: 10px;">Lab reports (PDF)</strong>
      <div class="dropzone" id="lab-pdf-dropzone">Drag and drop lab report PDFs here, or click to choose files</div>
      <input type="file" id="lab-pdf-file-input" accept=".pdf,application/pdf" multiple style="display:none;">
      <p class="meta" style="margin: 6px 0 0;">
        Read on this laptop (scanned reports via on-device OCR) — nothing is uploaded anywhere.
        ${confirmedCount ? `${confirmedCount} confirmed result(s).` : ""}
        ${pendingReview ? `<strong>${pendingReview} report(s) waiting for review.</strong>` : ""}
        <a href="/labs">View lab results</a>
      </p>
    </div>
  `;
}

function valueCell(r: LabResultRow): string {
  if (r.value_num !== null) return `${r.comparator ?? ""}${r.value_num}`;
  return r.value_text ?? "";
}

function flagBadge(flag: string | null): string {
  if (!flag) return "";
  const label = flag === "H" ? "High" : flag === "L" ? "Low" : "Abnormal";
  return `<span class="failing">${label}</span>`;
}

export function labsPage(
  documents: Array<LabDocument & { confirmed: number; pending: number }>,
  confirmed: LabResultRow[]
): string {
  const docRows = documents
    .map((d) => {
      const status =
        d.status === "needs_review"
          ? `<a href="/labs/${d.id}"><strong>Review ${d.pending} result(s)</strong></a>`
          : d.status === "failed"
            ? `<span class="failing">Failed</span><div class="warning">${e(d.error)}</div>`
            : `✓ Reviewed · <a href="/labs/${d.id}">edit</a>`;
      return `<tr>
        <td><a href="/labs/${d.id}/file" target="_blank">${e(d.filename)}</a></td>
        <td>${e(d.collected_date ?? "?")}</td>
        <td>${d.confirmed}</td>
        <td>${e(d.extraction_method ?? "")}</td>
        <td>${status}</td>
        <td>${formatWhen(d.uploaded_at)}</td>
      </tr>`;
    })
    .join("");

  // Group confirmed results by test so history reads down the page.
  const byAnalyte = new Map<string, LabResultRow[]>();
  for (const r of confirmed) {
    const key = r.analyte_key ?? r.analyte_name.toLowerCase();
    byAnalyte.set(key, [...(byAnalyte.get(key) ?? []), r]);
  }
  const resultRows = [...byAnalyte.values()]
    .map((history) => {
      const latest = history[0];
      const previous = history
        .slice(1, 4)
        .map((h) => `${valueCell(h)} (${e(h.collected_date ?? "?")})`)
        .join(", ");
      return `<tr>
        <td>${e(latest.analyte_name)}${latest.loinc_code ? ` <span class="meta">LOINC ${e(latest.loinc_code)}</span>` : ""}</td>
        <td><strong>${e(valueCell(latest))}</strong> ${e(latest.unit ?? "")} ${flagBadge(latest.flag)}</td>
        <td>${e(latest.ref_text ?? "")}</td>
        <td>${e(latest.collected_date ?? "?")}</td>
        <td class="meta">${previous}</td>
      </tr>`;
    })
    .join("");

  const body = `
    <h1>Lab results</h1>
    <p><a href="/">← back</a></p>
    ${labUploadCard(0, 0)}
    <h2>Confirmed results (latest per test)</h2>
    ${
      resultRows
        ? `<table><tr><th>Test</th><th>Result</th><th>Reference</th><th>Collected</th><th>Previous</th></tr>${resultRows}</table>`
        : `<p class="meta">No confirmed results yet — upload a report and review it.</p>`
    }
    <h2>Uploaded reports</h2>
    ${
      docRows
        ? `<table><tr><th>File</th><th>Collected</th><th>Confirmed</th><th>Read via</th><th>Status</th><th>Uploaded</th></tr>${docRows}</table>`
        : `<p class="meta">No reports uploaded yet.</p>`
    }
  `;
  return layout("AyuOS — Lab results", body, LAB_DROPZONE_SCRIPT);
}

export function labReviewPage(doc: LabDocument, results: LabResultRow[]): string {
  const rows = results
    .map((r) => {
      const checked = r.status === "confirmed" || (r.status === "pending" && r.confidence >= DEFAULT_ACCEPT);
      const value = r.value_num !== null ? `${r.comparator ?? ""}${r.value_num}` : (r.value_text ?? "");
      const flagOptions = ["", "H", "L", "A"]
        .map((f) => `<option value="${f}"${(r.flag ?? "") === f ? " selected" : ""}>${f || "—"}</option>`)
        .join("");
      return `<tr${r.status === "rejected" ? ' style="opacity:.55"' : ""}>
        <td><input type="checkbox" name="accept_${r.id}"${checked ? " checked" : ""}></td>
        <td><input name="name_${r.id}" value="${e(r.analyte_name)}" style="width: 180px"></td>
        <td><input name="value_${r.id}" value="${e(value)}" style="width: 70px"></td>
        <td><input name="unit_${r.id}" value="${e(r.unit ?? "")}" style="width: 80px"></td>
        <td><input name="ref_${r.id}" value="${e(r.ref_text ?? "")}" style="width: 90px"></td>
        <td><select name="flag_${r.id}">${flagOptions}</select></td>
        <td class="meta" style="max-width: 260px">p${r.page}: ${e(r.source_text)}${
          r.loinc_code ? `<br>LOINC ${e(r.loinc_code)} (suggested)` : ""
        }${r.confidence < DEFAULT_ACCEPT ? `<br><span class="warning">low confidence — check against the PDF</span>` : ""}</td>
      </tr>`;
    })
    .join("");

  const body = `
    <h1>Review: ${e(doc.filename)}</h1>
    <p><a href="/labs">← all lab results</a> · <a href="/labs/${doc.id}/file" target="_blank">open the original PDF</a></p>
    <p class="meta">
      Read via ${e(doc.extraction_method ?? "?")} from ${doc.page_count ?? "?"} page(s).
      Check each value against the PDF — ticked rows are saved as your results, unticked rows are discarded.
      ${doc.extraction_method !== "text" ? "<strong>This report was read with OCR; double-check every digit.</strong>" : ""}
    </p>
    ${doc.status === "failed" ? `<p class="failing">Reading failed: ${e(doc.error)}</p>` : ""}
    <form method="post" action="/labs/${doc.id}/review">
      <p>
        <label>Collection date: <input type="date" name="collected_date" value="${e(doc.collected_date ?? "")}"></label>
        <span class="meta">(detected automatically — correct it if wrong)</span>
      </p>
      ${
        rows
          ? `<table><tr><th>Keep</th><th>Test</th><th>Value</th><th>Unit</th><th>Reference</th><th>Flag</th><th>Read from</th></tr>${rows}</table>`
          : `<p class="meta">No results were recognized in this PDF. If it is a lab report, the format may not be supported yet.</p>`
      }
      <p style="margin-top: 16px;">
        <button class="button" type="submit">Save reviewed results</button>
      </p>
    </form>
    <form method="post" action="/labs/${doc.id}/reparse">
      <button type="submit" style="margin-top: 4px;">Re-read this PDF</button>
      <span class="meta">(keeps rows you already reviewed)</span>
    </form>
  `;
  return layout(`AyuOS — Review ${doc.filename}`, body);
}
