// Server-side helper for sending outbound WhatsApp messages via the
// Meta Cloud API. Used by /api/crm/send when thread.channel ===
// 'whatsapp'. Read-only fetch — no SDK, the Cloud API is small enough
// that a typed fetch wrapper is less surface area than a vendor SDK.
//
// Auth: bearer token from META_ACCESS_TOKEN (Sensitive). Phone number
// id from META_PHONE_NUMBER_ID (the sender — our WhatsApp Business
// account's number).
//
// Token rotation note: Meta access tokens rotate periodically; the
// caller doesn't need to handle that here — any 401 from Meta gets
// surfaced as a WhatsAppApiError and the operator sees the failure
// in /crm with the response body included.

import "server-only";

const GRAPH_VERSION = "v21.0";

export class WhatsAppApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown, message?: string) {
    super(
      message ??
        `WhatsApp Cloud API ${status}: ${typeof body === "string" ? body : JSON.stringify(body)}`,
    );
    this.name = "WhatsAppApiError";
    this.status = status;
    this.body = body;
  }
}

// Strips leading + from an E.164 number. Meta's API wants bare digits
// for the `to` field; passing `+15125550123` returns a 400.
function toMetaPhone(e164: string): string {
  return e164.startsWith("+") ? e164.slice(1) : e164;
}

export type SendWhatsAppTextResult = {
  // Meta's wamid (e.g. "wamid.HBgL…"). Stored as crm_messages
  // .external_message_id for replay dedupe + reconciliation.
  messageId: string;
};

export async function sendWhatsAppText(
  toPhone: string,
  body: string,
): Promise<SendWhatsAppTextResult> {
  const token = process.env.META_ACCESS_TOKEN;
  const phoneNumberId = process.env.META_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) {
    throw new WhatsAppApiError(
      500,
      "Missing META_ACCESS_TOKEN or META_PHONE_NUMBER_ID",
    );
  }
  if (!toPhone || !body) {
    throw new WhatsAppApiError(400, "toPhone and body are required");
  }

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to: toMetaPhone(toPhone),
    type: "text",
    text: { body },
  };

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    // Network-level failure (DNS, TLS, timeout). Surface as a 502
    // analog so the caller can render a meaningful error.
    throw new WhatsAppApiError(
      502,
      err instanceof Error ? err.message : String(err),
      "Network error reaching Meta Cloud API",
    );
  }

  const text = await resp.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Leave parsed as the raw text body — Meta sometimes returns
    // HTML error pages on infra issues.
  }

  if (!resp.ok) {
    throw new WhatsAppApiError(resp.status, parsed);
  }

  // Success shape: { messaging_product, contacts: [...], messages:
  // [{ id: "wamid.xxxx", message_status?: "accepted" }] }.
  const messageId = readMessageId(parsed);
  if (!messageId) {
    throw new WhatsAppApiError(
      502,
      parsed,
      "Meta response missing messages[0].id",
    );
  }
  return { messageId };
}

function readMessageId(parsed: unknown): string | null {
  if (parsed && typeof parsed === "object") {
    const arr = (parsed as { messages?: unknown }).messages;
    if (Array.isArray(arr) && arr.length > 0) {
      const first = arr[0] as { id?: unknown };
      if (typeof first.id === "string" && first.id.length > 0) return first.id;
    }
  }
  return null;
}

// ============================================================
// Inbound media download
// ============================================================
// WhatsApp delivers media as a media_id on the webhook. To get the
// bytes we:
//   1. GET /v21.0/{media_id} with the bearer token to read the
//      temporary signed URL plus mime_type, sha256, file_size.
//   2. GET that URL (also bearer-authenticated) to download the
//      binary.
// The URL returned in step 1 is short-lived (minutes), so the caller
// must complete the download immediately. We do not retry expired
// URLs — calling this helper a second time issues a fresh URL fetch.

const MEDIA_DOWNLOAD_TIMEOUT_MS = 10_000;

export type DownloadedMedia = {
  buffer: Buffer;
  mimeType: string;
  sha256: string | null;
  fileSize: number;
};

