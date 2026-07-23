// POST /api/crm/send-media — outbound media from a cockpit operator.
// Handles image, video, audio, and document uploads. The kind is
// derived from the file's MIME type via classifyOutboundMime.
//
// Body: multipart/form-data with thread_id (string), file (Blob),
// optional caption (string, max 1024 chars per Meta's limit;
// silently ignored for audio since Meta does not allow audio
// captions).
//
// Auth: dual-mode bearer via src/lib/crmAuth, same as /api/crm/send.
//
// Flow:
//   1. Auth + parse formData.
//   2. Classify MIME → kind (image | video | audio | document) or
//      reject with a specific error (e.g., iOS QuickTime).
//   3. Validate per-type size cap (5/16/16/100 MB) and caption length.
//   4. Load thread; reject if channel != 'whatsapp'.
//   5. Enforce the 24-hour WhatsApp session window.
//   6. Upload to Meta (POST {PHONE_NUMBER_ID}/media) → media_id.
//   7. Send via Meta with the per-kind helper (sendWhatsAppImage /
//      Video / Audio / Document) → wamid.
//   8. Pre-allocate the crm_messages UUID, upload the same bytes to
//      Supabase Storage at {threadId}/{messageId}/{filename}.
//   9. Insert the outbound row with media columns populated. If step
//      8 failed AFTER step 7 succeeded, insert with media_url=null
//      and log loudly. NEVER block on Storage once Meta accepted.
//  10. Update thread last_message_at + preview (kind-aware emoji
//      fallback when caption is empty).
//  11. Return { message } shaped like /api/crm/send: signed_media_url
//      minted server-side, raw media_url stripped.
//
// SMS-channel threads cannot send media (Telnyx MMS is a separate
// feature; rejected with 400 here).

import { randomUUID } from "node:crypto";
import { authenticateCrm } from "@/lib/crmAuth";
import {
  sendWhatsAppAudio,
  sendWhatsAppDocument,
  sendWhatsAppImage,
  sendWhatsAppVideo,
  uploadWhatsAppMedia,
  WHATSAPP_MEDIA_CAPTION_MAX,
  WhatsAppApiError,
} from "@/lib/whatsapp";
import { getSignedMediaUrl, uploadMessageMedia } from "@/lib/crmMedia";
import {
  classifyOutboundMime,
  MEDIA_BYTE_LIMITS,
  type OutboundMediaKind,
} from "@/lib/whatsappMediaKind";

export const runtime = "nodejs";
// 30s — image/video uploads on slow networks can exceed the standard
// 15s budget. Documents up to 100 MB benefit even more.
export const maxDuration = 30;

const PREVIEW_LIMIT = 80;
const WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000;

