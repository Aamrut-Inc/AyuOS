import { afterAll, beforeAll, expect, test } from "bun:test";
import { attachmentRefs, downloadAttachment } from "./attachments";
import type { ProviderConfig } from "../config";

let server: ReturnType<typeof Bun.serve>;
let config: ProviderConfig;
const token = { access_token: "secret-token", token_type: "Bearer" };
const PDF = Buffer.from("%PDF-1.4 fake");

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (req.headers.get("authorization") !== "Bearer secret-token") return new Response("no", { status: 401 });
      if (url.pathname === "/fhir/Binary/pdf1") return new Response(PDF, { headers: { "content-type": "application/pdf" } });
      if (url.pathname === "/fhir/Binary/note1") {
        return Response.json(
          { resourceType: "Binary", contentType: "text/html", data: Buffer.from("<p>Visit note</p>").toString("base64") },
          { headers: { "content-type": "application/fhir+json" } }
        );
      }
      return new Response("forbidden", { status: 403 });
    }
  });
  config = {
    name: "epic_sandbox",
    fhirBaseUrl: `http://127.0.0.1:${server.port}/fhir`,
    clientId: "test",
    redirectUri: "http://127.0.0.1/callback",
    scopes: "",
    searchCategories: {},
    resourceTypes: [],
    allowNonFhirNetwork: false
  };
});

afterAll(() => server.stop(true));

test("finds attachments on DocumentReference and DiagnosticReport", () => {
  const refs = [
    ...attachmentRefs({
      resourceType: "DocumentReference",
      id: "d1",
      content: [{ attachment: { url: "Binary/note1", contentType: "text/html" } }, { attachment: {} }]
    }),
    ...attachmentRefs({ resourceType: "DiagnosticReport", id: "r1", presentedForm: [{ data: "aGk=", contentType: "text/plain" }] }),
    ...attachmentRefs({ resourceType: "Observation", id: "o1" })
  ];
  expect(refs.map((r) => [r.resourceType, r.url, r.inlineData])).toEqual([
    ["DocumentReference", "Binary/note1", null],
    ["DiagnosticReport", null, "aGk="]
  ]);
});

test("downloads raw documents and FHIR Binary JSON relative to the FHIR base", async () => {
  const ref = (url: string, contentType: string) => ({
    resourceType: "DocumentReference", resourceId: "d1", url, inlineData: null, contentType, title: null
  });
  const pdf = await downloadAttachment(config, token, ref("Binary/pdf1", "application/pdf"));
  expect([pdf.error, pdf.contentType, Buffer.from(pdf.bytes!).toString()]).toEqual([null, "application/pdf", "%PDF-1.4 fake"]);

  const note = await downloadAttachment(config, token, ref("Binary/note1", "text/html"));
  expect([note.contentType, Buffer.from(note.bytes!).toString()]).toEqual(["text/html", "<p>Visit note</p>"]);
});

test("decodes inline data; records failures instead of throwing", async () => {
  const inline = await downloadAttachment(config, token, {
    resourceType: "DiagnosticReport", resourceId: "r1", url: null, inlineData: "aGk=", contentType: "text/plain", title: null
  });
  expect(Buffer.from(inline.bytes!).toString()).toBe("hi");

  const elsewhere = await downloadAttachment(config, token, {
    resourceType: "DocumentReference", resourceId: "d1", url: "https://files.example.com/x.pdf", inlineData: null, contentType: null, title: null
  });
  expect(elsewhere.error).toContain("Blocked");

  const forbidden = await downloadAttachment(config, token, {
    resourceType: "DocumentReference", resourceId: "d1", url: "Binary/other", inlineData: null, contentType: null, title: null
  });
  expect(forbidden.error).toBe("HTTP 403");
});
