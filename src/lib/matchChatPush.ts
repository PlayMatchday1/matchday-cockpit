// THE "NEW MESSAGE" PUSH FOR A MATCHDAY POST (Ryan, 2026-11-06).
//
// The player app, after every message it writes, asks the MatchDay API to push the match's
// players: POST chats/matches/{id}/notifications {message, type}. The API resolves the devices
// itself (user_devices of the match's paid or free, uncancelled registrations, the city's managers
// too, minus whoever muted this chat, minus anyone with pushes off, minus the caller) and sends one
// FCM message per device with the match name as the title and the message as the body. Nothing
// here chooses a recipient; the API's rule is the rule.
//
// A MatchDay post asks the same endpoint through the Clubhouse's MatchDay API account, for the
// environment the chat belongs to, with the body naming MatchDay (the push has no sender slot).
// ONE PUSH PER BURST: the chat's parent document carries the time of the last MatchDay push; a
// post within PUSH_WINDOW_MS of it is held back, decided in a transaction so two staff posting at
// once cannot both push. A held or failed push never fails the post — the message is in the chat.

import "server-only";

import admin from "firebase-admin";
import { firestore } from "@/lib/firebaseAdmin";
import { pushBody, pushDecision, type ChatEnv, type PushKind } from "@/lib/matchChats";
import { apiWrite, type WriteActor } from "@/lib/matchdayStageApi";

export type PushContext = { env: ChatEnv; matchId: string; actor: WriteActor };
export type PushOutcome = { outcome: "sent" | "held" | "failed" | "refused"; reason: string; body: string };

export async function pushMatchDayPost(ctx: PushContext, chatDocId: string, kind: PushKind, text: string | null, tag = "match-chats:push"): Promise<PushOutcome> {
  const body = pushBody(kind, text);
  const db = firestore();
  const parent = db.collection("Chats").doc(chatDocId);
  let decision: { send: boolean; reason: string };
  try {
    decision = await db.runTransaction(async (tx) => {
      const snap = await tx.get(parent);
      const last = snap.exists ? (snap.data()?.matchDayPushAt as admin.firestore.Timestamp | undefined) : undefined;
      const d = pushDecision(last ? last.toMillis() : null, Date.now());
      if (d.send) tx.set(parent, { matchDayPushAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      return d;
    });
  } catch (err) {
    console.error(`[${tag}] throttle transaction failed`, err);
    return { outcome: "failed", reason: "the push throttle could not be read", body };
  }
  if (!decision.send) {
    console.log(`[${tag}] held chat=${chatDocId}: ${decision.reason}`);
    return { outcome: "held", reason: decision.reason, body };
  }
  try {
    await apiWrite(ctx.env, "POST", `/chats/matches/${ctx.matchId}/notifications`, { message: body, type: kind }, ctx.actor, "chats");
    console.log(`[${tag}] sent env=${ctx.env} match=${ctx.matchId} kind=${kind}`);
    return { outcome: "sent", reason: "sent", body };
  } catch (err) {
    const e = err as Error;
    console.error(`[${tag}] push failed env=${ctx.env} match=${ctx.matchId}`, e.message);
    return { outcome: e.name === "NotAuthorizedError" ? "refused" : "failed", reason: e.message.slice(0, 200), body };
  }
}
