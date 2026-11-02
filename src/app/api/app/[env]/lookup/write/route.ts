// Staff app PLAYER LOOKUP, writes (Ryan, 2026-10-31). WRITES NOTHING ITSELF: each op is the desktop
// Player Lookup's own route, called in process with the caller's token, so EDIT MEMBERSHIPS or
// MANAGE PLAYERS, the city boundary, the guarded write client, change_log and (for memberships) the
// two-fact read-back of the MatchDay row and Stripe all come along unchanged.
//
//   membership-add    POST  /api/matchday/{env}/memberships/add            { playerId, kind: "free" }
//   membership-price  PATCH /api/matchday/{env}/memberships/{sub}/price    { playerId, cents }
//   membership-end    POST  /api/matchday/{env}/memberships/{sub}/end      { playerId, reason }
//   strike-remove     DELETE /api/matchday/{env}/strikes/{logId}          { playerId, userMatchId, reason }
//   suspend           POST  /api/lookup/{env}/ban   { action: "suspend", playerId, reason, until }   MANAGE PLAYERS
//   lift              POST  /api/lookup/{env}/ban   { action: "lift", playerId, reason }   a manual suspension only
//
// EXPEL IS NOT HERE, and neither is lifting an expulsion (Ryan, 2026-10-31: Expel stays off the
// phone). A suspension from strikes is MatchDay's own and the desktop has no lift for it either.
//
// Then a LIVE read-back of the profile through the desktop lookup, compared with what was asked.
// Writes never retry.

import { authenticateApp, readRefusal } from "@/lib/appAuth";
import { isEnv } from "@/lib/appLive";
import { callDesktop, passThrough } from "@/lib/appCall";
import { GET as lookupGet } from "@/app/api/lookup/[env]/route";
import { POST as addPost } from "@/app/api/matchday/[env]/memberships/add/route";
import { PATCH as pricePatch } from "@/app/api/matchday/[env]/memberships/[subscriptionId]/price/route";
import { POST as endPost } from "@/app/api/matchday/[env]/memberships/[subscriptionId]/end/route";
import { DELETE as strikeDelete } from "@/app/api/matchday/[env]/strikes/[strikeLogId]/route";
import { POST as banPost } from "@/app/api/lookup/[env]/ban/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Row = Record<string, unknown>;
const SOURCE = "Staff app · Player Lookup";
const int = (v: unknown) => (v != null && v !== "" && Number.isInteger(Number(v)) ? Number(v) : null);

