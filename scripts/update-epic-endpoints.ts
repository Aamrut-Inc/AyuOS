// Refreshes the bundled list of Epic health systems AyuOS can connect to
// (extract/ehr/epic-endpoints.json) from Epic's public directory. The list is
// bundled rather than fetched at runtime so browsing hospitals sends nothing
// anywhere. Run: bun scripts/update-epic-endpoints.ts
import { join } from "node:path";

const DIRECTORY_URL = "https://open.epic.com/Endpoints/R4";

interface EndpointBundle {
  entry?: Array<{
    resource?: {
      status?: string;
      name?: string;
      address?: string;
      contained?: Array<{ resourceType?: string; name?: string }>;
    };
  }>;
}

const response = await fetch(DIRECTORY_URL, { headers: { accept: "application/json" } });
if (!response.ok) throw new Error(`Epic directory request failed: ${response.status}`);
const bundle = (await response.json()) as EndpointBundle;

const byUrl = new Map<string, { name: string; url: string }>();
for (const { resource } of bundle.entry ?? []) {
  if (!resource?.address || resource.status !== "active") continue;
  const name = resource.contained?.find((c) => c.resourceType === "Organization")?.name ?? resource.name;
  if (!name) continue;
  const url = resource.address.replace(/\/+$/, "");
  byUrl.set(url, { name: name.trim(), url });
}

const hospitals = [...byUrl.values()].sort((a, b) => a.name.localeCompare(b.name));
const out = join(import.meta.dir, "..", "extract", "ehr", "epic-endpoints.json");
await Bun.write(out, JSON.stringify({ source: DIRECTORY_URL, fetchedAt: new Date().toISOString(), hospitals }, null, 1) + "\n");
console.log(`Wrote ${hospitals.length} health systems to ${out}`);
