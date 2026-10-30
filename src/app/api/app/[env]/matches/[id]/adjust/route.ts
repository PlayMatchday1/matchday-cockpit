// Staff app: ADJUST a match's minimum ("Cancels below") and its spots shown as left.
//
// THIS ROUTE WRITES NOTHING ITSELF. It calls the desktop Gameday Ops write handlers, in process,
// with the caller's own request headers, so everything they do comes along unchanged: the EDIT
// MATCHES grant, the city boundary on the match id, the guarded write client, recordWrite into
// change_log with the caller as the actor, and each handler's own read-back verdict.
//
//   minimum      PUT  /api/matchday/{env}/matches/{id}        { changes: { minPlayerCount } }
//   spots left   PUT  /api/matchday/{env}/matches/{id}        { changes: <rung diff> }
//                POST /api/matchday/{env}/matches/{id}/fakes  { targetFakes }
//
// That is exactly what the desktop board's two Save buttons send, in the same order: the minimum,
// then the rung in force and every later rung (spotsLeftWriteDiff), then the roster brought to the
// fake count that rung implies (fakesFor). One saveId groups all of them in change_log.
//
// STOP ON THE FIRST WRITE THAT DID NOT LAND. Writes never retry and are never sent past a failure.
// The response reports every step's own outcome, then a LIVE read-back of the match and roster, and
// says plainly where the read-back disagrees with what was asked for.

import { randomUUID } from "node:crypto";
import { authenticateApp, readRefusal } from "@/lib/appAuth";
import { cityAllowed } from "@/lib/appModel";
import { fetchPlayersLive, isEnv } from "@/lib/appLive";
import { apiGet, StageConfigError, StageHostGuardError } from "@/lib/matchdayStageApi";
import { CONFINED_CITY_ERROR } from "@/lib/cityConfinement";
import { realOccupancyFromRoster, rosterRowCounts, rosterRowIsFake } from "@/lib/gamedayModel";
import { RUNG_KEYS, fakesFor, spotsLeftNow, spotsLeftWriteDiff, type Ladder } from "@/lib/fakeLadder";
import { PUT as desktopMatchPut } from "@/app/api/matchday/[env]/matches/[id]/route";
import { POST as desktopFakesPost } from "@/app/api/matchday/[env]/matches/[id]/fakes/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Row = Record<string, unknown>;
type Step = { what: "minimum" | "spots-ladder" | "spots-roster"; status: number; outcome: string; error: string | null; sent: unknown };

const SOURCE = "Staff app · Adjust";
const ladderOf = (m: Row): Ladder => Object.fromEntries(RUNG_KEYS.map((k) => [k, Number(m[k] ?? 0)]));
const hoursTo = (m: Row) => (Date.parse(String(m.startDateUtc)) - Date.now()) / 3_600_000;

async function readLive(env: "staging" | "production", id: string) {
  const [match, players] = await Promise.all([apiGet<Row>(env, `/admin/matches/${id}`), fetchPlayersLive(env, id)]);
  const occupancy = Number((match._count as Row | undefined)?.players ?? 0);
  const fakes = players.filter((p) => rosterRowCounts(p) && rosterRowIsFake(p)).length;
  return {
    match,
    minPlayerCount: Number(match.minPlayerCount ?? 0),
    capacity: Number(match.maxPlayerCount ?? 0),
    real: realOccupancyFromRoster(occupancy, players),
    fakes,
    spotsLeft: spotsLeftNow(ladderOf(match), hoursTo(match)),
    ladder: ladderOf(match),
  };
}

