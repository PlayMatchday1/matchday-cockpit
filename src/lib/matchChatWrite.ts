// THE MATCHDAY VOICE IN A MATCH CHAT, written once. Every Clubhouse post into Chats/{chat}/messages
// — the desktop's reply box, the staff app's composer, the Veo and community auto-posts — is the
// same document: sentBy "MatchDay", the all-nines sender id and the branded avatar (matchChats.ts),
// so players see one voice. Who actually pressed Send is the audit row in match_chat_audit_log
// (migration 0031): firestore_message_id is the message's own _id, sent_by_user_id the operator.
//
// A REPLY carries the player app's own snapshot of the quoted message (replyTo) and the copy marker
// replyOf = this document's id, so the document id is chosen before the write, exactly as the
// player app does (useChatRoom.sendText). A DELETE is the player app's soft delete, field for field
// (messageEdits.ts deleteMessage): the text becomes "This message was deleted", the photo or video
// goes, messageType becomes Text so MatchDay 1.85 does not crash on a missing media.url, deletedAt
// / deletedBy / deletedOf hide it on 1.87, and the replies that quote it lose their preview. Nothing
// is ever hard deleted. The operator who deleted is the audit row whose body starts "[deleted]".

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import admin from "firebase-admin";
import { randomUUID } from "node:crypto";
import { firestore } from "@/lib/firebaseAdmin";
import {
  DELETED_TEXT, MATCHDAY_AVATAR_URL, MATCHDAY_SENDER_NAME, MATCHDAY_SENDER_USER_ID,
  isDeletedDoc, messageOut, replyPreviewFor, type FirestoreMessage, type MessageOut, type ReplyQuote,
} from "@/lib/matchChats";

export const MAX_BODY_LEN = 4000;

