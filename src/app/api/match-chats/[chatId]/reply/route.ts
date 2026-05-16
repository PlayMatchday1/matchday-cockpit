// POST /api/match-chats/[chatId]/reply — Cockpit-side reply to a
// match chat. The Firestore doc is written as "MatchDay" (system
// identity) so players see a unified voice; the actual operator who
// pressed Send is recorded in match_chat_audit_log for internal
// accountability.
//
// Body: { body: string }
//
// Auth: admin-only via src/lib/crmAuth.
//
// Order of operations:
//   1. Generate a UUID for the message `_id` field. Done before any
//      writes so the audit row has a traceable handle even if the
//      Firestore write fails.
//   2. Write to Firestore: Chats/{chatId}/messages/{firestoreDocId}
//      with our generated _id, sentBy=MatchDay, serverTimestamp().
//   3. Audit-log to match_chat_audit_log with sent_by_user_id +
//      firestore_chat_id + firestore_message_id (the _id) + body.
//   4. If the audit insert fails after the Firestore write succeeds,
//      log AUDIT GAP loudly — same pattern as the CRM assign route.
//
// Logging: every reply logged for the first week per the same
// observability stance as Phase 0.

import { randomUUID } from "node:crypto";
import { authenticateCrm } from "@/lib/crmAuth";
import { firestore } from "@/lib/firebaseAdmin";
import admin from "firebase-admin";
import {
  MATCHDAY_SENDER_NAME,
  MATCHDAY_SENDER_USER_ID,
  isValidChatId,
} from "@/lib/matchChats";

export const runtime = "nodejs";
export const maxDuration = 15;

const MAX_BODY_LEN = 4000; // long enough for any reasonable reply

type ReplyBody = { body?: unknown };

type RouteCtx = { params: Promise<{ chatId: string }> };

export async function POST(req: Request, ctx: RouteCtx) {
  const startedAt = Date.now();
  const auth = await authenticateCrm(req);
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }
  const { supabase, appUserId } = auth;
  if (!appUserId) {
    // Match Chats replies require an operator identity.
    return Response.json(
      { error: "Operator identity required" },
      { status: 403 },
    );
  }

  const { chatId } = await ctx.params;
  if (!chatId || !isValidChatId(chatId)) {
    return Response.json(
      { error: "chatId must be a numeric Firestore chat id" },
      { status: 400 },
    );
  }

  let parsed: ReplyBody;
  try {
    parsed = (await req.json()) as ReplyBody;
  } catch {
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const body = typeof parsed.body === "string" ? parsed.body : "";
  if (!body.trim()) {
    return Response.json({ error: "body required" }, { status: 400 });
  }
  if (body.length > MAX_BODY_LEN) {
    return Response.json(
      { error: `body exceeds ${MAX_BODY_LEN} chars` },
      { status: 400 },
    );
  }

  const messageId = randomUUID();

  console.log(
    `[match-chats:reply] start chat=${chatId} message_id=${messageId} user=${appUserId} bytes=${body.length}`,
  );

  // ---------- 1. Firestore write ----------
  const db = firestore();
  let firestoreDocId: string;
  try {
    const ref = await db
      .collection("Chats")
      .doc(chatId)
      .collection("messages")
      .add({
        _id: messageId,
        text: body,
        messageType: "Text",
        sentBy: MATCHDAY_SENDER_NAME,
        sentTo: "Group",
        user: {
          _id: MATCHDAY_SENDER_USER_ID,
          name: MATCHDAY_SENDER_NAME,
          avatar: "",
        },
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    firestoreDocId = ref.id;
  } catch (err) {
    console.error("[match-chats:reply] firestore write failed", err);
    return Response.json(
      { error: "Firestore write failed" },
      { status: 502 },
    );
  }

  // ---------- 2. Audit row ----------
  const auditIns = await supabase.from("match_chat_audit_log").insert({
    firestore_chat_id: chatId,
    firestore_message_id: messageId,
    sent_by_user_id: appUserId,
    body,
  });
  if (auditIns.error) {
    // Firestore message already landed. Loud log; recoverable.
    console.error(
      `[match-chats:reply] AUDIT GAP firestore_doc=${firestoreDocId} message_id=${messageId} chat=${chatId} user=${appUserId} — ${auditIns.error.code} ${auditIns.error.message}`,
    );
  }

  const elapsed = Date.now() - startedAt;
  console.log(
    `[match-chats:reply] done chat=${chatId} firestore_doc=${firestoreDocId} message_id=${messageId} elapsed=${elapsed}ms`,
  );

  return Response.json(
    {
      ok: true,
      firestore_doc_id: firestoreDocId,
      message_id: messageId,
    },
    { status: 200 },
  );
}
