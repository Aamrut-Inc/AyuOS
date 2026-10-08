import { SQL } from "bun";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { PostgresConfig } from "./config";
import type { DownloadedAttachment } from "../extract/ehr/fhir/attachments";
import { dataDir } from "../shared/data-dir";

const EXTENSIONS: Record<string, string> = {
  "application/pdf": "pdf",
  "text/html": "html",
  "text/plain": "txt",
  "text/rtf": "rtf",
  "application/rtf": "rtf",
  "application/xml": "xml",
  "text/xml": "xml",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/tiff": "tiff"
};

export class AttachmentStore {
  private readonly sql: SQL;

  constructor(config: PostgresConfig) {
    this.sql = new SQL(config.connectionString);
  }

  // URLs already downloaded successfully for this source, so re-imports skip them.
  async downloadedUrls(source: string): Promise<Set<string>> {
    const rows = await this.sql`
      SELECT url FROM clinical.fhir_attachments WHERE source = ${source} AND error IS NULL
    `;
    return new Set(rows.map((r: any) => r.url));
  }

  async save(source: string, downloaded: DownloadedAttachment): Promise<void> {
    const { ref, bytes, contentType, error } = downloaded;
    let sha256: string | null = null;
    let filePath: string | null = null;

    if (bytes) {
      sha256 = createHash("sha256").update(bytes).digest("hex");
      const dir = join(dataDir(), "fhir-attachments");
      mkdirSync(dir, { recursive: true });
      filePath = join(dir, `${sha256}.${EXTENSIONS[contentType ?? ""] ?? "bin"}`);
      await Bun.write(filePath, bytes);
    }
    const url = ref.url ?? `inline:${sha256}`;

    await this.sql`
      INSERT INTO clinical.fhir_attachments (
        source, resource_type, resource_id, url, title, content_type, sha256, file_path, size_bytes, error
      ) VALUES (
        ${source}, ${ref.resourceType}, ${ref.resourceId}, ${url}, ${ref.title}, ${contentType},
        ${sha256}, ${filePath}, ${bytes?.length ?? null}, ${error}
      )
      ON CONFLICT (source, resource_type, resource_id, url) DO UPDATE SET
        title = EXCLUDED.title, content_type = EXCLUDED.content_type, sha256 = EXCLUDED.sha256,
        file_path = EXCLUDED.file_path, size_bytes = EXCLUDED.size_bytes, error = EXCLUDED.error,
        fetched_at = now()
    `;
  }

  async close(): Promise<void> {
    await this.sql.close();
  }
}
