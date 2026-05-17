// POST /api/crm/send-media — outbound image from a cockpit operator.
//
// Body: multipart/form-data with thread_id (string), file (Blob),
// optional caption (string, max 1024 chars per Meta's limit).
//
// Auth: dual-mode bearer via src/lib/crmAuth, same as /api/crm/send.
//
// Flow:
//   1. Auth + parse formData.
//   2. Validate file: image/jpeg or image/png, <= 5 MB. Validate
//      caption length.
//   3. Load thread; reject if channel != 'whatsapp'.
//   4. Enforce the 24-hour WhatsApp session window.
//   5. Upload to Meta (POST {PHONE_NUMBER_ID}/media) → media_id.
//   6. Send via Meta (POST {PHONE_NUMBER_ID}/messages, type=image)
//      → wamid.
//   7. Pre-allocate the crm_messages UUID, upload the same bytes to
//      Supabase Storage at {threadId}/{messageId}/{filename}.
//   8. Insert the outbound row with media columns populated. If step
//      7 failed AFTER step 6 succeeded, insert with media_url=null
//      and log loudly — the message is in the player's WhatsApp but
//      the cockpit won't have the local image until a future
//      backfill. NEVER block on step 7 once Meta accepted the send.
//   9. Update thread last_message_at + preview.
//  10. Return { message } shaped like /api/crm/send: signed_media_url
//      minted server-side, raw media_url stripped.
//
// SMS-channel threads cannot send images (Telnyx MMS is a separate
// feature; rejected with 400 here).

import { randomUUID } from "node:crypto";
import { authenticateCrm } from "@/lib/crmAuth";
import {
  sendWhatsAppImage,
  uploadWhatsAppMedia,
  WHATSAPP_MEDIA_CAPTION_MAX,
  WhatsAppApiError,
} from "@/lib/whatsapp";
import { getSignedMediaUrl, uploadMessageMedia } from "@/lib/crmMedia";

export const runtime = "nodejs";
// 30s — image upload on slow networks can exceed the standard 15s.
export const maxDuration = 30;

