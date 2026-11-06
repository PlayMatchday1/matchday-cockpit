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
  CHAT_MEDIA_BUCKET, DELETED_TEXT, MATCHDAY_AVATAR_URL, MATCHDAY_SENDER_NAME, MATCHDAY_SENDER_USER_ID,
  downloadUrl, editRefusal, isDeletedDoc, isReactionKey, mediaFields, mediaFileName, mediaRoot, messageOut, replyPreviewFor, toggledReactions,
  type ChatEnv, type FirestoreMessage, type MediaExtra, type MessageOut, type PushKind, type Reactions, type ReplyQuote, type Typer,
} from "@/lib/matchChats";
import { pushMatchDayPost, type PushContext, type PushOutcome } from "@/lib/matchChatPush";

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
  | { ok: true; firestoreDocId: string; messageId: string; replyTo: ReplyQuote | null; audited: boolean; push: PushOutcome | null }
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
  /** With a context, the players get the "New message" push after the write (matchChatPush.ts). */
  push?: PushContext | null;
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
  const push = args.push ? await pushMatchDayPost(args.push, chatDocId, "TEXT", body, `${tag}:push`) : null;
  console.log(`[${tag}] done chat=${chatDocId} firestore_doc=${ref.id} message_id=${messageId}${push ? ` push=${push.outcome}` : ""}`);
  return { ok: true, firestoreDocId: ref.id, messageId, replyTo: quote, audited, push };
}

/* ── THE PLAYER APP'S CHAT TOOLS, AS MATCHDAY ──────────────────────────────────────────────────
 * Each writes exactly the fields the player app (MatchDay 1.87) writes, and each leaves an audit
 * row naming the staff member, with a bracketed verb so "what did X do" reads in one column. */

export type ReactResult = { ok: true; docId: string; key: string; on: boolean; reactions: MessageOut["reactions"]; audited: boolean } | Refusal;

/** The player app's saveReaction: a transaction toggling MatchDay's id under the key, reactionsOf = this document. */
export async function toggleMatchDayReaction(args: { supabase: SupabaseClient; chatDocId: string; docId: string; key: string; appUserId: string | null; tag?: string }): Promise<ReactResult> {
  const { supabase, chatDocId, docId, key, appUserId } = args;
  const tag = args.tag ?? "match-chats:react";
  if (!isReactionKey(key)) return { ok: false, status: 400, error: `unknown reaction ${JSON.stringify(key)}` };
  const db = firestore();
  const ref = db.collection("Chats").doc(chatDocId).collection("messages").doc(docId);
  let on = false;
  let after: FirestoreMessage | null = null;
  try {
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return null;
      const m = snap.data() as FirestoreMessage;
      if (isDeletedDoc(docId, m)) return { gone: true as const };
      const current: Reactions | undefined = m.reactionsOf === docId ? (m.reactions ?? undefined) : undefined;
      const next = toggledReactions(current, MATCHDAY_SENDER_USER_ID, key);
      tx.update(ref, { reactions: next, reactionsOf: docId });
      return { m, next };
    });
    if (!result) return { ok: false, status: 404, error: "That message is not in the chat." };
    if ("gone" in result) return { ok: false, status: 409, error: "That message was deleted." };
    on = (result.next[key] ?? []).some((id) => String(id) === String(MATCHDAY_SENDER_USER_ID));
    after = { ...result.m, reactions: result.next, reactionsOf: docId };
  } catch (err) {
    console.error(`[${tag}] transaction failed`, err);
    return { ok: false, status: 502, error: "Firestore write failed" };
  }
  const messageId = typeof after._id === "string" || typeof after._id === "number" ? String(after._id) : docId;
  const audited = await insertChatAudit(supabase, tag, chatDocId, messageId, `[reaction ${key} ${on ? "on" : "off"}] ${replyPreviewFor(after)}`.slice(0, MAX_BODY_LEN), appUserId);
  console.log(`[${tag}] done chat=${chatDocId} doc=${docId} key=${key} on=${on}`);
  return { ok: true, docId, key, on, reactions: messageOut(docId, after).reactions, audited };
}

export type EditResult = { ok: true; docId: string; messageId: string; audited: boolean } | Refusal;

/** The player app's editMessageText, allowed only on a MatchDay text: text replaced, editedAt + editedOf set. */
export async function editMatchDayMessage(args: { supabase: SupabaseClient; chatDocId: string; docId: string; text: string; appUserId: string | null; tag?: string }): Promise<EditResult> {
  const { supabase, chatDocId, docId, appUserId } = args;
  const tag = args.tag ?? "match-chats:edit";
  const text = args.text.trim();
  if (!text) return { ok: false, status: 400, error: "body required" };
  if (text.length > MAX_BODY_LEN) return { ok: false, status: 400, error: `body exceeds ${MAX_BODY_LEN} chars` };
  const ref = firestore().collection("Chats").doc(chatDocId).collection("messages").doc(docId);
  let snap: FirebaseFirestore.DocumentSnapshot;
  try { snap = await ref.get(); } catch (err) { console.error(`[${tag}] read failed`, err); return { ok: false, status: 502, error: "Firestore read failed" }; }
  if (!snap.exists) return { ok: false, status: 404, error: "That message is not in the chat." };
  const m = snap.data() as FirestoreMessage;
  const refusal = editRefusal(docId, m);
  if (refusal) return { ok: false, status: 409, error: refusal };
  try {
    await ref.update({ text, editedAt: admin.firestore.FieldValue.serverTimestamp(), editedOf: docId });
  } catch (err) {
    console.error(`[${tag}] update failed`, err);
    return { ok: false, status: 502, error: "Firestore write failed" };
  }
  const messageId = typeof m._id === "string" || typeof m._id === "number" ? String(m._id) : docId;
  const audited = await insertChatAudit(supabase, tag, chatDocId, messageId, `[edited] ${text}`.slice(0, MAX_BODY_LEN), appUserId);
  console.log(`[${tag}] done chat=${chatDocId} doc=${docId}`);
  return { ok: true, docId, messageId, audited };
}

