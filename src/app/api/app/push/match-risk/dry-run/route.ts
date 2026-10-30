// POST /api/app/push/match-risk/dry-run { env, matchId }: an admin's test of the match-at-risk push.
// Reads that match live, builds exactly the notification the cron would, and sends it ONLY to the
// caller's own devices, marked dry_run in app_push_log. It does not claim the match, so it never
// stops the real notice later, and it ignores the kill switch (it is the caller's own test).

import { authenticateApp } from "@/lib/appAuth";
import { checkinFor, countedPlayers, fetchPlayersLive, isEnv, todayRow } from "@/lib/appLive";
import { trimMatch, type Raw } from "@/lib/gamedayApiShape";
import { rosterRowIsFake } from "@/lib/gamedayModel";
import { apiGet } from "@/lib/matchdayStageApi";
import { atRiskNow, sendAppPush } from "@/lib/appPush";
import { riskPayload } from "@/lib/appPushMatch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Row = Record<string, unknown>;

export async function POST(req: Request) {
  const auth = await authenticateApp(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  if (auth.row.is_admin !== true) return Response.json({ error: "Admins only." }, { status: 403 });
  const body = (await req.json().catch(() => null)) as { env?: unknown; matchId?: unknown } | null;
  const env = typeof body?.env === "string" ? body.env : "";
  const id = Number(body?.matchId);
  if (!isEnv(env) || !Number.isInteger(id)) return Response.json({ error: "env (production | staging) and a numeric matchId are required" }, { status: 400 });

  const [match, players] = await Promise.all([apiGet<Row>(env, `/admin/matches/${id}`), fetchPlayersLive(env, id)]);
  const fakes = countedPlayers(players).filter((p) => rosterRowIsFake(p)).length;
  const counted = { ...match, _count: { ...((match._count as Row | undefined) ?? {}), fakePlayers: fakes } } as Raw;
  const now = Date.now();
  const m = todayRow(trimMatch(counted), counted, checkinFor(players, [], Date.parse(String(match.startDateUtc))), now);
  const payload = riskPayload(env, m);
  const result = await sendAppPush(auth.supabase, { event: "match_at_risk", subject: `${env}:${id}`, recipientIds: [auth.appUserId], ...payload, dryRun: true });
  return Response.json({
    dryRun: true, env, matchId: id,
    wouldQualifyNow: atRiskNow(m, now),
    match: { name: m.name, startDate: m.startDate, cityName: m.cityName, booked: m.booked, minPlayerCount: m.minPlayerCount, cushion: m.cushion, autoCanceled: m.autoCanceled, autoCanceledMinutes: m.autoCanceledMinutes, isCancelled: m.isCancelled },
    notification: { title: payload.title, body: payload.body, data: payload.data },
    result,
  });
}
