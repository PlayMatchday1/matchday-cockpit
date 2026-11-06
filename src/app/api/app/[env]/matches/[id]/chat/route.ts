// Staff app: ONE MATCH CHAT, per environment (Ryan, 2026-11-05).
//
//   GET  /api/app/{env}/matches/{id}/chat                 the chat's match, its newest messages, the
//                                                          caller's rights; ?before=<doc id> pages back
//   POST /api/app/{env}/matches/{id}/chat  { op: "send", body, replyTo? }   post as MatchDay, or reply
//                                          { op: "delete", docId }           the player app's soft delete
//                                          { op: "react", docId, key }       toggle a reaction as MatchDay
//                                          { op: "edit", docId, body }       edit a MatchDay text
//                                          { op: "typing", typing }          MatchDay's typing entry
//   GET  …/chat?typing=1                                            only who is typing (polled)
//   POST …/chat/media (multipart)                                    a photo or video as MatchDay
//
// THE PLAYER APP'S TOOLS, AS MATCHDAY (Ryan, 2026-11-06): each op writes exactly the fields the
// player app (MatchDay 1.87) writes, through matchChatWrite.ts, and leaves an audit row naming the
// staff member. A post (text or media) then asks the MatchDay API for the players' "New message"
// push, one per burst (matchChatPush.ts).
//
// THE SAME CHAT THE DESKTOP SHOWS, THROUGH THE SAME WRITER. A message posted here is the document the
// desktop reply box writes (matchChatWrite.ts postMatchDayText): sentBy MatchDay, the all-nines
// sender, the audit row with this staff member. The desktop itself has no delete; the delete here is
// the player app's own "Delete for everyone" (its 1.87 messageEdits.ts), as MatchDay, audited.
//
// STAGING STAYS IN STAGING. The player app keeps a staging build's chats under Chats/staging_{id}
// (one Firebase project for both environments, ids that collide), and so does this route: in staging
// nothing it reads or writes can be a production match's chat.
//
// PERMISSIONS ARE THE DESKTOP'S, through the app's own auth: the Chats box (can_access_chats, or
// admin) to read, the match's city, and SENDING IS ITS OWN RIGHT (can_send_messages) for every
// write, as on every other send path — the same capability function the desktop routes call.
// (authenticateCrm itself is not used: its route allow-list for a confined account names the
// desktop's paths, and an app path would be refused before the city was even looked at.)
//
// THE CITY CHECK READS THE LIVE MATCH, as the app's match route does, never the production mirror:
// a staging id is also some production match's id (2833 on staging is Austin's test field; the
// mirror's 2833 is another city's match, and the desktop's mirror-first check refused the Austin
// test account on it). The match is read once, in the environment asked for, and both the city
// check and the header come from that read.
//
// EVERY WRITE IS READ BACK. The response carries the document as it is in Firestore after the write,
// in the same shape the list gives, and the app shows the message only once a read holds it.

import { localModeRefusal } from "@/lib/localMode";
import { authenticateApp, readRefusal } from "@/lib/appAuth";
import { can } from "@/lib/capabilities";
import { cityAllowed } from "@/lib/appModel";
import { CONFINED_CITY_ERROR } from "@/lib/cityConfinement";
import { firestoreChatId, isValidChatId, MESSAGE_PAGE_SIZE } from "@/lib/matchChats";
import { deleteMatchChatMessage, editMatchDayMessage, MAX_BODY_LEN, postMatchDayText, readMessage, readMessages, readTypers, setMatchDayTyping, toggleMatchDayReaction } from "@/lib/matchChatWrite";
import type { PushContext } from "@/lib/matchChatPush";
import { isEnv } from "@/lib/appLive";
import { apiGet, StageConfigError, StageHostGuardError } from "@/lib/matchdayStageApi";
import { reviewMasked } from "@/lib/reviewAccount";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;

type Row = Record<string, unknown>;
type Ctx = { params: Promise<{ env: string; id: string }> };

/** The chat's match, read live (the mirror has no staging rows and lags a day on production). */
export async function chatMatch(env: "staging" | "production", id: string) {
  const m = await apiGet<Row>(env, `/admin/matches/${id}`);
  const field = (m.field as Row | undefined) ?? {};
  const city = (field.city as Row | undefined) ?? {};
  const tz = (city.timeZone as Row | undefined) ?? {};
  const mgr = (m.manager as Row | null | undefined) ?? null;
  const count = (m._count as Row | undefined) ?? {};
  const num = (v: unknown) => (typeof v === "number" ? v : v == null ? null : Number(v));
  const managerIds = [num(m.managerId), num(mgr?.id)].filter((x): x is number => x != null && Number.isFinite(x));
  return {
    api_id: Number(id),
    field_title: (typeof field.title === "string" && field.title.trim()) || null,
    field_cover: (typeof field.cover === "string" && field.cover) || null,
    start_date_utc: (typeof m.startDateUtc === "string" && m.startDateUtc) || null,
    city_name: (typeof city.name === "string" && city.name) || null,
    time_zone: (typeof tz.name === "string" && tz.name) || null,
    is_cancelled: m.isCancelled === true,
    player_count: num(count.players) ?? 0,
    fake_player_count: num(count.fakePlayers) ?? 0,
    manager_name: mgr ? [mgr.firstName, mgr.lastName].filter((x) => typeof x === "string" && x).join(" ").trim() || null : null,
    manager_ids: [...new Set(managerIds)],
  };
}

