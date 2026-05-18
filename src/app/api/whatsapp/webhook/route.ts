// POST + GET /api/whatsapp/webhook
//
// Public endpoint Meta calls for the WhatsApp Cloud API. Mirrors the
// Telnyx webhook at /api/webhooks/telnyx for the parts that matter
// (phone normalization, player matching with newest-wins tiebreak,
// match_ambiguous semantics, thread upsert, inbound message insert
// + idempotency). Differences:
//
//   - Signature: HMAC-SHA256 of the raw request body, header
//     `x-hub-signature-256`, value `sha256=<hex>`. Mandatory; 401
//     on mismatch.
//   - Verification handshake: a one-time GET with hub.mode +
//     hub.verify_token + hub.challenge that we echo back as plain
//     text when the token matches WHATSAPP_VERIFY_TOKEN.
//   - Thread upsert key: (phone_number, channel='whatsapp'). SMS and
//     WhatsApp threads for the same phone stay in separate rows
//     because the channels have different reply-window rules.
//   - Provider id stored as external_message_id (Meta's wamid) with
//     the same 23505 partial-unique dedupe pattern.
//   - On NEW thread creation only, fires a Google Chat card. Never
//     blocks the 200 response — Meta retries if it doesn't get a
//     fast ack.
//
// We never log message bodies, tokens, or signature material. Meta
// can include PII (player names, phone, message text) in payloads;
// keep logs to phone/wamid/elapsed.

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { normalizePhone, toNationalDigits } from "@/lib/phone";
import {
  notifyNewWhatsAppThread,
  type NewWhatsAppThreadNotification,
} from "@/lib/gchat";
import { downloadWhatsAppMedia } from "@/lib/whatsapp";
import { uploadMessageMedia } from "@/lib/crmMedia";
import {
  notifyInboundChatMessage,
  type CrmInboundPushArgs,
} from "@/lib/crmPushNotify";

export const runtime = "nodejs";
export const maxDuration = 15;

const PREVIEW_LIMIT = 80;
// Used by handleInboundMedia's catch path when a media fetch
// genuinely fails (download from Meta, or upload to Storage).
const MEDIA_PLACEHOLDER = "📎 Media attachment — view in WhatsApp app";
// Used by the deriveMessageRow final fallback for inbound types
// we don't handle yet (location, contacts, interactive, order,
// system, ...). Wording deliberately does NOT mention "media" —
// distinct from MEDIA_PLACEHOLDER so the bug-vs-coverage-gap
// signal stays clear in the inbox.
const UNSUPPORTED_PLACEHOLDER =
  "[Unsupported message type — open WhatsApp to view]";

