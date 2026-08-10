import unzipper from "unzipper";

export interface ClinicalDocumentEntry {
  path: string;
  format: "ccda" | "fhir-json";
  content: string;
}

const CLINICAL_RECORDS_PATH_PATTERN = /clinical-records/i;

export async function findClinicalDocuments(
  exportZipPath: string
): Promise<ClinicalDocumentEntry[]> {
  const directory = await unzipper.Open.file(exportZipPath);

  const clinicalRecordFiles = directory.files.filter(
    (file) => file.type === "File" && CLINICAL_RECORDS_PATH_PATTERN.test(file.path)
  );

  const documents: ClinicalDocumentEntry[] = [];

  for (const file of clinicalRecordFiles) {
    const buffer = await file.buffer();
    const content = buffer.toString("utf8").trim();
    if (!content) continue;

    if (content.startsWith("{") || content.startsWith("[")) {
      documents.push({ path: file.path, format: "fhir-json", content });
    } else if (content.startsWith("<")) {
      documents.push({ path: file.path, format: "ccda", content });
    }
  }

  if (documents.length === 0) {
    throw new Error(
      "No files found under a 'clinical-records' path in this export. " +
        "Apple's export format for embedded clinical records varies by iOS version — " +
        "if this export instead embeds clinical documents inline within export.xml, " +
        "that extraction path isn't implemented yet and needs to be built against " +
        "this specific file's actual structure."
    );
  }

  return documents;
}