export async function POST(req: Request, ctx: { params: Promise<{ env: string }> }) {
  const auth = await authenticateApp(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const refused = readRefusal(auth);
  if (refused) return Response.json({ error: refused.error }, { status: refused.status });
  const { env } = await ctx.params;
  if (!isEnv(env)) return Response.json({ error: `unknown environment ${JSON.stringify(env)}` }, { status: 400 });

  const body = (await req.json().catch(() => null)) as Row | null;
  const op = body?.op;
  const playerId = int(body?.playerId);
  if (playerId == null) return Response.json({ error: "playerId required" }, { status: 400 });
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";

  try {
    // The profile before: the player's name for the log, and the facts the read-back compares with.
    const before = await callDesktop(req, lookupGet, `/api/lookup/${env}?id=${playerId}`, {}, { env });
    if (!before.ok) return passThrough(before);
    const playerName = ((before.json?.player as Row) ?? {}).name ?? null;
    const sub = (before.json?.membership as Row | null) ?? null;

    let call;
    if (op === "membership-add") {
      call = await callDesktop(req, addPost, `/api/matchday/${env}/memberships/add`, { method: "POST", body: { playerId, kind: "free", playerName, source: SOURCE } }, { env });
    } else if (op === "membership-price" || op === "membership-end") {
      if (!sub || int(sub.id) == null) return Response.json({ error: "This player has no membership to change." }, { status: 409 });
      const subscriptionId = String(sub.id);
      if (op === "membership-price") {
        const cents = int(body?.cents);
        if (cents == null) return Response.json({ error: "cents required" }, { status: 400 });
        call = await callDesktop(req, pricePatch, `/api/matchday/${env}/memberships/${subscriptionId}/price`, { method: "PATCH", body: { playerId, cents, playerName, source: SOURCE } }, { env, subscriptionId });
      } else {
        if (!reason) return Response.json({ error: "A reason is required to end a membership." }, { status: 400 });
        call = await callDesktop(req, endPost, `/api/matchday/${env}/memberships/${subscriptionId}/end`, { method: "POST", body: { playerId, reason, playerName, source: SOURCE } }, { env, subscriptionId });
      }
    } else if (op === "strike-remove") {
      const logId = int(body?.strikeLogId), userMatchId = int(body?.userMatchId);
      if (logId == null || userMatchId == null) return Response.json({ error: "strikeLogId and userMatchId required" }, { status: 400 });
      if (!reason) return Response.json({ error: "A reason is required to remove a strike." }, { status: 400 });
      call = await callDesktop(req, strikeDelete, `/api/matchday/${env}/strikes/${logId}`, { method: "DELETE", body: { playerId, userMatchId, reason, playerName, source: SOURCE } }, { env, strikeLogId: String(logId) });
    } else if (op === "suspend" || op === "lift") {
      if (!reason) return Response.json({ error: "A reason is required." }, { status: 400 });
      const status = String(((before.json?.player as Row) ?? {}).status ?? "");
      if (op === "lift" && status !== "suspended") return Response.json({ error: status === "expelled" ? "An expulsion is lifted from the desktop, not the app." : "This player is not suspended." }, { status: 409 });
      const until = typeof body?.until === "string" ? body.until : "";
      if (op === "suspend" && !/^\d{4}-\d{2}-\d{2}$/.test(until)) return Response.json({ error: "Suspend needs an until date (YYYY-MM-DD)." }, { status: 400 });
      call = await callDesktop(req, banPost, `/api/lookup/${env}/ban`, { method: "POST", body: { action: op, playerId, reason, until: op === "suspend" ? until : undefined, playerName, source: SOURCE } }, { env });
    } else {
      return Response.json({ error: "op must be membership-add, membership-price, membership-end, strike-remove, suspend or lift" }, { status: 400 });
    }

    // A refusal before anything was written: the desktop's own status and sentence.
    if (!call.ok && (call.status === 400 || call.status === 403 || call.status === 409)) return passThrough(call);

    // THE READ-BACK, live, through the same desktop profile.
    const after = await callDesktop(req, lookupGet, `/api/lookup/${env}?id=${playerId}`, {}, { env });
    const m = (after.json?.membership as Row | null) ?? null;
    const strikes = (after.json?.strikes as Row | null) ?? null;
    const pl = (after.json?.player as Row | null) ?? null;
    const disagreements: string[] = [];
    if (op === "membership-add" && !m) disagreements.push("The player has no membership when read back.");
    if (op === "membership-price" && m && Number(m.price) !== int(body?.cents)) disagreements.push(`The price reads back as ${Number(m.price)} cents, not ${int(body?.cents)}.`);
    if (op === "membership-end" && m && !/CANCEL/i.test(String(m.statusRaw ?? m.status ?? ""))) disagreements.push("The membership is still open when read back.");
    if (op === "strike-remove") {
      const log = ((strikes?.logs as Row[]) ?? []).find((l) => int(l.id) === int(body?.strikeLogId));
      if (log && log.active === true && Number(log.penaltyPoint) > 0) disagreements.push("The strike is still active when read back.");
    }
    if (op === "suspend" && pl?.status !== "suspended") disagreements.push(`The player reads back as ${String(pl?.status ?? "unknown")}, not suspended.`);
    if (op === "suspend" && pl?.status === "suspended" && String(pl.banExpiredAt ?? "").slice(0, 10) !== String(body?.until)) disagreements.push(`The suspension reads back until ${String(pl.banExpiredAt ?? "no date").slice(0, 10)}, not ${String(body?.until)}.`);
    if (op === "lift" && pl?.status !== "ok") disagreements.push(`The player reads back as ${String(pl?.status ?? "unknown")}, not active.`);
    return Response.json({
      op, status: call.status, desktop: call.json, landed: call.ok && disagreements.length === 0,
      readBack: { membership: m, strikes, player: pl && { status: pl.status, banReason: pl.banReason, bannedAt: pl.bannedAt, banExpiredAt: pl.banExpiredAt }, readAt: new Date().toISOString() }, disagreements,
    });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