// ============================================================
// GET — Meta one-time webhook verification handshake
// ============================================================
export async function GET(req: Request) {
  const url = new URL(req.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  const expected = process.env.WHATSAPP_VERIFY_TOKEN;
  if (
    mode === "subscribe" &&
    challenge &&
    expected &&
    token &&
    token === expected
  ) {
    // Per Meta's docs: respond with the raw challenge value as plain
    // text. JSON-wrapping it would fail the verification.
    return new Response(challenge, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }

  return new Response("Forbidden", { status: 403 });
}

// ============================================================
// POST — inbound webhook
// ============================================================

type WaMessage = {
  from?: string;
  id?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  // Inbound image. Meta does not send a filename for images; caption
  // is optional. mime_type is one of image/jpeg, image/png (per Meta
  // docs), occasionally image/webp.
  image?: {
    id?: string;
    mime_type?: string;
    sha256?: string;
    caption?: string;
  };
  // Inbound video. mime_type is video/mp4 or video/3gpp. Caption
  // optional. No filename from Meta.
  video?: {
    id?: string;
    mime_type?: string;
    sha256?: string;
    caption?: string;
  };
  // Inbound audio. mime_type is one of audio/aac, audio/mp4,
  // audio/mpeg, audio/amr, audio/ogg. `voice` flag distinguishes
  // press-and-hold voice notes from attached audio files. No caption
  // per Meta spec.
  audio?: {
    id?: string;
    mime_type?: string;
    sha256?: string;
    voice?: boolean;
  };
  // Inbound document. Carries an original filename — the only
  // inbound media type that does. Caption optional.
  document?: {
    id?: string;
    mime_type?: string;
    sha256?: string;
    filename?: string;
    caption?: string;
  };
  // Inbound sticker. Always image/webp. animated flag distinguishes
  // static vs animated. No caption.
  sticker?: {
    id?: string;
    mime_type?: string;
    sha256?: string;
    animated?: boolean;
  };
  // Inbound reaction. Meta sends type="reaction" when a user
  // reacts to one of our outbound messages with an emoji. The
  // emoji string is empty when the user REMOVED their reaction.
  // message_id is the wamid of the parent message being reacted
  // to (always one of OUR outbound wamids — Meta does not deliver
  // reactions to inbound messages back to us).
  reaction?: {
    message_id?: string;
    emoji?: string;
  };
};

// Meta's status webhook entries — sent → delivered → read → failed.
// Fire on the SAME callback URL as inbound messages, multiplexed
// inside value.statuses[] instead of value.messages[].
type WaStatus = {
  id?: string; // wamid we issued on outbound send
  status?: string; // "sent" | "delivered" | "read" | "failed"
  timestamp?: string; // unix seconds, as string
  recipient_id?: string;
};

type WaEntry = {
  changes?: {
    value?: { messages?: WaMessage[]; statuses?: WaStatus[] };
    field?: string;
  }[];
};

type WaWebhookEnvelope = {
  object?: string;
  entry?: WaEntry[];
};

export async function POST(req: Request) {
  const startedAt = Date.now();

  // 1) Read the raw body. We need the exact bytes Meta sent — JSON
  //    parsing first would lose whitespace and break the HMAC.
  const raw = await req.text();

  // 2) Verify the signature. Mandatory — never short-circuit.
  if (!verifyMetaSignature(raw, req.headers.get("x-hub-signature-256"))) {
    console.warn("[whatsapp:webhook] signature verification failed");
    return Response.json({ error: "Invalid signature" }, { status: 401 });
  }

  // 3) Parse envelope. Bad JSON is a 400 (Meta won't retry on 4xx
  //    other than 401/408/429, which is what we want here — a
  //    malformed payload is something only Meta could fix).
  let evt: WaWebhookEnvelope;
  try {
    evt = JSON.parse(raw) as WaWebhookEnvelope;
  } catch {
    console.warn("[whatsapp:webhook] payload not JSON");
    return Response.json({ error: "Bad payload" }, { status: 400 });
  }

  // Two parallel branches: inbound messages and status updates
  // (sent / delivered / read / failed). Both arrive on the same
  // webhook URL but in different fields of the envelope.
  const messages = extractMessages(evt);
  const statuses = extractStatuses(evt);
  if (messages.length === 0 && statuses.length === 0) {
    return Response.json({ ok: true, ignored: "no_payload" }, { status: 200 });
  }

  // 4) Supabase service-role client (bypasses RLS — same pattern as
  //    the Telnyx webhook).
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    console.error("[whatsapp:webhook] Supabase env not configured");
    return Response.json({ error: "Server not configured" }, { status: 500 });
  }
  const sb = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 5) Process each message. We accumulate but never fail the
  //    whole batch — Meta would retry the whole envelope which
  //    causes duplicates for messages that DID land. Per-message
  //    errors are logged.
  const notifications: NewWhatsAppThreadNotification[] = [];
  const pushIntents: Omit<CrmInboundPushArgs, "supabase">[] = [];
  for (const msg of messages) {
    try {
      const result = await processInbound(sb, msg);
      if (result?.newThread) notifications.push(result.newThread);
      if (result?.pushArgs) pushIntents.push(result.pushArgs);
    } catch (err) {
      console.error("[whatsapp:webhook] process failed", err);
    }
  }

  // 5b) Process delivery-status updates (sent / delivered / read /
  //     failed). Bounded by a 2s race in case Meta sends a flood
  //     and the per-status UPDATEs would otherwise blow our 1s
  //     ack-fast budget — losing a status update is recoverable
  //     (the lifecycle is monotonic and Meta re-sends terminal
  //     states), but causing Meta to retry the whole envelope is
  //     not.
  if (statuses.length > 0) {
    await Promise.race([
      processStatusBatch(sb, statuses),
      new Promise<void>((resolve) => setTimeout(resolve, 2000)),
    ]).catch((err) => {
      console.error("[whatsapp:webhook] status batch failed:", err);
    });
  }

  // 6) Fire Google Chat notifications AFTER ack-ing Meta. Belt-and-
  //    suspenders bounding here: the notifier helper has its own
  //    AbortSignal-based 2s timeout AND we Promise.race against a
  //    2s timer at the call site. The race exists because a
  //    previous bug had this await hang for the full 15s Vercel
  //    timeout when the gchat fetch wedged, turning every new
  //    thread into a 504. Notification is best-effort — failures
  //    here must NEVER throw into the webhook response path.
  for (const n of notifications) {
    await Promise.race([
      notifyNewWhatsAppThread(n),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]).catch((err) => {
      console.error("[whatsapp:webhook] gchat notify failed:", err);
    });
  }

  // 7) Web Push fan-out. Every successful inbound store gets a push
  //    intent. Each helper invocation self-bounds at 2s. Fire all
  //    in parallel and cap the whole batch at 2s as well so a
  //    pathological push-service stall can never blow the Vercel
  //    timeout. Errors logged but never thrown — webhook ack must
  //    succeed regardless.
  if (pushIntents.length > 0) {
    await Promise.race([
      Promise.all(
        pushIntents.map((args) =>
          notifyInboundChatMessage({ ...args, supabase: sb }),
        ),
      ),
      new Promise<void>((resolve) => setTimeout(resolve, 2000)),
    ]).catch((err) => {
      console.error("[whatsapp:webhook] push fan-out failed:", err);
    });
  }

  const elapsed = Date.now() - startedAt;
  console.log(
    `[whatsapp:webhook] processed messages=${messages.length} statuses=${statuses.length} new_threads=${notifications.length} push_intents=${pushIntents.length} elapsed=${elapsed}ms`,
  );

  return Response.json({ ok: true }, { status: 200 });
}

