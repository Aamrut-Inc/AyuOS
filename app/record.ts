import { SQL } from "bun";
import type { PostgresConfig } from "../load/config";
import { escapeHtml, formatWhen, layout } from "./pages";

// One page that reads across every source: hospital records (structured
// clinical tables), lab results from both the EHR and reviewed PDFs,
// wearable trends, and downloaded documents.

const e = (value: unknown) => escapeHtml(value === null || value === undefined ? "" : String(value));

function day(value: unknown): string {
  if (!value) return "";
  return new Date(value as string).toISOString().slice(0, 10);
}

function num(value: unknown): string {
  if (value === null || value === undefined) return "";
  const n = Number(value);
  return Number.isInteger(n) ? String(n) : n.toFixed(Math.abs(n) >= 100 ? 0 : Math.abs(n) >= 10 ? 1 : 2);
}

// Wearable metrics worth a glance; everything else stays on /data/wearables.
const WEARABLE_METRICS: Record<string, string> = {
  resting_heart_rate: "Resting heart rate",
  heart_rate: "Heart rate (all readings)",
  heart_rate_variability_sdnn: "HRV (SDNN)",
  heart_rate_variability_rmssd: "HRV (RMSSD)",
  steps: "Steps per day",
  oxygen_saturation: "Blood oxygen",
  skin_temperature_deviation: "Skin temperature deviation",
  respiratory_rate: "Respiratory rate",
  weight: "Weight"
};

interface Section {
  title: string;
  html: string;
}

function table(headers: string[], rows: string[][], empty: string): string {
  if (rows.length === 0) return `<p class="meta">${empty}</p>`;
  return `<table><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
    .join("")}</table>`;
}

