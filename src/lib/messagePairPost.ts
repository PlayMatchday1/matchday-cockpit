// Shared two-message Firestore writer. Both the Veo poster and the Community
// invite poster post exactly TWO messages into a match's chat — a copy line
// followed by a bare link — as the "MatchDay" identity. The link must be its
// OWN message or the players' app won't linkify it. This is the single writer;
// callers pass their own deterministic doc ids + text. Do NOT fork this.

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { firestore } from "@/lib/firebaseAdmin";
import { insertChatAudit, matchDayMessageDoc } from "@/lib/matchChatWrite";

// Firestore ALREADY_EXISTS gRPC status — a batched create() fails with this
// when the target doc is already there. That's the idempotency signal: the
// pair already committed on a prior attempt, so treat the commit as a no-op.
function isAlreadyExists(err: unknown): boolean {
  const e = err as { code?: number | string; message?: string };
  return e?.code === 6 || e?.code === "6" || /already exists/i.test(e?.message ?? "");
}

// The document shape and the audit row are matchChatWrite.ts's — the same ones the reply box and
// the staff app write — so an auto-post is indistinguishable from a typed MatchDay message.
const messageDoc = matchDayMessageDoc;
const insertAudit = insertChatAudit;

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