// ============================================================
// Helpers
// ============================================================

function verifyMetaSignature(
  raw: string,
  header: string | null,
): boolean {
  if (!header) return false;
  const secret = process.env.META_APP_SECRET;
  if (!secret) {
    console.error("[whatsapp:webhook] META_APP_SECRET not configured");
    return false;
  }
  if (!header.startsWith("sha256=")) return false;
  const provided = header.slice("sha256=".length).trim();
  const computed = createHmac("sha256", secret).update(raw).digest("hex");
  const a = Buffer.from(provided, "hex");
  const b = Buffer.from(computed, "hex");
  if (a.length !== b.length || a.length === 0) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function extractMessages(evt: WaWebhookEnvelope): WaMessage[] {
  const out: WaMessage[] = [];
  for (const entry of evt.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const m of change.value?.messages ?? []) {
        out.push(m);
      }
    }
  }
  return out;
}

function extractStatuses(evt: WaWebhookEnvelope): WaStatus[] {
  const out: WaStatus[] = [];
  for (const entry of evt.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const s of change.value?.statuses ?? []) {
        out.push(s);
      }
    }
  }
  return out;
}

// Lifecycle: pending < sent < delivered < read. failed can override
// from any non-failed state. Each new status declares the set of
// prior states it's allowed to overwrite — anything else is a no-op
// at the UPDATE level so out-of-order webhook delivery (Meta does
// occasionally re-send "sent" after we've already received
// "delivered") can't downgrade a row. SMS messages will stay at
// 'sent' permanently — Telnyx delivery webhooks are a separate
// Phase 2 item.
type DeliveryStatus = "pending" | "sent" | "delivered" | "read" | "failed";

const STATUS_ALLOWED_PRIOR: Record<
  Exclude<DeliveryStatus, "pending">,
  DeliveryStatus[]
> = {
  sent: ["pending"],
  delivered: ["pending", "sent"],
  read: ["pending", "sent", "delivered"],
  failed: ["pending", "sent", "delivered", "read"],
};

function isHandledStatus(
  s: string,
): s is Exclude<DeliveryStatus, "pending"> {
  return s === "sent" || s === "delivered" || s === "read" || s === "failed";
}

