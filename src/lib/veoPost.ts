// Server-only IO for the Veo auto-poster: post a video link into a match's
// Firestore thread (+ audit row), and load candidate mdapi matches for a
// venue on a date. Kept apart from src/lib/veo.ts so that file stays pure and
// unit-testable; everything here touches Firestore / Supabase.

import "server-only";

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import admin from "firebase-admin";
import { firestore } from "@/lib/firebaseAdmin";
import { MATCHDAY_SENDER_NAME, MATCHDAY_SENDER_USER_ID } from "@/lib/matchChats";
import { matchLocalStart, type VeoCandidateRow } from "@/lib/veo";

// Same branded avatar the /reply route uses so Cockpit-authored messages
// render with the unified "MatchDay" identity in the consumer app. Hosted
// outside the cockpit deployment so cockpit changes can't break historical
// Firestore messages. (Duplicated intentionally — the reply route keeps its
// own copy as the load-bearing source; this must stay in sync with it.)
const MATCHDAY_AVATAR_URL =
  "https://www.playmatchday.com/wp-content/uploads/2023/06/icon2-300x300.jpg";

export type PostResult = { firestoreDocId: string; messageId: string };

// Post the Veo link as a plain-text message into Chats/{chatId}/messages,
// written as the "MatchDay" system identity (auto-linkified in the Cockpit
// UI). Mirrors an audit row into match_chat_audit_log — sentByUserId is the
// operator who clicked assign, or null for an automatic post. Throws on a
// Firestore failure so the caller can queue the item as 'post_failed'.
export async function postVeoLinkToMatch(args: {
  supabase: SupabaseClient;
  apiId: number;
  videoUrl: string;
  sentByUserId: string | null;
}): Promise<PostResult> {
  const { supabase, apiId, videoUrl, sentByUserId } = args;
  const chatId = String(apiId);
  const messageId = randomUUID();

  const db = firestore();
  const ref = await db
    .collection("Chats")
    .doc(chatId)
    .collection("messages")
    .add({
      _id: messageId,
      text: videoUrl,
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
    });

  // Audit row alongside the Firestore write, same as the reply route. A
  // failure here is a recoverable audit gap — the message already landed —
  // so we log loudly rather than throw (which would falsely mark the item
  // post_failed and risk a double-post on retry).
  const auditIns = await supabase.from("match_chat_audit_log").insert({
    firestore_chat_id: chatId,
    firestore_message_id: messageId,
    sent_by_user_id: sentByUserId,
    body: videoUrl,
  });
  if (auditIns.error) {
    console.error(
      `[veo:post] AUDIT GAP firestore_doc=${ref.id} message_id=${messageId} chat=${chatId} — ${auditIns.error.code} ${auditIns.error.message}`,
    );
  }

  return { firestoreDocId: ref.id, messageId };
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