const PREVIEW_LIMIT = 80;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png"]);
const WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function POST(req: Request) {
  const startedAt = Date.now();

  const auth = await authenticateCrm(req);
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }
  const { appUserId, supabase } = auth;

  // -------- parse + validate body --------
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json(
      { error: "Body must be multipart/form-data" },
      { status: 400 },
    );
  }

  const threadId =
    typeof form.get("thread_id") === "string"
      ? (form.get("thread_id") as string)
      : "";
  const captionRaw =
    typeof form.get("caption") === "string"
      ? (form.get("caption") as string)
      : "";
  const caption = captionRaw;
  const fileField = form.get("file");

  if (!threadId) {
    return Response.json({ error: "thread_id required" }, { status: 400 });
  }
  if (!(fileField instanceof Blob)) {
    return Response.json({ error: "file required" }, { status: 400 });
  }
  const file = fileField;
  const mimeType = file.type;
  if (!ALLOWED_IMAGE_TYPES.has(mimeType)) {
    return Response.json(
      { error: "Only JPEG or PNG images are supported" },
      { status: 400 },
    );
  }
  if (file.size === 0) {
    return Response.json({ error: "file is empty" }, { status: 400 });
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return Response.json(
      { error: "Image exceeds 5 MB limit" },
      { status: 400 },
    );
  }
  if (caption.length > WHATSAPP_MEDIA_CAPTION_MAX) {
    return Response.json(
      { error: `caption exceeds ${WHATSAPP_MEDIA_CAPTION_MAX} chars` },
      { status: 400 },
    );
  }

  // file.name is set when the field came from a browser <input
  // type="file">. Fallback to a generic name keyed off the MIME.
  const filename =
    file instanceof File && file.name
      ? file.name
      : `attachment.${mimeType === "image/png" ? "png" : "jpg"}`;

  // -------- thread + channel check --------
  const threadRes = await supabase
    .from("crm_threads")
    .select("id, phone_number, channel")
    .eq("id", threadId)
    .maybeSingle();
  if (threadRes.error || !threadRes.data) {
    return Response.json({ error: "Thread not found" }, { status: 404 });
  }
  const toPhone = threadRes.data.phone_number as string;
  const channel = (threadRes.data.channel as string) ?? "sms";
  if (channel !== "whatsapp") {
    return Response.json(
      { error: "Image send is only supported on WhatsApp threads" },
      { status: 400 },
    );
  }

  // -------- 24-hour window check (mirror /api/crm/send) --------
  const lastInbound = await supabase
    .from("crm_messages")
    .select("sent_at")
    .eq("thread_id", threadId)
    .eq("direction", "inbound")
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lastInbound.error) {
    console.error(
      "[crm:send-media] last-inbound lookup failed",
      lastInbound.error,
    );
    return Response.json({ error: "DB error" }, { status: 500 });
  }
  const lastInboundIso = (lastInbound.data?.sent_at as string | null) ?? null;
  if (!lastInboundIso) {
    return Response.json(
      {
        error:
          "WhatsApp session expired — player must message first to reopen the 24-hour window. Template messages are not supported in v1.",
        reason: "no_inbound",
      },
      { status: 422 },
    );
  }
  if (Date.now() - Date.parse(lastInboundIso) > WHATSAPP_WINDOW_MS) {
    return Response.json(
      {
        error:
          "WhatsApp session expired — player must message first to reopen the 24-hour window. Template messages are not supported in v1.",
        reason: "window_expired",
        last_inbound_at: lastInboundIso,
      },
      { status: 422 },
    );
  }

  console.log(
    `[crm:send-media] start thread=${threadId} user=${appUserId ?? "cron"} bytes=${file.size} mime=${mimeType}`,
  );

  // -------- read bytes once, reuse for Meta + Storage --------
  const buffer = Buffer.from(await file.arrayBuffer());

  // -------- 1. upload to Meta --------
  let mediaId: string;
  try {
    const r = await uploadWhatsAppMedia({ buffer, mimeType, filename });
    mediaId = r.mediaId;
  } catch (err) {
    const msg = describeMetaError(err);
    console.error("[crm:send-media] meta upload failed", msg);
    return Response.json({ error: msg }, { status: 502 });
  }

  // -------- 2. send via Meta --------
  let wamid: string;
  try {
    const r = await sendWhatsAppImage({
      toPhone,
      mediaId,
      caption: caption.length > 0 ? caption : undefined,
    });
    wamid = r.messageId;
  } catch (err) {
    const msg = describeMetaError(err);
    console.error("[crm:send-media] meta send failed", msg);
    // Meta accepted the upload but rejected the send. The media_id
    // expires on Meta's side; nothing to clean up locally.
    return Response.json({ error: msg }, { status: 502 });
  }

  // -------- 3. Storage upload (best-effort once Meta accepted) --------
  // Pre-allocate the row UUID so the Storage object path includes the
  // same message_id that will be in crm_messages.id.
  const newMessageId = randomUUID();
  let storagePath: string | null = null;
  try {
    storagePath = await uploadMessageMedia({
      threadId,
      messageId: newMessageId,
      buffer,
      mimeType,
      filename,
    });
  } catch (err) {
    // Loud log — the message DID go to the player (wamid exists) but
    // we couldn't archive the bytes locally. The DB row still gets
    // inserted with media_url=null so the bubble exists in the
    // operator's history.
    console.error(
      `[crm:send-media] storage upload failed AFTER successful meta send wamid=${wamid}:`,
      err instanceof Error ? err.message : String(err),
    );
  }

  // -------- 4. insert outbound row --------
  const nowIso = new Date().toISOString();
  const inserted = await supabase
    .from("crm_messages")
    .insert({
      id: newMessageId,
      thread_id: threadId,
      direction: "outbound",
      channel: "whatsapp",
      body: caption,
      sent_at: nowIso,
      sent_by_user_id: appUserId,
      external_message_id: wamid,
      media_url: storagePath,
      media_mime_type: mimeType,
      media_filename: filename,
      media_size_bytes: buffer.length,
      media_kind: "image",
      // 'sent' once Meta returned a wamid; the status webhook moves
      // it to 'delivered'/'read'/'failed' as updates arrive.
      delivery_status: "sent",
    })
    .select("*")
    .single();
  if (inserted.error || !inserted.data) {
    console.error("[crm:send-media] message insert failed", inserted.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }

  // -------- 5. update thread preview --------
  const preview = caption.slice(0, PREVIEW_LIMIT) || "📷 Image";
  const upd = await supabase
    .from("crm_threads")
    .update({ last_message_at: nowIso, last_message_preview: preview })
    .eq("id", threadId);
  if (upd.error) {
    console.error("[crm:send-media] thread update failed", upd.error);
  }

  // -------- 6. mint signed URL for the response --------
  // Lets the composer's optimistic-append render the bubble image
  // immediately without waiting for the realtime refetch trip.
  let signedUrl: string | null = null;
  if (storagePath) {
    signedUrl = await getSignedMediaUrl(supabase, storagePath);
  }

  const elapsed = Date.now() - startedAt;
  console.log(
    `[crm:send-media] done thread=${threadId} wamid=${wamid} storage=${
      storagePath ?? "none"
    } elapsed=${elapsed}ms`,
  );

  // Strip raw media_url (Storage path) — clients only need the
  // signed URL. Mirrors the detail-route response shape.
  const inserted_data = inserted.data as Record<string, unknown>;
  const { media_url: _omit, ...rest } = inserted_data;
  return Response.json(
    {
      message: { ...rest, signed_media_url: signedUrl },
      storage_uploaded: storagePath !== null,
    },
    { status: 200 },
  );
}

function describeMetaError(err: unknown): string {
  if (err instanceof WhatsAppApiError) {
    return `Meta ${err.status}: ${
      typeof err.body === "string"
        ? err.body
        : JSON.stringify(err.body).slice(0, 500)
    }`;
  }
  return err instanceof Error ? err.message : String(err);
}