export async function POST(req: Request, ctx: { params: Promise<{ env: string; id: string }> }) {
  const auth = await authenticateApp(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const refused = readRefusal(auth);
  if (refused) return Response.json({ error: refused.error }, { status: refused.status });
  const { env, id } = await ctx.params;
  if (!isEnv(env)) return Response.json({ error: `unknown environment ${JSON.stringify(env)}` }, { status: 400 });
  if (!/^\d+$/.test(id)) return Response.json({ error: "match id must be numeric" }, { status: 400 });

  const body = (await req.json().catch(() => null)) as { minPlayerCount?: unknown; spotsLeft?: unknown } | null;
  const wantMin = body?.minPlayerCount == null ? null : Number(body.minPlayerCount);
  const wantSpots = body?.spotsLeft == null ? null : Number(body.spotsLeft);
  if ((wantMin != null && !Number.isInteger(wantMin)) || (wantSpots != null && !Number.isInteger(wantSpots))) {
    return Response.json({ error: "minPlayerCount and spotsLeft must be whole numbers" }, { status: 400 });
  }
  if (wantMin == null && wantSpots == null) return Response.json({ error: "nothing to change" }, { status: 400 });

  try {
    const before = await readLive(env, id);
    // The live boundary first. The desktop handlers check scope again on their own terms.
    const city = ((before.match.field as Row | undefined)?.city as Row | undefined)?.name;
    if (!cityAllowed(auth, auth.scopeCityName, typeof city === "string" ? city : null)) {
      return Response.json({ error: CONFINED_CITY_ERROR }, { status: 403 });
    }
    // The same bounds the desktop steppers enforce: minimum 2..capacity, spots 0..capacity - real.
    if (wantMin != null && (wantMin < 2 || wantMin > before.capacity)) {
      return Response.json({ error: `Cancels below must be between 2 and ${before.capacity}.` }, { status: 400 });
    }
    const spotsCeil = Math.max(0, before.capacity - before.real);
    if (wantSpots != null && (wantSpots < 0 || wantSpots > spotsCeil)) {
      return Response.json({ error: `Spots left must be between 0 and ${spotsCeil}.` }, { status: 400 });
    }

    const saveId = randomUUID();
    const headers = { authorization: req.headers.get("authorization") ?? "", "content-type": "application/json" };
    const origin = new URL(req.url).origin;
    const params = { params: Promise.resolve({ env, id }) };
    const steps: Step[] = [];
    // The desktop handler's URL, so its confined-route allowlist sees the path it was written for.
    const call = async (what: Step["what"], handler: typeof desktopMatchPut, path: string, method: string, sent: Row) => {
      const res = await handler(new Request(`${origin}${path}`, { method, headers, body: JSON.stringify({ ...sent, source: SOURCE, saveId }) }), params);
      const j = (await res.json().catch(() => null)) as Row | null;
      const step: Step = { what, status: res.status, outcome: String(j?.outcome ?? (res.ok ? "unknown" : "failed")).toLowerCase(), error: (j?.error as string) ?? null, sent };
      steps.push(step);
      return res.ok && step.outcome === "landed";
    };

    let stopped = false;
    if (wantMin != null && wantMin !== before.minPlayerCount) {
      stopped = !(await call("minimum", desktopMatchPut, `/api/matchday/${env}/matches/${id}`, "PUT", { changes: { minPlayerCount: wantMin } }));
    }
    if (!stopped && wantSpots != null && wantSpots !== before.spotsLeft) {
      const w = spotsLeftWriteDiff(before.ladder, hoursTo(before.match), wantSpots);
      const ladderOk = Object.keys(w.diff).length === 0
        || await call("spots-ladder", desktopMatchPut, `/api/matchday/${env}/matches/${id}`, "PUT", { changes: w.diff });
      if (ladderOk) {
        await call("spots-roster", desktopFakesPost, `/api/matchday/${env}/matches/${id}/fakes`, "POST",
          { targetFakes: fakesFor(before.capacity, wantSpots, before.real), matchName: before.match.name ?? null });
      }
    }

    // REFUSED BEFORE ANYTHING WAS WRITTEN: the desktop handler's own status and sentence, as-is. A
    // refusal is not a save, so it is not dressed as one with a 200 and a read-back panel.
    const first = steps[0];
    if (first && (first.status === 401 || first.status === 403)) {
      return Response.json({ error: first.error ?? "Refused.", steps }, { status: first.status });
    }

    // THE READ-BACK. Live, after every write, and compared field by field with what was asked.
    const after = await readLive(env, id);
    const expectFakes = wantSpots != null ? fakesFor(after.capacity, wantSpots, after.real) : null;
    const disagreements: string[] = [];
    if (wantMin != null && after.minPlayerCount !== wantMin) disagreements.push(`Cancels below reads back as ${after.minPlayerCount}, not ${wantMin}.`);
    if (wantSpots != null && after.spotsLeft !== wantSpots) disagreements.push(`Spots left reads back as ${after.spotsLeft}, not ${wantSpots}.`);
    if (expectFakes != null && after.fakes !== expectFakes) disagreements.push(`The roster holds ${after.fakes} fake players, not ${expectFakes}.`);

    return Response.json({
      saveId,
      steps,
      landed: steps.length > 0 && steps.every((s) => s.outcome === "landed"),
      requested: { minPlayerCount: wantMin, spotsLeft: wantSpots },
      before: { minPlayerCount: before.minPlayerCount, spotsLeft: before.spotsLeft, real: before.real, fakes: before.fakes, capacity: before.capacity },
      readBack: { minPlayerCount: after.minPlayerCount, spotsLeft: after.spotsLeft, real: after.real, fakes: after.fakes, capacity: after.capacity, readAt: new Date().toISOString() },
      disagreements,
    });
  } catch (e) {
    if (e instanceof StageHostGuardError || e instanceof StageConfigError) return Response.json({ error: e.message }, { status: 500 });
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