function apiFailure(err: unknown): Response {
  if (err instanceof StageConfigError || err instanceof StageHostGuardError) return Response.json({ error: err.message }, { status: 503 });
  console.error("[app:match-chat] live match read failed", err);
  return Response.json({ error: "The match could not be read from MatchDay." }, { status: 502 });
}

async function gate(req: Request, ctx: Ctx) {
  const auth = await authenticateApp(req);
  if (!auth.ok) return { refused: Response.json({ error: auth.error }, { status: auth.status }) } as const;
  const refusedRead = readRefusal(auth);
  if (refusedRead) return { refused: Response.json({ error: refusedRead.error }, { status: refusedRead.status }) } as const;
  if (!can(auth.row, "chats", auth.email)) return { refused: Response.json({ error: "Chats access required" }, { status: 403 }) } as const;
  const { env, id } = await ctx.params;
  if (!isEnv(env)) return { refused: Response.json({ error: `unknown environment ${JSON.stringify(env)}` }, { status: 400 }) } as const;
  if (!isValidChatId(id)) return { refused: Response.json({ error: "match id must be numeric" }, { status: 400 }) } as const;
  let match: Awaited<ReturnType<typeof chatMatch>>;
  try {
    match = await chatMatch(env, id);
  } catch (err) {
    return { refused: apiFailure(err) } as const;
  }
  // Deny by default: a confined account whose city the live match does not name is refused.
  if (!cityAllowed(auth, auth.scopeCityName, match.city_name)) {
    return { refused: Response.json({ error: CONFINED_CITY_ERROR }, { status: 403 }) } as const;
  }
  const canSend = can(auth.row, "sendMessages", auth.email);
  /* THE PUSH ACTOR: the same rights the caller holds, so the MatchDay API write behind the push is
   * guarded by SEND MESSAGES exactly as the post itself is. */
  const push: PushContext = { env, matchId: id, actor: { canEditMatches: can(auth.row, "editMatches", auth.email), canSendMessages: canSend, email: auth.email, userId: auth.appUserId } };
  return { auth, env, id, match, canSend, push, chatDocId: firestoreChatId(env, id) } as const;
}

export async function chatGate(req: Request, ctx: Ctx) { return gate(req, ctx); }

async function getRoute(req: Request, ctx: Ctx) {
  { const local = localModeRefusal("Match chat"); if (local) return local; }
  const g = await gate(req, ctx);
  if ("refused" in g) return g.refused;
  const url = new URL(req.url);
  if (url.searchParams.get("typing") === "1") {
    try {
      return Response.json({ chat_id: g.id, typers: await readTypers(g.chatDocId), now: new Date().toISOString() });
    } catch (err) {
      console.error("[app:match-chat] typing read failed", err);
      return Response.json({ error: "Firestore read failed" }, { status: 502 });
    }
  }
  const before = url.searchParams.get("before");
  const cursor = before && /^[A-Za-z0-9_-]{1,64}$/.test(before) ? before : null;

  try {
    const [page, typers] = await Promise.all([readMessages(g.chatDocId, MESSAGE_PAGE_SIZE, cursor), readTypers(g.chatDocId).catch(() => [])]);
    return Response.json({
      typers,
      now: new Date().toISOString(),
      chat_id: g.id,
      env: g.env,
      chat_doc_id: g.chatDocId,
      match: g.match,
      messages: page.messages,
      limit: MESSAGE_PAGE_SIZE,
      has_more: page.hasMore,
      can_send: g.canSend,
      // Notify players texts the production mirror's registered players through the desktop's own
      // route (/api/match-chats/{id}/notify); there is no staging phone to text.
      can_notify: g.env === "production",
    });
  } catch (err) {
    console.error("[app:match-chat] firestore read failed", err);
    return Response.json({ error: "Firestore read failed" }, { status: 502 });
  }
}

type Body = { op?: unknown; body?: unknown; replyTo?: unknown; docId?: unknown; key?: unknown; typing?: unknown };

