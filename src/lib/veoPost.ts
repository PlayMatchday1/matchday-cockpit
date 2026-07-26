// Server-only IO for the Veo auto-poster: post a video link into a match's
// Firestore thread (+ audit row), and load candidate mdapi matches for a
// venue on a date. Kept apart from src/lib/veo.ts so that file stays pure and
// unit-testable; everything here touches Firestore / Supabase.

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import admin from "firebase-admin";
import { firestore } from "@/lib/firebaseAdmin";
import { MATCHDAY_SENDER_NAME, MATCHDAY_SENDER_USER_ID } from "@/lib/matchChats";
import { matchLocalStart, veoMessageText, type VeoCandidateRow } from "@/lib/veo";

// Same branded avatar the /reply route uses so Cockpit-authored messages
// render with the unified "MatchDay" identity in the consumer app. Hosted
// outside the cockpit deployment so cockpit changes can't break historical
// Firestore messages. (Duplicated intentionally — the reply route keeps its
// own copy as the load-bearing source; this must stay in sync with it.)
const MATCHDAY_AVATAR_URL =
  "https://www.playmatchday.com/wp-content/uploads/2023/06/icon2-300x300.jpg";

export type PostResult = { copyMessageId: string; urlMessageId: string };

// Firestore ALREADY_EXISTS gRPC status — a batched create() fails with this
// when the target doc is already there. That's our idempotency signal: the
// pair already committed on a prior attempt, so treat the commit as a no-op.
function isAlreadyExists(err: unknown): boolean {
  const e = err as { code?: number | string; message?: string };
  return e?.code === 6 || e?.code === "6" || /already exists/i.test(e?.message ?? "");
}

function messageDoc(docId: string, text: string) {
  return {
    _id: docId,
    text,
    messageType: "Text",
    sentBy: MATCHDAY_SENDER_NAME,
    sentTo: "Group",
    user: {
      _id: MATCHDAY_SENDER_USER_ID,
      name: MATCHDAY_SENDER_NAME,
      avatar: MATCHDAY_AVATAR_URL,
      email: "",
      phoneNumber: "",
    },
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}

async function insertAudit(
  supabase: SupabaseClient,
  chatId: string,
  docId: string,
  text: string,
  sentByUserId: string | null,
): Promise<void> {
  const ins = await supabase.from("match_chat_audit_log").insert({
    firestore_chat_id: chatId,
    firestore_message_id: docId,
    sent_by_user_id: sentByUserId,
    body: text,
  });
  if (ins.error) {
    console.error(
      `[veo:post] AUDIT GAP message_id=${docId} chat=${chatId} — ${ins.error.code} ${ins.error.message}`,
    );
  }
}

// Post the film into Chats/{chatId}/messages as TWO messages:
//   1. the copy line (veoMessageText(), no URL),
//   2. the bare video URL alone (kept clickable in the players' app).
// Both are written as the "MatchDay" identity in a single ATOMIC WriteBatch —
// they commit together or not at all, so the player can never see the copy
// line without the link. Deterministic doc ids keyed on the recording make it
// idempotent: on a full replay the batched create()s fail ALREADY_EXISTS,
// which we treat as "already posted" (no-op). On any OTHER failure the batch
// wrote NOTHING, so we throw and the caller leaves the recording NOT 'posted'
// (queued as post_failed) for a one-click retry.
export async function postVeoLinkToMatch(args: {
  supabase: SupabaseClient;
  recordingId: string;
  apiId: number;
  videoUrl: string;
  sentByUserId: string | null;
}): Promise<PostResult> {
  const { supabase, recordingId, apiId, videoUrl, sentByUserId } = args;
  const chatId = String(apiId);
  const db = firestore();
  const messages = db.collection("Chats").doc(chatId).collection("messages");

  const copyId = `veo-${recordingId}-copy`;
  const urlId = `veo-${recordingId}-url`;
  const copyText = veoMessageText();

  const batch = db.batch();
  batch.create(messages.doc(copyId), messageDoc(copyId, copyText));
  batch.create(messages.doc(urlId), messageDoc(urlId, videoUrl));

  let freshlyPosted = true;
  try {
    await batch.commit();
  } catch (err) {
    if (!isAlreadyExists(err)) throw err; // real failure → nothing written → post_failed
    freshlyPosted = false; // both already committed on a prior attempt → no-op
  }

  // Audit rows only for a fresh commit (both messages just landed together).
  if (freshlyPosted) {
    await insertAudit(supabase, chatId, copyId, copyText, sentByUserId);
    await insertAudit(supabase, chatId, urlId, videoUrl, sentByUserId);
  }

  return { copyMessageId: copyId, urlMessageId: urlId };
}

// Load the candidate mdapi rows for a venue on a local date: resolve the
// venue's field_ids via fin_venue_fields, then pull that day's non-deleted
// matches. Date filtering uses start_date (venue-local wall clock at UTC
// offset), so the day's rows fall in [date 00:00Z, date 23:59:59Z]. The pure
// selectVeoMatches() then applies the ±window and re-checks the local date.
export async function loadVenueCandidates(
  supabase: SupabaseClient,
  finVenueId: number,
  matchDate: string,
): Promise<VeoCandidateRow[]> {
  const vf = await supabase
    .from("fin_venue_fields")
    .select("mdapi_field_id")
    .eq("fin_venue_id", finVenueId);
  if (vf.error) throw new Error(`fin_venue_fields query failed: ${vf.error.message}`);
  const fieldIds = (vf.data ?? []).map((r) => r.mdapi_field_id as number);
  if (fieldIds.length === 0) return [];

  const dayStart = `${matchDate}T00:00:00Z`;
  const dayEnd = `${matchDate}T23:59:59Z`;
  const m = await supabase
    .from("mdapi_matches")
    .select("api_id, field_id, start_date, is_cancelled")
    .in("field_id", fieldIds)
    .is("deleted_at", null)
    .gte("start_date", dayStart)
    .lte("start_date", dayEnd);
  if (m.error) throw new Error(`mdapi_matches query failed: ${m.error.message}`);
  return (m.data ?? []) as VeoCandidateRow[];
}

// Convenience: a match's local date + minutes for building an assign-time
// candidate label. Re-exported so route handlers don't reach into veo.ts for
// this one helper.
export { matchLocalStart };