export async function recordPage(config: PostgresConfig, userId: string | null): Promise<string> {
  const sql = new SQL(config.connectionString);
  try {
    const conditions = await sql`
      SELECT code_text, clinical_status, onset_text, recorded_date, source
      FROM clinical.condition
      ORDER BY (clinical_status = 'active') DESC NULLS LAST, coalesce(onset_datetime, recorded_date) DESC NULLS LAST
    `;
    const medications = await sql`
      SELECT medication_text, dosage_text, status, authored_on, source
      FROM clinical.medication_request
      ORDER BY (status = 'active') DESC NULLS LAST, authored_on DESC NULLS LAST
    `;
    const allergies = await sql`
      SELECT substance_text, criticality, reactions, clinical_status, source
      FROM clinical.allergy_intolerance ORDER BY substance_text
    `;
    const encounters = await sql`
      SELECT period_start, class_display, class_code, type_text, service_provider_name, location_names, source
      FROM clinical.encounter ORDER BY period_start DESC NULLS LAST LIMIT 15
    `;

    // Lab results from the hospital (laboratory Observations) and from
    // reviewed PDFs, grouped by LOINC code when known, else by name.
    const labs = await sql`
      WITH ehr AS (
        SELECT coalesce(c.display, 'Observation') AS name, c.code AS loinc,
               o.value_quantity_value AS value_num, o.value_text, o.value_quantity_unit AS unit,
               o.effective_datetime AS at, 'EHR (' || o.source || ')' AS origin
        FROM clinical.observation o
        LEFT JOIN LATERAL (
          SELECT display, CASE WHEN system = 'http://loinc.org' THEN code END AS code
          FROM clinical.observation_code_coding
          WHERE observation_id = o.id
          ORDER BY (system = 'http://loinc.org') DESC
          LIMIT 1
        ) c ON true
        WHERE 'laboratory' = ANY (o.category_codes)
      ),
      pdf AS (
        SELECT analyte_name, loinc_code, value_num, value_text, unit,
               collected_date::timestamptz, 'Lab PDF'
        FROM labs.results WHERE status = 'confirmed'
      ),
      all_results AS (SELECT * FROM ehr UNION ALL SELECT * FROM pdf),
      ranked AS (
        SELECT *, coalesce(loinc, lower(name)) AS test_key,
               row_number() OVER (PARTITION BY coalesce(loinc, lower(name)) ORDER BY at DESC NULLS LAST) AS rn,
               count(*) OVER (PARTITION BY coalesce(loinc, lower(name))) AS n
        FROM all_results
      )
      SELECT name, loinc, value_num, value_text, unit, at, origin, n
      FROM ranked WHERE rn = 1 ORDER BY name
    `;

    const wearables = userId
      ? await sql`
          WITH daily AS (
            SELECT metric_type, source_provider, date_trunc('day', ts) AS d,
                   CASE WHEN metric_type = 'steps' THEN sum(value) ELSE avg(value) END AS v,
                   min(unit) AS unit
            FROM timeseries.readings
            WHERE user_id = ${userId} AND metric_type = ANY (${sql.array(Object.keys(WEARABLE_METRICS), "text")})
              AND ts > now() - interval '120 days'
            GROUP BY 1, 2, 3
          )
          SELECT metric_type, source_provider, min(unit) AS unit,
                 (array_agg(v ORDER BY d DESC))[1] AS latest, max(d) AS latest_day,
                 avg(v) FILTER (WHERE d > now() - interval '7 days') AS avg7,
                 avg(v) FILTER (WHERE d > now() - interval '30 days') AS avg30
          FROM daily GROUP BY 1, 2 ORDER BY 1, 2
        `
      : [];

    const documents = await sql`
      SELECT a.id, a.title, a.content_type, a.size_bytes, a.resource_type, a.error, a.fetched_at,
             d.date AS doc_date
      FROM clinical.fhir_attachments a
      LEFT JOIN clinical.document_reference d ON d.source = a.source AND d.resource_id = a.resource_id
      ORDER BY coalesce(d.date, a.fetched_at) DESC LIMIT 50
    `;
    const labPdfs = await sql`
      SELECT id, filename, collected_date, status FROM labs.documents ORDER BY collected_date DESC NULLS LAST
    `;

    const sections: Section[] = [
      {
        title: "Problems",
        html: table(
          ["Condition", "Status", "Since", "Source"],
          conditions.map((c: any) => [e(c.code_text), e(c.clinical_status), e(c.onset_text ?? day(c.recorded_date)), e(c.source)]),
          "No conditions imported yet (needs the Condition API enabled on the Epic app)."
        )
      },
      {
        title: "Medications",
        html: table(
          ["Medication", "Instructions", "Status", "Prescribed", "Source"],
          medications.map((m: any) => [e(m.medication_text), e(m.dosage_text), e(m.status), day(m.authored_on), e(m.source)]),
          "No medications imported yet."
        )
      },
      {
        title: "Allergies",
        html: table(
          ["Substance", "Reactions", "Criticality", "Status"],
          allergies.map((a: any) => [e(a.substance_text), e((a.reactions ?? []).join(", ")), e(a.criticality), e(a.clinical_status)]),
          "No allergies imported yet."
        )
      },
      {
        title: "Lab results (latest per test)",
        html: table(
          ["Test", "Result", "Date", "From", "Results on file"],
          labs.map((l: any) => [
            `${e(l.name)}${l.loinc ? ` <span class="meta">LOINC ${e(l.loinc)}</span>` : ""}`,
            `<strong>${e(l.value_num !== null ? num(l.value_num) : l.value_text)}</strong> ${e(l.unit)}`,
            day(l.at),
            e(l.origin),
            e(l.n)
          ]),
          "No lab results yet — import hospital records or upload lab PDFs."
        ) + `<p class="meta"><a href="/labs">Lab PDFs and review →</a></p>`
      },
      {
        title: "Wearables (daily values)",
        html: table(
          ["Metric", "Device", "Latest", "7-day avg", "30-day avg"],
          (wearables as any[]).map((w) => [
            e(WEARABLE_METRICS[w.metric_type] ?? w.metric_type),
            e(w.source_provider),
            `${num(w.latest)} ${e(w.unit)} <span class="meta">${day(w.latest_day)}</span>`,
            num(w.avg7),
            num(w.avg30)
          ]),
          "No wearable data in the last 120 days."
        ) + `<p class="meta"><a href="/data/wearables">All wearable readings →</a></p>`
      },
      {
        title: "Recent visits",
        html: table(
          ["Date", "Type", "Where", "Source"],
          encounters.map((v: any) => [
            day(v.period_start),
            e([v.class_display ?? v.class_code, ...(v.type_text ?? [])].filter(Boolean).join(" · ")),
            e(v.service_provider_name ?? (v.location_names ?? []).join(", ")),
            e(v.source)
          ]),
          "No visits imported yet."
        )
      },
      {
        title: "Documents",
        html: table(
          ["Document", "Type", "Date", ""],
          [
            ...documents.map((d: any) => [
              d.error ? e(d.title ?? d.resource_type) : `<a href="/attachments/${d.id}" target="_blank">${e(d.title ?? d.resource_type)}</a>`,
              e(d.content_type ?? ""),
              day(d.doc_date ?? d.fetched_at),
              d.error ? `<span class="warning">not downloaded: ${e(d.error)}</span>` : ""
            ]),
            ...labPdfs.map((p: any) => [
              `<a href="/labs/${p.id}/file" target="_blank">${e(p.filename)}</a>`,
              "Lab report (uploaded)",
              p.collected_date ? day(p.collected_date) : "",
              p.status === "needs_review" ? `<a href="/labs/${p.id}">needs review</a>` : ""
            ])
          ],
          "No documents yet."
        )
      }
    ];

    const body = `
      <h1>My health record</h1>
      <p><a href="/">← back</a> · <span class="meta">Everything below lives on this laptop. Generated ${formatWhen(new Date().toISOString())}.</span></p>
      ${sections.map((s) => `<h2>${s.title}</h2>${s.html}`).join("")}
    `;
    return layout("AyuOS — Health record", body);
  } finally {
    await sql.close();
  }
}
