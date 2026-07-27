// Shared two-message Firestore writer. Both the Veo poster and the Community
// invite poster post exactly TWO messages into a match's chat — a copy line
// followed by a bare link — as the "MatchDay" identity. The link must be its
// OWN message or the players' app won't linkify it. This is the single writer;
// callers pass their own deterministic doc ids + text. Do NOT fork this.

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import admin from "firebase-admin";
import { firestore } from "@/lib/firebaseAdmin";
import { MATCHDAY_SENDER_NAME, MATCHDAY_SENDER_USER_ID } from "@/lib/matchChats";

// Same branded avatar the /reply route uses so Cockpit-authored messages
// render with the unified "MatchDay" identity in the consumer app. Hosted
// outside the cockpit deployment so cockpit changes can't break historical
// Firestore messages. (Kept in sync with the copy in the reply route.)
const MATCHDAY_AVATAR_URL =
  "https://www.playmatchday.com/wp-content/uploads/2023/06/icon2-300x300.jpg";

// Firestore ALREADY_EXISTS gRPC status — a batched create() fails with this
// when the target doc is already there. That's the idempotency signal: the
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
  tag: string,
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
      `[${tag}] AUDIT GAP message_id=${docId} chat=${chatId} — ${ins.error.code} ${ins.error.message}`,
    );
  }
}

export type MessagePairResult = {
  copyMessageId: string;
  urlMessageId: string;
  // false when the pair was already present (ALREADY_EXISTS) — an idempotent
  // no-op. Callers use this to decide whether to write their own audit row.
  freshlyPosted: boolean;
};

// Post the copy line + the bare link into Chats/{chatId}/messages as TWO
// messages in ONE atomic WriteBatch (create = write-iff-absent), so a player
// can never see the copy without the link under it. Deterministic doc ids make
// it idempotent: on a full replay the batched create()s fail ALREADY_EXISTS,
// which we treat as a no-op (freshlyPosted=false). Any OTHER failure means the
// batch wrote NOTHING → we throw so the caller doesn't record a false success.
// Per-message match_chat_audit_log rows are written only on a fresh commit.
export async function postMessagePairBatch(args: {
  supabase: SupabaseClient;
  chatId: string;
  copyDocId: string;
  urlDocId: string;
  copyText: string;
  urlText: string;
  sentByUserId: string | null;
  auditTag?: string;
}): Promise<MessagePairResult> {
  const { supabase, chatId, copyDocId, urlDocId, copyText, urlText, sentByUserId } = args;
  const tag = args.auditTag ?? "post";
  const db = firestore();
  const messages = db.collection("Chats").doc(chatId).collection("messages");

  const batch = db.batch();
  batch.create(messages.doc(copyDocId), messageDoc(copyDocId, copyText));
  batch.create(messages.doc(urlDocId), messageDoc(urlDocId, urlText));

  let freshlyPosted = true;
  try {
    await batch.commit();
  } catch (err) {
    if (!isAlreadyExists(err)) throw err; // real failure → nothing written
    freshlyPosted = false; // both already committed on a prior attempt → no-op
  }

  if (freshlyPosted) {
    await insertAudit(supabase, tag, chatId, copyDocId, copyText, sentByUserId);
    await insertAudit(supabase, tag, chatId, urlDocId, urlText, sentByUserId);
  }

  return { copyMessageId: copyDocId, urlMessageId: urlDocId, freshlyPosted };
}