export type MediaResult = { ok: true; firestoreDocId: string; messageId: string; url: string; thumbnailUrl: string | null; fileName: string; audited: boolean; push: PushOutcome | null } | Refusal;

/** A photo or video as MatchDay: the file (and a video's thumbnail) into the player app's bucket paths, then its message. */
export async function postMatchDayMedia(args: {
  supabase: SupabaseClient; env: ChatEnv; chatDocId: string; appUserId: string | null;
  file: Buffer; contentType: string; thumbnail?: { file: Buffer; contentType: string } | null; extra?: MediaExtra; tag?: string; push?: PushContext | null;
}): Promise<MediaResult> {
  const { supabase, env, chatDocId, appUserId, file, contentType } = args;
  const tag = args.tag ?? "match-chats:media";
  const isVideo = /^video\//.test(contentType);
  if (!isVideo && !/^image\//.test(contentType)) return { ok: false, status: 400, error: "Only a photo or a video can be sent." };
  if (file.length === 0) return { ok: false, status: 400, error: "The file is empty." };
  const bucket = admin.storage().bucket(CHAT_MEDIA_BUCKET);
  const root = mediaRoot(env);
  const fileName = mediaFileName(contentType);
  const base = fileName.replace(/\.[^.]+$/, "");
  const path = `${root}/${isVideo ? "videos" : "images"}/${fileName}`;
  const token = randomUUID();
  let url: string;
  try {
    await bucket.file(path).save(file, { contentType, resumable: false, metadata: { metadata: { firebaseStorageDownloadTokens: token } } });
    url = downloadUrl(CHAT_MEDIA_BUCKET, path, token);
  } catch (err) {
    console.error(`[${tag}] upload failed`, err);
    return { ok: false, status: 502, error: "The file could not be stored." };
  }
  let thumbnailUrl: string | null = null;
  if (isVideo && args.thumbnail && args.thumbnail.file.length > 0) {
    const tpath = `${root}/thumbnails/${base}.jpg`;
    const ttoken = randomUUID();
    try {
      await bucket.file(tpath).save(args.thumbnail.file, { contentType: args.thumbnail.contentType || "image/jpeg", resumable: false, metadata: { metadata: { firebaseStorageDownloadTokens: ttoken } } });
      thumbnailUrl = downloadUrl(CHAT_MEDIA_BUCKET, tpath, ttoken);
    } catch (err) {
      console.error(`[${tag}] thumbnail upload failed, sending without`, err);
    }
  }
  const messageId = randomUUID();
  const messages = firestore().collection("Chats").doc(chatDocId).collection("messages");
  const ref = messages.doc();
  const doc = { ...matchDayMessageDoc(messageId, ""), ...mediaFields(contentType, url, fileName, { ...(args.extra ?? {}), ...(thumbnailUrl ? { thumbnailUrl } : {}), size: file.length }) };
  try {
    await ref.set(doc);
  } catch (err) {
    console.error(`[${tag}] firestore write failed`, err);
    return { ok: false, status: 502, error: "Firestore write failed" };
  }
  const audited = await insertChatAudit(supabase, tag, chatDocId, messageId, `[${isVideo ? "video" : "photo"}] ${fileName}`, appUserId);
  const push = args.push ? await pushMatchDayPost(args.push, chatDocId, isVideo ? "VIDEO" : "IMAGE", null, `${tag}:push`) : null;
  console.log(`[${tag}] done chat=${chatDocId} firestore_doc=${ref.id} file=${path}${push ? ` push=${push.outcome}` : ""}`);
  return { ok: true, firestoreDocId: ref.id, messageId, url, thumbnailUrl, fileName, audited, push };
}

/** The player app's typing entry, as MatchDay: Chats/{chat}/typing/{MatchDay id}, written while composing, removed when done. */
export async function setMatchDayTyping(chatDocId: string, typing: boolean): Promise<void> {
  const ref = firestore().collection("Chats").doc(chatDocId).collection("typing").doc(String(MATCHDAY_SENDER_USER_ID));
  if (typing) await ref.set({ userId: MATCHDAY_SENDER_USER_ID, name: MATCHDAY_SENDER_NAME, avatar: MATCHDAY_AVATAR_URL, at: admin.firestore.FieldValue.serverTimestamp() });
  else await ref.delete();
}

/** Every typing entry of the chat, as stored (the app keeps the live ones with activeTypers). */
export async function readTypers(chatDocId: string): Promise<Typer[]> {
  const snap = await firestore().collection("Chats").doc(chatDocId).collection("typing").get();
  return snap.docs.map((d) => {
    const x = d.data() as { userId?: string | number; name?: string; at?: admin.firestore.Timestamp | null };
    return { userId: x.userId ?? d.id, name: x.name ?? "", at: x.at && typeof x.at.toDate === "function" ? x.at.toDate().toISOString() : null };
  });
}

export type { PushKind };

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