// Inbox preview emoji per kind, used when caption is empty. Mirrors
// the inbound-side previewFor in the webhook handler.
const PREVIEW_LABEL: Record<OutboundMediaKind, string> = {
  image: "📷 Image",
  video: "🎬 Video",
  audio: "🎵 Audio",
  document: "📄 Document",
};

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
  const fileField = form.get("file");

  if (!threadId) {
    return Response.json({ error: "thread_id required" }, { status: 400 });
  }
  if (!(fileField instanceof Blob)) {
    return Response.json({ error: "file required" }, { status: 400 });
  }
  const file = fileField;
  const mimeType = file.type;

  const classification = classifyOutboundMime(mimeType);
  if (!classification.ok) {
    return Response.json({ error: classification.error }, { status: 400 });
  }
  const kind = classification.kind;

  if (file.size === 0) {
    return Response.json({ error: "file is empty" }, { status: 400 });
  }
  const sizeCap = MEDIA_BYTE_LIMITS[kind];
  if (file.size > sizeCap) {
    return Response.json(
      {
        error: `${kind} exceeds ${sizeCap / (1024 * 1024)} MB limit`,
      },
      { status: 400 },
    );
  }

  // Audio cannot carry captions; silently drop instead of rejecting
  // so the client UI mistakes don't bounce the request.
  const caption = kind === "audio" ? "" : captionRaw;
  if (caption.length > WHATSAPP_MEDIA_CAPTION_MAX) {
    return Response.json(
      { error: `caption exceeds ${WHATSAPP_MEDIA_CAPTION_MAX} chars` },
      { status: 400 },
    );
  }

  // file.name is set when the field came from a browser <input
  // type="file">. Documents NEED a filename for Meta's API; other
  // kinds use a kind-derived fallback.
  const filename = deriveFilename(file, mimeType, kind);

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
      { error: "Media send is only supported on WhatsApp threads" },
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
    `[crm:send-media] start thread=${threadId} user=${appUserId ?? "cron"} kind=${kind} bytes=${file.size} mime=${mimeType}`,
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

  // -------- 2. send via Meta (branch by kind) --------
  let wamid: string;
  try {
    const captionForSend = caption.length > 0 ? caption : undefined;
    if (kind === "image") {
      wamid = (
        await sendWhatsAppImage({ toPhone, mediaId, caption: captionForSend })
      ).messageId;
    } else if (kind === "video") {
      wamid = (
        await sendWhatsAppVideo({ toPhone, mediaId, caption: captionForSend })
      ).messageId;
    } else if (kind === "audio") {
      wamid = (await sendWhatsAppAudio({ toPhone, mediaId })).messageId;
    } else {
      // document
      wamid = (
        await sendWhatsAppDocument({
          toPhone,
          mediaId,
          filename,
          caption: captionForSend,
        })
      ).messageId;
    }
  } catch (err) {
    const msg = describeMetaError(err);
    console.error("[crm:send-media] meta send failed", msg);
    return Response.json({ error: msg }, { status: 502 });
  }

  // -------- 3. Storage upload (best-effort once Meta accepted) --------
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
      // Documents preserve the operator-provided filename; other
      // kinds use the kind-derived default so the Storage dashboard
      // stays human-inspectable.
      media_filename: filename,
      media_size_bytes: buffer.length,
      media_kind: kind,
      delivery_status: "sent",
    })
    .select("*")
    .single();
  if (inserted.error || !inserted.data) {
    console.error("[crm:send-media] message insert failed", inserted.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }

  // -------- 5. update thread preview --------
  const preview = previewFor(kind, caption, filename);
  const upd = await supabase
    .from("crm_threads")
    .update({
      last_message_at: nowIso,
      last_message_preview: preview,
      // Outbound media = we spoke last → answered. Not a template send.
      last_message_direction: "outbound",
      last_message_is_template: false,
    })
    .eq("id", threadId);
  if (upd.error) {
    console.error("[crm:send-media] thread update failed", upd.error);
  }

  // -------- 6. mint signed URL for the response --------
  let signedUrl: string | null = null;
  if (storagePath) {
    signedUrl = await getSignedMediaUrl(supabase, storagePath);
  }

  const elapsed = Date.now() - startedAt;
  console.log(
    `[crm:send-media] done thread=${threadId} kind=${kind} wamid=${wamid} storage=${
      storagePath ?? "none"
    } elapsed=${elapsed}ms`,
  );

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

// Derive a filename for both Meta's API (documents require it) and
// the Storage object key. Documents preserve the original; other
// kinds get a kind-derived default tied to the MIME's extension.
function deriveFilename(
  file: Blob,
  mimeType: string,
  kind: OutboundMediaKind,
): string {
  if (file instanceof File && file.name) {
    return file.name;
  }
  const ext = mimeExt(mimeType);
  switch (kind) {
    case "image":
      return `attachment.${ext}`;
    case "video":
      return `video.${ext}`;
    case "audio":
      return `audio.${ext}`;
    case "document":
      return `document.${ext}`;
  }
}

function mimeExt(mime: string): string {
  const m = mime.toLowerCase().split(";")[0].trim();
  switch (m) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "video/mp4":
      return "mp4";
    case "video/3gpp":
      return "3gp";
    case "audio/ogg":
      return "ogg";
    case "audio/mpeg":
    case "audio/mp3":
      return "mp3";
    case "audio/aac":
      return "aac";
    case "audio/mp4":
      return "m4a";
    case "audio/amr":
      return "amr";
    case "application/pdf":
      return "pdf";
    default: {
      const slash = m.indexOf("/");
      const sub = slash > -1 ? m.slice(slash + 1) : "";
      return sub || "bin";
    }
  }
}

function previewFor(
  kind: OutboundMediaKind,
  caption: string,
  filename: string,
): string {
  const fromCaption = caption.slice(0, PREVIEW_LIMIT);
  if (fromCaption) return fromCaption;
  if (kind === "document") {
    return `📄 ${filename.slice(0, PREVIEW_LIMIT - 3)}`;
  }
  return PREVIEW_LABEL[kind];
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