async function processStatusBatch(
  sb: SupabaseClient,
  statuses: WaStatus[],
): Promise<void> {
  for (const s of statuses) {
    try {
      await processStatus(sb, s);
    } catch (err) {
      console.error("[whatsapp:webhook] status update threw", err);
    }
  }
}

async function processStatus(
  sb: SupabaseClient,
  status: WaStatus,
): Promise<void> {
  const wamid = status.id;
  const metaStatus = (status.status ?? "").toLowerCase();
  if (!wamid || !isHandledStatus(metaStatus)) return;

  const allowedPrior = STATUS_ALLOWED_PRIOR[metaStatus];

  const upd = await sb
    .from("crm_messages")
    .update({
      delivery_status: metaStatus,
      delivery_status_updated_at: new Date().toISOString(),
    })
    .eq("external_message_id", wamid)
    .in("delivery_status", allowedPrior);
  if (upd.error) {
    console.error(
      `[whatsapp:webhook] status update failed wamid=${wamid} status=${metaStatus}`,
      upd.error,
    );
    return;
  }
  // We don't differentiate "row matched + updated" vs "row matched
  // but prior-state filter blocked" vs "no row with this wamid" at
  // this level — Supabase doesn't return affected-row counts by
  // default. The log line confirms we processed the event; the
  // actual lifecycle state is queryable from the DB.
  console.log(
    `[whatsapp:webhook] status update wamid=${wamid} status=${metaStatus}`,
  );
}

// Derived row shape used by processInbound. Text messages set body
// only; image messages may set both media_* columns AND body (the
// caption). On image-handling failure we fall back to a placeholder
// body and null media so the message still appears.
type DerivedMessageRow = {
  // Optional explicit UUID. Set only for media-bearing rows so the
  // Storage object key (which depends on the row id) can be written
  // in the same INSERT as the media columns.
  id?: string;
  body: string;
  media_url: string | null;
  media_mime_type: string | null;
  media_filename: string | null;
  media_size_bytes: number | null;
  media_kind: string | null;
  // Wamid of the parent message a reaction is attached to. Only set
  // when media_kind === 'reaction'; null on every other row. Lets
  // the UI later link the reaction note to its target bubble.
  reaction_target_wamid?: string | null;
};

type MediaKind = "image" | "video" | "audio" | "document" | "sticker";

const NULL_MEDIA = {
  media_url: null,
  media_mime_type: null,
  media_filename: null,
  media_size_bytes: null,
  media_kind: null,
} as const;

// Shared download + upload path for any inbound media type. On
// failure (network, expired URL, Storage upload error) returns the
// placeholder fallback row so the message still appears in the inbox
// as a degraded text bubble. wamid is logged for triage.
async function handleInboundMedia({
  threadId,
  mediaId,
  kind,
  body,
  filename,
  wamid,
}: {
  threadId: string;
  mediaId: string;
  kind: MediaKind;
  body: string;
  filename: string | null;
  wamid: string | null;
}): Promise<DerivedMessageRow> {
  const newId = randomUUID();
  try {
    const downloaded = await downloadWhatsAppMedia(mediaId);
    const storagePath = await uploadMessageMedia({
      threadId,
      messageId: newId,
      buffer: downloaded.buffer,
      mimeType: downloaded.mimeType,
      filename,
    });
    return {
      id: newId,
      body,
      media_url: storagePath,
      media_mime_type: downloaded.mimeType,
      media_filename: filename,
      media_size_bytes: downloaded.fileSize,
      media_kind: kind,
    };
  } catch (err) {
    console.error(
      `[whatsapp:webhook] ${kind} download/upload failed wamid=${wamid ?? "-"}`,
      err,
    );
    return { body: MEDIA_PLACEHOLDER, ...NULL_MEDIA };
  }
}

// Extension derived from the message MIME. Falls through to "bin"
// for unfamiliar types. Used to label the Storage object for human
// inspection in the dashboard — does NOT affect playback (Storage
// serves the binary verbatim with the recorded mime_type).
function extForMime(mime: string | undefined): string {
  const m = (mime ?? "").toLowerCase().split(";")[0].trim();
  switch (m) {
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
    case "image/webp":
      return "webp";
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    default: {
      const slash = m.indexOf("/");
      const sub = slash > -1 ? m.slice(slash + 1) : "";
      return sub || "bin";
    }
  }
}