export async function downloadWhatsAppMedia(
  mediaId: string,
): Promise<DownloadedMedia> {
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) {
    throw new WhatsAppApiError(500, "Missing META_ACCESS_TOKEN");
  }
  if (!mediaId) {
    throw new WhatsAppApiError(400, "mediaId required");
  }

  // Step 1: metadata + temporary download URL.
  const metaUrl = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(mediaId)}`;
  const metaResp = await fetchWithTimeout(
    metaUrl,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    },
    MEDIA_DOWNLOAD_TIMEOUT_MS,
  );
  if (!metaResp.ok) {
    const body = await readBodySafe(metaResp);
    throw new WhatsAppApiError(
      metaResp.status,
      body,
      "Media metadata fetch failed",
    );
  }
  const metaJson = (await metaResp.json()) as {
    url?: string;
    mime_type?: string;
    sha256?: string;
    file_size?: number;
  };
  if (!metaJson.url || !metaJson.mime_type) {
    throw new WhatsAppApiError(
      502,
      metaJson,
      "Media response missing url or mime_type",
    );
  }

  // Step 2: download the binary. Same bearer token.
  const binResp = await fetchWithTimeout(
    metaJson.url,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    },
    MEDIA_DOWNLOAD_TIMEOUT_MS,
  );
  if (!binResp.ok) {
    const body = await readBodySafe(binResp);
    throw new WhatsAppApiError(
      binResp.status,
      body,
      "Media binary fetch failed",
    );
  }
  const arrayBuf = await binResp.arrayBuffer();
  const buffer = Buffer.from(arrayBuf);

  return {
    buffer,
    mimeType: metaJson.mime_type,
    sha256: metaJson.sha256 ?? null,
    fileSize: metaJson.file_size ?? buffer.length,
  };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (err) {
    if ((err as { name?: string }).name === "AbortError") {
      throw new WhatsAppApiError(
        504,
        `Timeout after ${timeoutMs}ms`,
        "Media fetch timed out",
      );
    }
    throw new WhatsAppApiError(
      502,
      err instanceof Error ? err.message : String(err),
      "Network error during media fetch",
    );
  } finally {
    clearTimeout(timer);
  }
}

async function readBodySafe(resp: Response): Promise<unknown> {
  const text = await resp.text().catch(() => "");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ============================================================
// Outbound media upload + image send
// ============================================================
// Two-step pattern (Meta Cloud API):
//   1. POST {PHONE_NUMBER_ID}/media with multipart/form-data — returns
//      a media_id usable for ~30 days on Meta's side.
//   2. POST {PHONE_NUMBER_ID}/messages with type=image and the
//      media_id — actually sends the message, returns a wamid.
// We do not retry an expired/used media_id. Each operator send
// triggers a fresh upload + send pair.

const MEDIA_UPLOAD_TIMEOUT_MS = 30_000;

export type UploadWhatsAppMediaArgs = {
  buffer: Buffer;
  mimeType: string;
  filename: string;
};

export async function uploadWhatsAppMedia({
  buffer,
  mimeType,
  filename,
}: UploadWhatsAppMediaArgs): Promise<{ mediaId: string }> {
  const token = process.env.META_ACCESS_TOKEN;
  const phoneNumberId = process.env.META_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) {
    throw new WhatsAppApiError(
      500,
      "Missing META_ACCESS_TOKEN or META_PHONE_NUMBER_ID",
    );
  }
  if (!buffer || buffer.length === 0) {
    throw new WhatsAppApiError(400, "buffer required");
  }
  if (!mimeType) {
    throw new WhatsAppApiError(400, "mimeType required");
  }

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/media`;
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", mimeType);
  // Wrap the Buffer as a Blob so FormData treats it as a file part.
  // Filename is preserved for Meta's record but does not affect how
  // the recipient sees the image.
  form.append("file", new Blob([new Uint8Array(buffer)], { type: mimeType }), filename);

  const resp = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    },
    MEDIA_UPLOAD_TIMEOUT_MS,
  );
  const text = await resp.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* keep raw text */
  }
  if (!resp.ok) {
    throw new WhatsAppApiError(resp.status, parsed);
  }

  const mediaId =
    parsed && typeof parsed === "object"
      ? (parsed as { id?: unknown }).id
      : null;
  if (typeof mediaId !== "string" || mediaId.length === 0) {
    throw new WhatsAppApiError(
      502,
      parsed,
      "Meta media upload response missing id",
    );
  }
  return { mediaId };
}

// Meta's documented caption limit is 1024 chars on image/video
// messages. Enforced server-side so a UI bug can't truncate silently.
export const WHATSAPP_MEDIA_CAPTION_MAX = 1024;

export type SendWhatsAppImageArgs = {
  toPhone: string;
  mediaId: string;
  caption?: string;
};