/** The Firestore document every Clubhouse-authored message is: full parity with a player's row. */
export function matchDayMessageDoc(messageId: string, text: string) {
  return {
    _id: messageId,
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

/** One audit row per Clubhouse write. A failed insert is an AUDIT GAP in the log, never a failed send. */
export async function insertChatAudit(supabase: SupabaseClient, tag: string, chatId: string, messageId: string, body: string, sentByUserId: string | null): Promise<boolean> {
  const ins = await supabase.from("match_chat_audit_log").insert({ firestore_chat_id: chatId, firestore_message_id: messageId, sent_by_user_id: sentByUserId, body });
  if (ins.error) {
    console.error(`[${tag}] AUDIT GAP message_id=${messageId} chat=${chatId} user=${sentByUserId ?? "?"} — ${ins.error.code} ${ins.error.message}`);
    return false;
  }
  return true;
}

export type Refusal = { ok: false; status: number; error: string };

export type PostResult =
  | { ok: true; firestoreDocId: string; messageId: string; replyTo: ReplyQuote | null; audited: boolean }
  | Refusal;

/** Post one text as MatchDay, optionally as a reply to a message in the same chat. */
export async function postMatchDayText(args: {
  supabase: SupabaseClient;
  /** The Firestore parent document id, prefix included (matchChats.ts firestoreChatId). */
  chatDocId: string;
  body: string;
  appUserId: string | null;
  replyToDocId?: string | null;
  tag?: string;
}): Promise<PostResult> {
  const { supabase, chatDocId, body, appUserId } = args;
  const tag = args.tag ?? "match-chats:reply";
  if (!body.trim()) return { ok: false, status: 400, error: "body required" };
  if (body.length > MAX_BODY_LEN) return { ok: false, status: 400, error: `body exceeds ${MAX_BODY_LEN} chars` };

  const db = firestore();
  const messages = db.collection("Chats").doc(chatDocId).collection("messages");

  let quote: ReplyQuote | null = null;
  if (args.replyToDocId) {
    let snap: FirebaseFirestore.DocumentSnapshot;
    try {
      snap = await messages.doc(args.replyToDocId).get();
    } catch (err) {
      console.error(`[${tag}] quoted message read failed`, err);
      return { ok: false, status: 502, error: "Firestore read failed" };
    }
    const q = snap.exists ? (snap.data() as FirestoreMessage) : null;
    if (!q || isDeletedDoc(snap.id, q)) return { ok: false, status: 409, error: "The message you are replying to is no longer in the chat." };
    quote = { docId: snap.id, userId: q.user?._id ?? null, name: q.user?.name || "A player", preview: replyPreviewFor(q), messageType: q.messageType || "Text" };
  }

  const messageId = randomUUID();
  const ref = messages.doc();
  console.log(`[${tag}] start chat=${chatDocId} message_id=${messageId} user=${appUserId ?? "?"} bytes=${body.length}${quote ? ` reply_to=${quote.docId}` : ""}`);
  try {
    await ref.set({ ...matchDayMessageDoc(messageId, body), ...(quote ? { replyTo: quote, replyOf: ref.id } : {}) });
  } catch (err) {
    console.error(`[${tag}] firestore write failed`, err);
    return { ok: false, status: 502, error: "Firestore write failed" };
  }
  const audited = await insertChatAudit(supabase, tag, chatDocId, messageId, body, appUserId);
  console.log(`[${tag}] done chat=${chatDocId} firestore_doc=${ref.id} message_id=${messageId}`);
  return { ok: true, firestoreDocId: ref.id, messageId, replyTo: quote, audited };
}

export type DeleteResult =
  | { ok: true; docId: string; messageId: string; already: boolean; quotesBlanked: number; audited: boolean }
  | Refusal;

/** The player app's "Delete for everyone", done as MatchDay. */
export async function deleteMatchChatMessage(args: { supabase: SupabaseClient; chatDocId: string; docId: string; appUserId: string | null; tag?: string }): Promise<DeleteResult> {
  const { supabase, chatDocId, docId, appUserId } = args;
  const tag = args.tag ?? "match-chats:delete";
  const db = firestore();
  const messages = db.collection("Chats").doc(chatDocId).collection("messages");
  let snap: FirebaseFirestore.DocumentSnapshot;
  try {
    snap = await messages.doc(docId).get();
  } catch (err) {
    console.error(`[${tag}] read failed`, err);
    return { ok: false, status: 502, error: "Firestore read failed" };
  }
  if (!snap.exists) return { ok: false, status: 404, error: "That message is not in the chat." };
  const m = snap.data() as FirestoreMessage;
  const messageId = typeof m._id === "string" || typeof m._id === "number" ? String(m._id) : docId;
  if (isDeletedDoc(docId, m)) return { ok: true, docId, messageId, already: true, quotesBlanked: 0, audited: false };

  const was = m.text && m.text.trim() ? m.text : replyPreviewFor(m) || m.messageType || "";
  console.log(`[${tag}] start chat=${chatDocId} doc=${docId} message_id=${messageId} user=${appUserId ?? "?"} by=${m.sentBy}`);
  try {
    await snap.ref.update({
      text: DELETED_TEXT,
      messageType: "Text",
      image: admin.firestore.FieldValue.delete(),
      media: admin.firestore.FieldValue.delete(),
      deletedAt: admin.firestore.FieldValue.serverTimestamp(),
      deletedBy: String(MATCHDAY_SENDER_USER_ID),
      deletedOf: docId,
    });
  } catch (err) {
    console.error(`[${tag}] firestore update failed`, err);
    return { ok: false, status: 502, error: "Firestore write failed" };
  }
  // The replies that quote it keep "Message deleted" instead of the words, as the player app does.
  let quotesBlanked = 0;
  try {
    const replies = await messages.where("replyTo.docId", "==", docId).get();
    await Promise.all(replies.docs.map((d) => d.ref.update({ "replyTo.preview": "" })));
    quotesBlanked = replies.size;
  } catch (err) {
    console.error(`[${tag}] quote blanking failed (the delete itself landed)`, err);
  }
  const audited = await insertChatAudit(supabase, tag, chatDocId, messageId, `[deleted] ${was}`.slice(0, MAX_BODY_LEN), appUserId);
  console.log(`[${tag}] done chat=${chatDocId} doc=${docId} quotes_blanked=${quotesBlanked}`);
  return { ok: true, docId, messageId, already: false, quotesBlanked, audited };
}

/** One message read back by document id, in the app's shape; null when it is not there. */
export async function readMessage(chatDocId: string, docId: string): Promise<MessageOut | null> {
  const snap = await firestore().collection("Chats").doc(chatDocId).collection("messages").doc(docId).get();
  return snap.exists ? messageOut(snap.id, snap.data() as FirestoreMessage) : null;
}

/** The newest messages of a chat, oldest first, hidden deletes dropped; `before` pages back from a document id. */
export async function readMessages(chatDocId: string, limit: number, before?: string | null): Promise<{ messages: MessageOut[]; hasMore: boolean }> {
  const messages = firestore().collection("Chats").doc(chatDocId).collection("messages");
  let q = messages.orderBy("createdAt", "desc").limit(limit);
  if (before) {
    const cursor = await messages.doc(before).get();
    if (cursor.exists) q = q.startAfter(cursor);
  }
  const snap = await q.get();
  const out = snap.docs.map((d) => messageOut(d.id, d.data() as FirestoreMessage)).filter((m) => !m.deleted).reverse();
  return { messages: out, hasMore: snap.docs.length >= limit };
}
