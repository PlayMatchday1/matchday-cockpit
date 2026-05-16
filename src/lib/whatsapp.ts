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
