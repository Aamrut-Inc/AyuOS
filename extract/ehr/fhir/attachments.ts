import type { ProviderConfig, TokenResponse } from "../config";
import type { FhirResource } from "../../../shared/types";
import { assertAllowedOutgoingUrl, guardedFetch } from "../security/network-guard";

// Documents attached to FHIR records (clinical notes, report PDFs) are only
// links (usually "Binary/<id>" on the FHIR server). The links need the same
// short-lived access token as the import, so they have to be downloaded
// during the import or they're unreachable afterwards.

export interface AttachmentRef {
  resourceType: string;
  resourceId: string;
  url: string | null;
  inlineData: string | null; // base64, when the attachment is embedded
  contentType: string | null;
  title: string | null;
}

export interface DownloadedAttachment {
  ref: AttachmentRef;
  bytes: Uint8Array | null;
  contentType: string | null;
  error: string | null;
}

interface Attachment {
  url?: string;
  data?: string;
  contentType?: string;
  title?: string;
}

// Over this, an attachment is recorded but not downloaded.
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

export function attachmentRefs(resource: FhirResource): AttachmentRef[] {
  const attachments: Attachment[] = [];
  if (resource.resourceType === "DocumentReference") {
    for (const content of (resource.content as Array<{ attachment?: Attachment }>) || []) {
      if (content.attachment) attachments.push(content.attachment);
    }
  } else if (resource.resourceType === "DiagnosticReport") {
    attachments.push(...((resource.presentedForm as Attachment[]) || []));
  }

  return attachments
    .filter((a) => a.url || a.data)
    .map((a) => ({
      resourceType: resource.resourceType,
      resourceId: resource.id!,
      url: a.url ?? null,
      inlineData: a.data ?? null,
      contentType: a.contentType ?? null,
      title: a.title ?? null
    }));
}

function resolveUrl(config: ProviderConfig, url: string): string {
  return new URL(url, `${config.fhirBaseUrl}/`).toString();
}

export async function downloadAttachment(
  config: ProviderConfig,
  token: TokenResponse,
  ref: AttachmentRef
): Promise<DownloadedAttachment> {
  if (ref.inlineData) {
    return { ref, bytes: new Uint8Array(Buffer.from(ref.inlineData, "base64")), contentType: ref.contentType, error: null };
  }

  const url = resolveUrl(config, ref.url!);
  try {
    assertAllowedOutgoingUrl(url, config, "FHIR attachment");
    const response = await guardedFetch(
      url,
      {
        headers: {
          authorization: `Bearer ${token.access_token}`,
          // Ask for the document itself; servers that can't will send a FHIR
          // Binary resource with base64 data instead, handled below.
          accept: ref.contentType ? `${ref.contentType}, application/fhir+json;q=0.5` : "*/*"
        }
      },
      config,
      "FHIR attachment"
    );
    if (!response.ok) {
      return { ref, bytes: null, contentType: null, error: `HTTP ${response.status}` };
    }
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > MAX_ATTACHMENT_BYTES) {
      return { ref, bytes: null, contentType: null, error: `Too large (${declared} bytes)` };
    }

    const contentType = response.headers.get("content-type")?.split(";")[0].trim() ?? ref.contentType;
    const body = new Uint8Array(await response.arrayBuffer());
    if (contentType?.includes("fhir+json") || contentType === "application/json") {
      const binary = JSON.parse(Buffer.from(body).toString("utf8")) as { resourceType?: string; data?: string; contentType?: string };
      if (binary.resourceType === "Binary" && binary.data) {
        return {
          ref,
          bytes: new Uint8Array(Buffer.from(binary.data, "base64")),
          contentType: binary.contentType ?? ref.contentType,
          error: null
        };
      }
    }
    return { ref, bytes: body, contentType, error: null };
  } catch (error) {
    return { ref, bytes: null, contentType: null, error: error instanceof Error ? error.message : String(error) };
  }
}