// Resolves the row to insert for an inbound message. For text:
// straightforward, body verbatim. For each media type: download from
// Meta, upload to crm-media, populate media_* columns. Per-type
// branches set body (caption for image/video/document; empty for
// audio/sticker which Meta does not allow captions on) and a
// canonical filename (Meta-provided for documents; type-derived for
// the rest).
async function deriveMessageRow(
  threadId: string,
  msg: WaMessage,
): Promise<DerivedMessageRow> {
  const type = (msg.type ?? "").toLowerCase();
  const wamid = msg.id ?? null;

  if (type === "text") {
    return {
      body: msg.text?.body ?? "",
      ...NULL_MEDIA,
    };
  }

  if (type === "image" && msg.image?.id) {
    return handleInboundMedia({
      threadId,
      mediaId: msg.image.id,
      kind: "image",
      body: msg.image.caption ?? "",
      // Meta does not send filenames for images. Let crmMedia's
      // sanitizer fall back to "attachment.{ext}" via mime sniff.
      filename: null,
      wamid,
    });
  }

  if (type === "video" && msg.video?.id) {
    return handleInboundMedia({
      threadId,
      mediaId: msg.video.id,
      kind: "video",
      body: msg.video.caption ?? "",
      filename: `video.${extForMime(msg.video.mime_type)}`,
      wamid,
    });
  }

  if (type === "audio" && msg.audio?.id) {
    const isVoice = msg.audio.voice === true;
    return handleInboundMedia({
      threadId,
      mediaId: msg.audio.id,
      kind: "audio",
      // Audio messages cannot carry captions per Meta spec.
      body: "",
      filename: `${isVoice ? "voice-note" : "audio"}.${extForMime(msg.audio.mime_type)}`,
      wamid,
    });
  }

  if (type === "document" && msg.document?.id) {
    // Document is the only inbound type Meta gives us a filename
    // for. Pass it through; crmMedia's sanitizer strips any path
    // components and unsafe chars. Fallback uses the mime ext when
    // Meta surprisingly omits filename.
    const original = msg.document.filename ?? null;
    const fallback = `document.${extForMime(msg.document.mime_type)}`;
    return handleInboundMedia({
      threadId,
      mediaId: msg.document.id,
      kind: "document",
      body: msg.document.caption ?? "",
      filename: original || fallback,
      wamid,
    });
  }

  if (type === "sticker" && msg.sticker?.id) {
    return handleInboundMedia({
      threadId,
      mediaId: msg.sticker.id,
      kind: "sticker",
      body: "",
      // Stickers are always webp per Meta spec.
      filename: "sticker.webp",
      wamid,
    });
  }

  if (type === "reaction") {
    // emoji is "" when the user removed an existing reaction.
    const emoji = (msg.reaction?.emoji ?? "").trim();
    const targetWamid = msg.reaction?.message_id ?? null;
    return {
      body: emoji ? `Reacted ${emoji} to your message` : "Removed reaction",
      ...NULL_MEDIA,
      media_kind: "reaction",
      reaction_target_wamid: targetWamid,
    };
  }

  // Truly unsupported types (location, contacts, interactive, order,
  // system, ...). Logged at warn level so we know when one becomes
  // common enough to warrant its own branch. Stored as a degraded
  // text bubble so the operator still sees that the player sent
  // something — body string deliberately does NOT mention "media"
  // (the old wording was misleading; reactions, location, etc are
  // not failed media fetches).
  console.warn(
    "[whatsapp:webhook] unsupported type",
    JSON.stringify({ type, wamid }),
  );
  return { body: UNSUPPORTED_PLACEHOLDER, ...NULL_MEDIA };
}

