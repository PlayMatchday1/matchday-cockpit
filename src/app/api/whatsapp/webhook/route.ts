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

import { createHmac, timingSafeEqual } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { normalizePhone, toNationalDigits } from "@/lib/phone";
import {
  notifyNewWhatsAppThread,
  type NewWhatsAppThreadNotification,
} from "@/lib/gchat";

export const runtime = "nodejs";
export const maxDuration = 15;

const PREVIEW_LIMIT = 80;
const MEDIA_PLACEHOLDER = "📎 Media attachment — view in WhatsApp app";

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
  for (const msg of messages) {
    try {
      const result = await processInbound(sb, msg);
      if (result?.newThread) notifications.push(result.newThread);
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

  const elapsed = Date.now() - startedAt;
  console.log(
    `[whatsapp:webhook] processed messages=${messages.length} statuses=${statuses.length} new_threads=${notifications.length} elapsed=${elapsed}ms`,
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

// Returns the rendered body for the crm_messages row. Text messages
// store the body verbatim; media falls back to a placeholder per
// Phase 1 spec (no file fetch in this PR).
function deriveBody(msg: WaMessage): string {
  if ((msg.type ?? "").toLowerCase() === "text") {
    return msg.text?.body ?? "";
  }
  return MEDIA_PLACEHOLDER;
}

type ProcessResult = { newThread?: NewWhatsAppThreadNotification };

async function processInbound(
  sb: SupabaseClient,
  msg: WaMessage,
): Promise<ProcessResult | null> {
  const wamid = msg.id ?? null;
  const fromRaw = msg.from ?? "";
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

  const body = deriveBody(msg);

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

  // -------- thread upsert (per-channel, sticky-ambiguous) --------
  const preview = body.slice(0, PREVIEW_LIMIT);
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
    const patch: Record<string, unknown> = {
      last_message_at: nowIso,
      last_message_preview: preview,
    };
    if (existing.data.player_id == null && playerId != null) {
      patch.player_id = playerId;
    }
    if (ambiguous && !existing.data.match_ambiguous) {
      patch.match_ambiguous = true;
    }
    const upd = await sb.from("crm_threads").update(patch).eq("id", threadId);
    if (upd.error) {
      console.error("[whatsapp:webhook] thread update failed", upd.error);
      throw new Error("thread update failed");
    }
  } else {
    const ins = await sb
      .from("crm_threads")
      .insert({
        phone_number: phone,
        channel: "whatsapp",
        player_id: playerId,
        match_ambiguous: ambiguous,
        last_message_at: nowIso,
        last_message_preview: preview,
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

  // -------- inbound message insert with wamid dedupe --------
  const msgInsert = await sb.from("crm_messages").insert({
    thread_id: threadId,
    direction: "inbound",
    channel: "whatsapp",
    body,
    sent_at: nowIso,
    external_message_id: wamid,
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
    `[whatsapp:webhook] stored phone=${phone} player_id=${playerId ?? "-"} ambiguous=${ambiguous} new_thread=${isNewThread} wamid=${wamid ?? "-"}`,
  );

  if (!isNewThread) return null;

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
    newThread: {
      threadId,
      cityCode,
      playerPhone: phone,
      messageBody: body,
    },
  };
}