export async function sendWhatsAppImage({
  toPhone,
  mediaId,
  caption,
}: SendWhatsAppImageArgs): Promise<SendWhatsAppTextResult> {
  const token = process.env.META_ACCESS_TOKEN;
  const phoneNumberId = process.env.META_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) {
    throw new WhatsAppApiError(
      500,
      "Missing META_ACCESS_TOKEN or META_PHONE_NUMBER_ID",
    );
  }
  if (!toPhone || !mediaId) {
    throw new WhatsAppApiError(400, "toPhone and mediaId are required");
  }
  if (caption && caption.length > WHATSAPP_MEDIA_CAPTION_MAX) {
    throw new WhatsAppApiError(
      400,
      `caption exceeds ${WHATSAPP_MEDIA_CAPTION_MAX} chars`,
    );
  }

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;
  // Caption only included when non-empty — Meta rejects empty-string
  // captions on some endpoint versions.
  const image: { id: string; caption?: string } = { id: mediaId };
  if (caption && caption.length > 0) image.caption = caption;
  const payload = {
    messaging_product: "whatsapp",
    to: toMetaPhone(toPhone),
    type: "image",
    image,
  };

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    throw new WhatsAppApiError(
      502,
      err instanceof Error ? err.message : String(err),
      "Network error reaching Meta Cloud API",
    );
  }

  const text = await resp.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* keep raw text */
  }
  if (!resp.ok) {
    throw new WhatsAppApiError(resp.status, parsed);
  }
  const messageId = readMessageId(parsed);
  if (!messageId) {
    throw new WhatsAppApiError(
      502,
      parsed,
      "Meta response missing messages[0].id",
    );
  }
  return { messageId };
}

// ============================================================
// Outbound video / audio / document send
// ============================================================
// Same two-step pattern as sendWhatsAppImage: caller has already
// called uploadWhatsAppMedia to get a media_id, then invokes the
// per-type helper here to actually send. Each helper builds the
// type-specific payload shape and routes through postWhatsAppMessage
// for the shared fetch + parse loop.

async function postWhatsAppMessage(
  toPhone: string,
  payload: Record<string, unknown>,
): Promise<SendWhatsAppTextResult> {
  const token = process.env.META_ACCESS_TOKEN;
  const phoneNumberId = process.env.META_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) {
    throw new WhatsAppApiError(
      500,
      "Missing META_ACCESS_TOKEN or META_PHONE_NUMBER_ID",
    );
  }
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: toMetaPhone(toPhone),
        ...payload,
      }),
    });
  } catch (err) {
    throw new WhatsAppApiError(
      502,
      err instanceof Error ? err.message : String(err),
      "Network error reaching Meta Cloud API",
    );
  }
  const text = await resp.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* keep raw text */
  }
  if (!resp.ok) {
    throw new WhatsAppApiError(resp.status, parsed);
  }
  const messageId = readMessageId(parsed);
  if (!messageId) {
    throw new WhatsAppApiError(
      502,
      parsed,
      "Meta response missing messages[0].id",
    );
  }
  return { messageId };
}

export type SendWhatsAppVideoArgs = {
  toPhone: string;
  mediaId: string;
  caption?: string;
};

export async function sendWhatsAppVideo({
  toPhone,
  mediaId,
  caption,
}: SendWhatsAppVideoArgs): Promise<SendWhatsAppTextResult> {
  if (!toPhone || !mediaId) {
    throw new WhatsAppApiError(400, "toPhone and mediaId are required");
  }
  if (caption && caption.length > WHATSAPP_MEDIA_CAPTION_MAX) {
    throw new WhatsAppApiError(
      400,
      `caption exceeds ${WHATSAPP_MEDIA_CAPTION_MAX} chars`,
    );
  }
  const video: { id: string; caption?: string } = { id: mediaId };
  if (caption && caption.length > 0) video.caption = caption;
  return postWhatsAppMessage(toPhone, { type: "video", video });
}

export type SendWhatsAppAudioArgs = {
  toPhone: string;
  mediaId: string;
};

// Audio messages cannot carry captions per Meta spec — the helper
// signature reflects that.
export async function sendWhatsAppAudio({
  toPhone,
  mediaId,
}: SendWhatsAppAudioArgs): Promise<SendWhatsAppTextResult> {
  if (!toPhone || !mediaId) {
    throw new WhatsAppApiError(400, "toPhone and mediaId are required");
  }
  return postWhatsAppMessage(toPhone, {
    type: "audio",
    audio: { id: mediaId },
  });
}

export type SendWhatsAppDocumentArgs = {
  toPhone: string;
  mediaId: string;
  // Required by Meta — surfaces in the recipient's WhatsApp client
  // as the displayed file label.
  filename: string;
  caption?: string;
};

export async function sendWhatsAppDocument({
  toPhone,
  mediaId,
  filename,
  caption,
}: SendWhatsAppDocumentArgs): Promise<SendWhatsAppTextResult> {
  if (!toPhone || !mediaId) {
    throw new WhatsAppApiError(400, "toPhone and mediaId are required");
  }
  if (!filename) {
    throw new WhatsAppApiError(400, "filename is required for documents");
  }
  if (caption && caption.length > WHATSAPP_MEDIA_CAPTION_MAX) {
    throw new WhatsAppApiError(
      400,
      `caption exceeds ${WHATSAPP_MEDIA_CAPTION_MAX} chars`,
    );
  }
  const document: { id: string; filename: string; caption?: string } = {
    id: mediaId,
    filename,
  };
  if (caption && caption.length > 0) document.caption = caption;
  return postWhatsAppMessage(toPhone, { type: "document", document });
}