// Inbox-row preview string. Falls back to a media-kind hint when
// body is empty so the inbox doesn't show a blank row for caption-
// less media. Document preview surfaces the filename when available.
function previewFor(row: DerivedMessageRow): string {
  const fromBody = row.body.slice(0, PREVIEW_LIMIT);
  if (fromBody) return fromBody;
  switch (row.media_kind) {
    case "image":
      return "📷 Image";
    case "video":
      return "🎬 Video";
    case "audio":
      // Distinguish voice notes from attached audio by reading the
      // filename convention this file just wrote.
      return (row.media_filename ?? "").startsWith("voice-note")
        ? "🎤 Voice note"
        : "🎵 Audio";
    case "document":
      return row.media_filename
        ? `📄 ${row.media_filename.slice(0, PREVIEW_LIMIT - 3)}`
        : "📄 Document";
    case "sticker":
      return "🌟 Sticker";
    default:
      return "";
  }
}

type ProcessResult = {
  newThread?: NewWhatsAppThreadNotification;
  // Set on every successful inbound store. Carries the data needed
  // to fire a Web Push notification at the end of the request, after
  // Meta has been ack'd.
  pushArgs?: Omit<CrmInboundPushArgs, "supabase">;
};

async function processInbound(
  sb: SupabaseClient,
  msg: WaMessage,
): Promise<ProcessResult | null> {
  const wamid = msg.id ?? null;
  const fromRaw = msg.from ?? "";

  // Pre-store diagnostic. Surfaces msg.type and which optional sub-
  // payload Meta included on every inbound, so the next time an
  // unfamiliar inbound shows up in /chats we can read the type from
  // logs instead of recovering it from row state. No PII (no body,
  // no caption, no media URL).
  console.log(
    "[whatsapp:webhook] inbound",
    JSON.stringify({
      wamid,
      type: msg.type ?? null,
      from: fromRaw || null,
      has_text: !!msg.text,
      has_image: !!msg.image,
      has_video: !!msg.video,
      has_audio: !!msg.audio,
      has_document: !!msg.document,
      has_sticker: !!msg.sticker,
      has_reaction: !!msg.reaction,
    }),
  );
  // Meta delivers `from` without a leading '+'. normalizePhone
  // handles either via libphonenumber-js's default-region parsing,
  // but adding the '+' makes intent unambiguous.
  const phone = normalizePhone(
    fromRaw.startsWith("+") ? fromRaw : `+${fromRaw}`,
  );
  if (!phone) {
    console.warn(
      `[whatsapp:webhook] dropped: unparseable from=${JSON.stringify(fromRaw)}`,
    );
    return null;
  }

  // -------- player match (mirrors Telnyx newest-wins) --------
  const candidates: { id: number }[] = [];
  const national = toNationalDigits(phone);

  const e164Hit = await sb
    .from("mdapi_users")
    .select("id, created_at")
    .eq("phone_number", phone)
    .order("created_at", { ascending: false });
  if (!e164Hit.error && e164Hit.data) {
    for (const r of e164Hit.data) candidates.push({ id: r.id as number });
  }
  if (national) {
    const natHit = await sb
      .from("mdapi_users")
      .select("id, created_at")
      .eq("phone_number", national)
      .order("created_at", { ascending: false });
    if (!natHit.error && natHit.data) {
      for (const r of natHit.data) {
        if (!candidates.find((c) => c.id === r.id)) {
          candidates.push({ id: r.id as number });
        }
      }
    }
  }
  const playerId = candidates[0]?.id ?? null;
  const ambiguous = candidates.length > 1;

  // -------- get-or-create threadId (per-channel) --------
  // We need threadId BEFORE we can compute the Storage path for any
  // inbound media (deriveMessageRow uses it). So thread upsert is
  // split into a lookup-or-insert step followed by a finalize-fields
  // UPDATE after the row is derived. The text-only path therefore
  // takes one extra UPDATE per new thread compared to before — cheap
  // and only on first inbound from a phone.
  const nowIso = new Date().toISOString();

  const existing = await sb
    .from("crm_threads")
    .select("id, player_id, match_ambiguous")
    .eq("phone_number", phone)
    .eq("channel", "whatsapp")
    .maybeSingle();
  if (existing.error && existing.error.code !== "PGRST116") {
    console.error("[whatsapp:webhook] thread lookup failed", existing.error);
    throw new Error("thread lookup failed");
  }

  let threadId: string;
  let isNewThread = false;
  if (existing.data) {
    threadId = existing.data.id as string;
  } else {
    const ins = await sb
      .from("crm_threads")
      .insert({
        phone_number: phone,
        channel: "whatsapp",
        player_id: playerId,
        match_ambiguous: ambiguous,
        last_message_at: nowIso,
        // Placeholder preview — finalized below after deriveMessageRow.
        last_message_preview: "",
      })
      .select("id")
      .single();
    if (ins.error || !ins.data) {
      console.error("[whatsapp:webhook] thread insert failed", ins.error);
      throw new Error("thread insert failed");
    }
    threadId = ins.data.id as string;
    isNewThread = true;
  }

  // -------- derive message row (heavy: download + upload for media) --------
  const row = await deriveMessageRow(threadId, msg);
  const preview = previewFor(row);

  // -------- finalize thread fields --------
  const patch: Record<string, unknown> = {
    last_message_at: nowIso,
    last_message_preview: preview,
  };
  if (!isNewThread && existing.data) {
    if (existing.data.player_id == null && playerId != null) {
      patch.player_id = playerId;
    }
    if (ambiguous && !existing.data.match_ambiguous) {
      patch.match_ambiguous = true;
    }
  }
  const updT = await sb.from("crm_threads").update(patch).eq("id", threadId);
  if (updT.error) {
    console.error("[whatsapp:webhook] thread update failed", updT.error);
    throw new Error("thread update failed");
  }

  // -------- inbound message insert with wamid dedupe --------
  const msgInsert = await sb.from("crm_messages").insert({
    // Explicit id only when deriveMessageRow pre-allocated one (image
    // upload path — id is part of the Storage key). For all other
    // rows the DB default uuid applies.
    ...(row.id ? { id: row.id } : {}),
    thread_id: threadId,
    direction: "inbound",
    channel: "whatsapp",
    body: row.body,
    sent_at: nowIso,
    external_message_id: wamid,
    media_url: row.media_url,
    media_mime_type: row.media_mime_type,
    media_filename: row.media_filename,
    media_size_bytes: row.media_size_bytes,
    media_kind: row.media_kind,
    reaction_target_wamid: row.reaction_target_wamid ?? null,
  });
  if (msgInsert.error) {
    if (msgInsert.error.code === "23505") {
      console.log(
        `[whatsapp:webhook] dedupe: external_message_id=${wamid} already stored`,
      );
      return null;
    }
    console.error("[whatsapp:webhook] message insert failed", msgInsert.error);
    throw new Error("message insert failed");
  }

  console.log(
    `[whatsapp:webhook] stored phone=${phone} player_id=${playerId ?? "-"} ambiguous=${ambiguous} new_thread=${isNewThread} wamid=${wamid ?? "-"} kind=${row.media_kind ?? "text"}`,
  );

  // Push args for every inbound (new thread or existing). The caller
  // fans out after acking Meta. Reactions intentionally pass
  // mediaKind=null — the row body ("Reacted ❤️ to your message")
  // is self-describing and bodyPreview will surface it verbatim
  // without needing a kind-specific emoji prefix.
  const pushMediaKind =
    row.media_kind === "image" ||
    row.media_kind === "video" ||
    row.media_kind === "audio" ||
    row.media_kind === "document" ||
    row.media_kind === "sticker"
      ? row.media_kind
      : null;
  const pushArgs: Omit<CrmInboundPushArgs, "supabase"> = {
    threadId,
    phoneNumber: phone,
    playerId,
    body: row.body,
    mediaKind: pushMediaKind,
    mediaFilename: row.media_filename,
  };

  if (!isNewThread) return { pushArgs };

  // -------- new-thread Google Chat notification --------
  // Resolve the player's city for the card subtitle (best-effort —
  // a missing match just drops the prefix).
  let cityCode: string | null = null;
  if (playerId != null) {
    const p = await sb
      .from("mdapi_users")
      .select("preferable_city_normalized")
      .eq("id", playerId)
      .maybeSingle();
    if (!p.error && p.data) {
      cityCode =
        (p.data.preferable_city_normalized as string | null) ?? null;
    }
  }

  return {
    pushArgs,
    newThread: {
      threadId,
      cityCode,
      playerPhone: phone,
      messageBody: preview,
    },
  };
}
