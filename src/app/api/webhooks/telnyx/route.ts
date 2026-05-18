// POST /api/webhooks/telnyx — inbound SMS webhook for the CRM MVP.
//
// Flow:
//   1. Read raw body + verify Ed25519 signature via Telnyx SDK
//      (TELNYX_PUBLIC_KEY = base64 key from Mission Control).
//   2. Parse the event. Only `message.received` is handled; everything
//      else (DLRs, status updates) gets a 200 and is ignored.
//   3. Normalize the `from.phone_number` to E.164. If
//      libphonenumber rejects it, log and return 200 — do NOT create
//      a thread, do NOT 4xx (Telnyx would retry indefinitely).
//   4. Match mdapi_users by phone_number: try E.164 first, fall back
//      to bare 10-digit national (mdapi_users.phone_number is a mix
//      of both shapes). Tiebreak by oldest created_at. If >1
//      candidate, set match_ambiguous=true on the thread so the UI
//      can flag it.
//   5. Upsert crm_threads keyed on phone_number. Insert crm_messages
//      with direction=inbound, telnyx_message_id (deduped by partial
//      unique index — replays are a no-op). Update thread
//      last_message_at + last_message_preview (first 80 chars).
//   6. Return 200 fast. No background work, no notifications.
//
// Auth: signature verification is the ONLY auth — no bearer header,
// no shared secret beyond the public key. Reject with 401 on any
// signature failure.
//
// Logging: every hit is logged to console for the first week so we
// can see what is actually flowing. Format: "[crm:webhook] ...".

import { TelnyxWebhook, TelnyxWebhookVerificationError } from "telnyx";
import { createClient } from "@supabase/supabase-js";
import { normalizePhone, toNationalDigits } from "@/lib/phone";
import { notifyInboundChatMessage } from "@/lib/crmPushNotify";

export const runtime = "nodejs";
export const maxDuration = 10;

// Shape of the Telnyx inbound webhook (just the fields we read).
// Full schema:
// https://developers.telnyx.com/api/messaging/webhooks
type TelnyxInboundEvent = {
  data?: {
    event_type?: string;
    id?: string;
    payload?: {
      id?: string;
      text?: string;
      from?: { phone_number?: string };
    };
  };
};

const PREVIEW_LIMIT = 80;