async function postRoute(req: Request, ctx: Ctx) {
  { const local = localModeRefusal("Match chat"); if (local) return local; }
  const g = await gate(req, ctx);
  if ("refused" in g) return g.refused;
  if (!g.canSend) {
    return Response.json({ error: "You don't have permission to send messages.", reason: "no_send_permission" }, { status: 403 });
  }
  let b: Body;
  try { b = (await req.json()) as Body; } catch { return Response.json({ error: "Body must be JSON" }, { status: 400 }); }
  const docIdOk = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v);

  if (b.op === "send") {
    const body = typeof b.body === "string" ? b.body : "";
    if (!body.trim()) return Response.json({ error: "body required" }, { status: 400 });
    if (body.length > MAX_BODY_LEN) return Response.json({ error: `body exceeds ${MAX_BODY_LEN} chars` }, { status: 400 });
    if (b.replyTo != null && !docIdOk(b.replyTo)) return Response.json({ error: "replyTo must be a message document id" }, { status: 400 });
    const r = await postMatchDayText({ supabase: g.auth.supabase, chatDocId: g.chatDocId, body, appUserId: g.auth.appUserId, replyToDocId: docIdOk(b.replyTo) ? b.replyTo : null, tag: `app:match-chat:${g.env}`, push: g.push });
    if (!r.ok) return Response.json({ error: r.error }, { status: r.status });
    const back = await readMessage(g.chatDocId, r.firestoreDocId).catch(() => null);
    return Response.json({
      ok: true, op: "send", firestore_doc_id: r.firestoreDocId, message_id: r.messageId, reply_to: r.replyTo, audited: r.audited, push: r.push,
      message: back,
      readBack: back ? (back.isMatchDay && back.text === body ? "confirmed" : "disagrees") : "missing",
    });
  }
  if (b.op === "delete") {
    if (!docIdOk(b.docId)) return Response.json({ error: "docId must be a message document id" }, { status: 400 });
    const r = await deleteMatchChatMessage({ supabase: g.auth.supabase, chatDocId: g.chatDocId, docId: b.docId, appUserId: g.auth.appUserId, tag: `app:match-chat:${g.env}:delete` });
    if (!r.ok) return Response.json({ error: r.error }, { status: r.status });
    const back = await readMessage(g.chatDocId, b.docId).catch(() => null);
    return Response.json({
      ok: true, op: "delete", doc_id: r.docId, message_id: r.messageId, already: r.already, quotes_blanked: r.quotesBlanked, audited: r.audited,
      readBack: back ? (back.deleted ? "confirmed" : "disagrees") : "missing",
    });
  }
  if (b.op === "react") {
    if (!docIdOk(b.docId)) return Response.json({ error: "docId must be a message document id" }, { status: 400 });
    if (typeof b.key !== "string") return Response.json({ error: "key required" }, { status: 400 });
    const r = await toggleMatchDayReaction({ supabase: g.auth.supabase, chatDocId: g.chatDocId, docId: b.docId, key: b.key, appUserId: g.auth.appUserId, tag: `app:match-chat:${g.env}:react` });
    if (!r.ok) return Response.json({ error: r.error }, { status: r.status });
    const back = await readMessage(g.chatDocId, b.docId).catch(() => null);
    const mine = back?.reactions.find((x) => x.key === b.key)?.mine ?? false;
    return Response.json({ ok: true, op: "react", doc_id: r.docId, key: r.key, on: r.on, reactions: back?.reactions ?? r.reactions, audited: r.audited, readBack: back ? (mine === r.on ? "confirmed" : "disagrees") : "missing" });
  }
  if (b.op === "edit") {
    if (!docIdOk(b.docId)) return Response.json({ error: "docId must be a message document id" }, { status: 400 });
    const body = typeof b.body === "string" ? b.body : "";
    const r = await editMatchDayMessage({ supabase: g.auth.supabase, chatDocId: g.chatDocId, docId: b.docId, text: body, appUserId: g.auth.appUserId, tag: `app:match-chat:${g.env}:edit` });
    if (!r.ok) return Response.json({ error: r.error }, { status: r.status });
    const back = await readMessage(g.chatDocId, b.docId).catch(() => null);
    return Response.json({ ok: true, op: "edit", doc_id: r.docId, message_id: r.messageId, audited: r.audited, message: back, readBack: back ? (back.edited && back.text === body.trim() ? "confirmed" : "disagrees") : "missing" });
  }
  if (b.op === "typing") {
    try {
      await setMatchDayTyping(g.chatDocId, b.typing === true);
      return Response.json({ ok: true, op: "typing", typing: b.typing === true });
    } catch (err) {
      console.error("[app:match-chat] typing write failed", err);
      return Response.json({ error: "Firestore write failed" }, { status: 502 });
    }
  }
  return Response.json({ error: `unknown op ${JSON.stringify(b.op)}` }, { status: 400 });
}

export const GET = reviewMasked(getRoute);
export const POST = reviewMasked(postRoute);
