import { afterAll, beforeAll, expect, test } from "bun:test";
import { fetchResourceType, FhirHttpError } from "./client";
import type { ProviderConfig } from "../config";

// Fake FHIR server: Observation is refused without a category (like Epic),
// "lab-1" matches two categories, and "imaging" is unsupported.
let server: ReturnType<typeof Bun.serve>;
let config: ProviderConfig;
const token = { access_token: "test", token_type: "Bearer" };

function bundle(ids: string[], next?: string) {
  return Response.json({
    resourceType: "Bundle",
    entry: ids.map((id) => ({ resource: { resourceType: "Observation", id } })),
    link: next ? [{ relation: "next", url: next }] : []
  });
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const base = `http://127.0.0.1:${server.port}/fhir`;
      if (url.pathname === "/fhir/Observation") {
        const category = url.searchParams.get("category");
        if (url.searchParams.get("page") === "2") return bundle(["lab-3"]);
        if (category === "laboratory") return bundle(["lab-1", "lab-2"], `${base}/Observation?page=2`);
        if (category === "vital-signs") return bundle(["lab-1", "vital-1"]);
        return new Response("category required", { status: 400 });
      }
      if (url.pathname === "/fhir/Goal") return new Response("forbidden", { status: 403 });
      return new Response("not found", { status: 404 });
    }
  });

  config = {
    name: "epic_sandbox",
    fhirBaseUrl: `http://127.0.0.1:${server.port}/fhir`,
    clientId: "test",
    redirectUri: "http://127.0.0.1/callback",
    scopes: "",
    searchCategories: { Observation: ["laboratory", "vital-signs", "imaging"] },
    resourceTypes: [],
    allowNonFhirNetwork: false
  };
});

afterAll(() => {
  server.stop(true);
});

test("pulls every Observation category, follows pagination, de-duplicates", async () => {
  const resources = await fetchResourceType({ config, token, resourceType: "Observation", patientId: "p1" });
  expect(resources.map((r) => r.id).sort()).toEqual(["lab-1", "lab-2", "lab-3", "vital-1"]);
});

test("throws FhirHttpError when every search for a type is refused", async () => {
  const promise = fetchResourceType({ config, token, resourceType: "Goal", patientId: "p1" });
  await expect(promise).rejects.toBeInstanceOf(FhirHttpError);
});
