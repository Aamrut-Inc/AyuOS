import unzipper from "unzipper";
import { XMLParser } from "fast-xml-parser";
import type { WearableReading } from "../wearables/client";

const LOINC_TO_METRIC_TYPE: Record<string, string> = {
  "8302-2": "height",
  "8867-4": "heart_rate",
  "2710-2": "oxygen_saturation",
  "9279-1": "respiratory_rate",
  "3141-9": "weight"
};

function parseCdaTimestamp(value: string): string | null {
  const match = value.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})([+-]\d{4})?$/);
  if (!match) return null;

  const [, year, month, day, hour, minute, second, tz] = match;
  const offset = tz ? `${tz.slice(0, 3)}:${tz.slice(3)}` : "Z";
  return `${year}-${month}-${day}T${hour}:${minute}:${second}${offset}`;
}

function extractEffectiveTime(effectiveTime: any): string | null {
  if (!effectiveTime) return null;
  const raw = effectiveTime.low?.["@_value"] ?? effectiveTime["@_value"];
  return typeof raw === "string" ? parseCdaTimestamp(raw) : null;
}

function collectCdaObservations(node: unknown, results: any[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectCdaObservations(item, results);
    return;
  }
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if (obj["@_classCode"] === "OBS" && obj.code && obj.value) {
      results.push(obj);
    }
    for (const value of Object.values(obj)) {
      collectCdaObservations(value, results);
    }
  }
}

export async function parseVitalsFromZip(
  zipData: Buffer,
  userId: string
): Promise<WearableReading[]> {
  const directory = await unzipper.Open.buffer(zipData);
  const cdaFile = directory.files.find((f) => f.path.endsWith("export_cda.xml"));

  if (!cdaFile) {
    throw new Error(
      "No export_cda.xml found in this export (expected apple_health_export/export_cda.xml)"
    );
  }

  const xmlBuffer = await cdaFile.buffer();
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
  const doc = parser.parse(xmlBuffer.toString("utf8"));

  const observations: any[] = [];
  collectCdaObservations(doc, observations);

  // Keyed by the table's actual conflict target (user_id, metric_type, ts,
  // source_provider) — the source export contains genuine duplicate entries
  // at identical timestamps, and a single INSERT..ON CONFLICT statement
  // can't affect the same row twice, so these must be collapsed before
  // batching, not just left for Postgres to reject.
  const readingsByKey = new Map<string, WearableReading>();

  for (const obs of observations) {
    const code = obs.code?.["@_code"];
    const metricType = code ? LOINC_TO_METRIC_TYPE[code] : undefined;
    if (!metricType) continue;

    const rawValue = obs.value?.["@_value"];
    if (rawValue === undefined) continue;

    const ts = extractEffectiveTime(obs.effectiveTime);
    if (!ts) continue;

    let value = Number(rawValue);
    let unit = obs.value?.["@_unit"] ?? null;

    // Apple's CDA export encodes oxygen_saturation as a 0-1 fraction under a
    // "%" unit (e.g. 0.96), while every other source in this table (Oura,
    // Whoop) already uses the 0-100 scale. Normalize here so the same
    // metric_type means the same thing regardless of source.
    if (metricType === "oxygen_saturation" && unit === "%" && value <= 1) {
      value = value * 100;
    }

    const key = `${metricType}|${ts}`;
    readingsByKey.set(key, {
      userId,
      metricType,
      ts,
      value,
      unit,
      sourceProvider: "apple_health",
      sourceDevice: null
    });
  }

  return Array.from(readingsByKey.values());
}