export async function POST(req: Request) {
  const startedAt = Date.now();

  const publicKey = process.env.TELNYX_PUBLIC_KEY;
  if (!publicKey) {
    console.error("[crm:webhook] TELNYX_PUBLIC_KEY not configured");
    return Response.json({ error: "Server not configured" }, { status: 500 });
  }

  // Read once as text — the SDK verifies against the raw payload string,
  // so we cannot use req.json() here.
  const raw = await req.text();

  // Convert Headers to Record for the SDK's verify method.
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    headers[k] = v;
  });

  try {
    const verifier = new TelnyxWebhook(publicKey);
    await verifier.verify(raw, headers);
  } catch (err) {
    if (err instanceof TelnyxWebhookVerificationError) {
      console.warn("[crm:webhook] signature verification failed", err.message);
      return Response.json({ error: "Invalid signature" }, { status: 401 });
    }
    console.error("[crm:webhook] verify threw unexpected error", err);
    return Response.json({ error: "Verification error" }, { status: 401 });
  }

  let evt: TelnyxInboundEvent;
  try {
    evt = JSON.parse(raw) as TelnyxInboundEvent;
  } catch {
    console.warn("[crm:webhook] payload not JSON");
    return Response.json({ error: "Bad payload" }, { status: 400 });
  }

  const eventType = evt.data?.event_type ?? "(none)";
  const eventId = evt.data?.id ?? "(none)";
  console.log(`[crm:webhook] hit event=${eventType} id=${eventId}`);

  // Telnyx sends many event types (message.sent, message.finalized,
  // message.failed). Phase 0 only cares about inbound — silently 200
  // the rest so Telnyx doesn't retry.
  if (eventType !== "message.received") {
    return Response.json({ ok: true, ignored: eventType }, { status: 200 });
  }

  const payload = evt.data?.payload;
  const fromRaw = payload?.from?.phone_number ?? "";
  const body = payload?.text ?? "";
  const telnyxMessageId = payload?.id ?? null;

  const phone = normalizePhone(fromRaw);
  if (!phone) {
    console.warn(
      `[crm:webhook] dropped: unparseable from=${JSON.stringify(fromRaw)}`,
    );
    // 200 so Telnyx doesn't retry — there's nothing actionable.
    return Response.json({ ok: true, dropped: "bad-phone" }, { status: 200 });
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    console.error("[crm:webhook] Supabase env not configured");
    return Response.json({ error: "Server not configured" }, { status: 500 });
  }
  const sb = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ---------------- match against mdapi_users ----------------
  // Two candidate keys: E.164 ("+15125550123") and bare national
  // ("5125550123"). Order by created_at DESC — newest signup wins.
  //
  // MatchDay enforces "one active account per phone number" at
  // signup, so duplicate rows with the same phone are historical
  // artifacts (abandoned re-registrations, legacy data) rather than
  // parallel active accounts. The most recently created row is
  // always the right active account to attach the conversation to.
  // match_ambiguous still flips to true when duplicates exist — it
  // now means "this phone has historical accounts on file" rather
  // than "we don't know which player this is."
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
        // Dedupe in case a user appears in both lookups (unlikely
        // but safe).
        if (!candidates.find((c) => c.id === r.id)) {
          candidates.push({ id: r.id as number });
        }
      }
    }
  }

  const playerId = candidates[0]?.id ?? null;
  const ambiguous = candidates.length > 1;

  // ---------------- upsert thread ----------------
  const preview = body.slice(0, PREVIEW_LIMIT);
  const nowIso = new Date().toISOString();

  // Read-then-update because we need different update behavior for
  // existing vs new rows: existing threads shouldn't have their
  // player_id silently flipped to null on a future unmatched lookup
  // (e.g. a temporary mdapi_users sync gap).
  const existing = await sb
    .from("crm_threads")
    .select("id, player_id, match_ambiguous")
    .eq("phone_number", phone)
    .maybeSingle();

  let threadId: string;
  if (existing.error && existing.error.code !== "PGRST116") {
    console.error("[crm:webhook] thread lookup failed", existing.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }

  if (existing.data) {
    threadId = existing.data.id as string;
    const patch: Record<string, unknown> = {
      last_message_at: nowIso,
      last_message_preview: preview,
    };
    // Only flip player_id if the thread was previously unlinked and
    // we now have a candidate. Never overwrite a known player.
    if (existing.data.player_id == null && playerId != null) {
      patch.player_id = playerId;
    }
    // Sticky once true: once ambiguous, stays ambiguous until corp
    // resolves it (no UI for that in MVP — column carries the flag).
    if (ambiguous && !existing.data.match_ambiguous) {
      patch.match_ambiguous = true;
    }
    const upd = await sb.from("crm_threads").update(patch).eq("id", threadId);
    if (upd.error) {
      console.error("[crm:webhook] thread update failed", upd.error);
      return Response.json({ error: "DB error" }, { status: 500 });
    }
  } else {
    const ins = await sb
      .from("crm_threads")
      .insert({
        phone_number: phone,
        player_id: playerId,
        match_ambiguous: ambiguous,
        last_message_at: nowIso,
        last_message_preview: preview,
      })
      .select("id")
      .single();
    if (ins.error || !ins.data) {
      console.error("[crm:webhook] thread insert failed", ins.error);
      return Response.json({ error: "DB error" }, { status: 500 });
    }
    threadId = ins.data.id as string;
  }

  // ---------------- insert inbound message ----------------
  const msgInsert = await sb.from("crm_messages").insert({
    thread_id: threadId,
    direction: "inbound",
    body,
    sent_at: nowIso,
    telnyx_message_id: telnyxMessageId,
  });
  if (msgInsert.error) {
    // 23505 = unique_violation on telnyx_message_id (replay).
    if (msgInsert.error.code === "23505") {
      console.log(
        `[crm:webhook] dedupe: telnyx_message_id=${telnyxMessageId} already stored`,
      );
      return Response.json({ ok: true, deduped: true }, { status: 200 });
    }
    console.error("[crm:webhook] message insert failed", msgInsert.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }

  // Web Push fan-out. notifyInboundChatMessage self-bounds at 2s
  // internally so a slow push service can't stall the Telnyx ack.
  // Errors logged but never thrown — webhook ack must succeed
  // regardless.
  await notifyInboundChatMessage({
    threadId,
    phoneNumber: phone,
    playerId,
    body,
    mediaKind: null,
    mediaFilename: null,
    supabase: sb,
  });

  const elapsed = Date.now() - startedAt;
  console.log(
    `[crm:webhook] stored phone=${phone} player_id=${playerId ?? "-"} ambiguous=${ambiguous} candidates=${candidates.length} elapsed=${elapsed}ms`,
  );

  return Response.json(
    { ok: true, thread_id: threadId, ambiguous },
    { status: 200 },
  );
}
