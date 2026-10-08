import { SQL } from "bun";
import type { PostgresConfig } from "./config";
import type { LabResultCandidate } from "../transform/lab-results";

export interface LabDocument {
  id: number;
  sha256: string;
  filename: string;
  file_path: string;
  size_bytes: number;
  page_count: number | null;
  extraction_method: string | null;
  collected_date: string | null;
  status: string;
  error: string | null;
  uploaded_at: string;
  reviewed_at: string | null;
}

export interface LabResultRow {
  id: number;
  document_id: number;
  page: number;
  row_index: number;
  source_text: string;
  analyte_name: string;
  analyte_key: string | null;
  loinc_code: string | null;
  value_num: number | null;
  value_text: string | null;
  comparator: string | null;
  unit: string | null;
  ref_low: number | null;
  ref_high: number | null;
  ref_text: string | null;
  flag: string | null;
  confidence: number;
  collected_date: string | null;
  status: string;
}

export interface ReviewedResult {
  id: number;
  accept: boolean;
  analyteName: string;
  valueNum: number | null;
  valueText: string | null;
  comparator: string | null;
  unit: string | null;
  refText: string | null;
  refLow: number | null;
  refHigh: number | null;
  flag: string | null;
}

function isoDate(value: unknown): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return d.toISOString().slice(0, 10);
}

export class LabStore {
  private readonly sql: SQL;

  constructor(config: PostgresConfig) {
    this.sql = new SQL(config.connectionString);
  }

  async findBySha(sha256: string): Promise<LabDocument | null> {
    const [row] = await this.sql`SELECT * FROM labs.documents WHERE sha256 = ${sha256}`;
    return row ? this.doc(row) : null;
  }

  async createDocument(doc: { sha256: string; filename: string; filePath: string; sizeBytes: number }): Promise<number> {
    const [row] = await this.sql`
      INSERT INTO labs.documents (sha256, filename, file_path, size_bytes, status)
      VALUES (${doc.sha256}, ${doc.filename}, ${doc.filePath}, ${doc.sizeBytes}, 'processing')
      RETURNING id
    `;
    return Number(row.id);
  }

  // Replaces this document's pending candidates; confirmed and rejected rows
  // from an earlier review are left alone.
  async saveExtraction(
    documentId: number,
    meta: { pageCount: number; method: string; collectedDate: string | null },
    candidates: LabResultCandidate[]
  ): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx`
        UPDATE labs.documents
        SET page_count = ${meta.pageCount}, extraction_method = ${meta.method},
            collected_date = coalesce(collected_date, ${meta.collectedDate}::date),
            status = 'needs_review', error = NULL
        WHERE id = ${documentId}
      `;
      await tx`DELETE FROM labs.results WHERE document_id = ${documentId} AND status = 'pending'`;
      for (const c of candidates) {
        await tx`
          INSERT INTO labs.results (
            document_id, page, row_index, source_text, analyte_name, analyte_key, loinc_code,
            value_num, value_text, comparator, unit, ref_low, ref_high, ref_text, flag,
            confidence, collected_date
          ) VALUES (
            ${documentId}, ${c.page}, ${c.rowIndex}, ${c.sourceText}, ${c.analyteName}, ${c.analyteKey}, ${c.loinc},
            ${c.valueNum}, ${c.valueText}, ${c.comparator}, ${c.unit}, ${c.refLow}, ${c.refHigh}, ${c.refText}, ${c.flag},
            ${c.confidence}, ${meta.collectedDate}::date
          )
          ON CONFLICT (document_id, page, row_index) DO NOTHING
        `;
      }
      // A re-read of an already reviewed report only needs review again if it
      // turned up rows that weren't there before.
      await tx`
        UPDATE labs.documents d SET status = CASE
          WHEN EXISTS (SELECT 1 FROM labs.results r WHERE r.document_id = d.id AND r.status = 'pending')
            OR d.reviewed_at IS NULL THEN 'needs_review'
          ELSE 'reviewed' END
        WHERE d.id = ${documentId}
      `;
    });
  }

  async markFailed(documentId: number, error: string): Promise<void> {
    await this.sql`UPDATE labs.documents SET status = 'failed', error = ${error} WHERE id = ${documentId}`;
  }

  async getDocument(id: number): Promise<LabDocument | null> {
    const [row] = await this.sql`SELECT * FROM labs.documents WHERE id = ${id}`;
    return row ? this.doc(row) : null;
  }

  async listDocuments(): Promise<Array<LabDocument & { confirmed: number; pending: number }>> {
    const rows = await this.sql`
      SELECT d.*,
        count(*) FILTER (WHERE r.status = 'confirmed')::int AS confirmed,
        count(*) FILTER (WHERE r.status = 'pending')::int AS pending
      FROM labs.documents d LEFT JOIN labs.results r ON r.document_id = d.id
      GROUP BY d.id ORDER BY d.uploaded_at DESC
    `;
    return rows.map((row: any) => ({ ...this.doc(row), confirmed: row.confirmed, pending: row.pending }));
  }

  async resultsForDocument(documentId: number): Promise<LabResultRow[]> {
    const rows = await this.sql`
      SELECT * FROM labs.results WHERE document_id = ${documentId} ORDER BY page, row_index
    `;
    return rows.map((row: any) => this.result(row));
  }

  async confirmedResults(): Promise<LabResultRow[]> {
    const rows = await this.sql`
      SELECT * FROM labs.results WHERE status = 'confirmed'
      ORDER BY analyte_name, collected_date DESC NULLS LAST
    `;
    return rows.map((row: any) => this.result(row));
  }

  async saveReview(documentId: number, collectedDate: string | null, reviewed: ReviewedResult[]): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx`
        UPDATE labs.documents
        SET collected_date = ${collectedDate}::date, status = 'reviewed', reviewed_at = now()
        WHERE id = ${documentId}
      `;
      for (const r of reviewed) {
        await tx`
          UPDATE labs.results SET
            status = ${r.accept ? "confirmed" : "rejected"},
            analyte_name = ${r.analyteName}, value_num = ${r.valueNum}, value_text = ${r.valueText},
            comparator = ${r.comparator},
            unit = ${r.unit}, ref_text = ${r.refText}, ref_low = ${r.refLow}, ref_high = ${r.refHigh},
            flag = ${r.flag}, collected_date = ${collectedDate}::date, reviewed_at = now()
          WHERE id = ${r.id} AND document_id = ${documentId}
        `;
      }
    });
  }

  async close(): Promise<void> {
    await this.sql.close();
  }

  private doc(row: any): LabDocument {
    return {
      ...row,
      id: Number(row.id),
      size_bytes: Number(row.size_bytes),
      collected_date: isoDate(row.collected_date),
      uploaded_at: new Date(row.uploaded_at).toISOString(),
      reviewed_at: row.reviewed_at ? new Date(row.reviewed_at).toISOString() : null
    };
  }

  private result(row: any): LabResultRow {
    return { ...row, id: Number(row.id), document_id: Number(row.document_id), collected_date: isoDate(row.collected_date) };
  }
}
