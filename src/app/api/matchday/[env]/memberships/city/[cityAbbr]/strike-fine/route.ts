// SET A CITY'S STRIKE FINE. ADMIN ONLY.
//
//   POST /admin/strikes/cities/{cityAbbr}  { price }  (cents)
//       -> setStrikePriceByCityAbbr (strike.service.ts:84-88) -> strike_prices upsert
//          (strike.repository.ts:102-115). NO STRIPE OBJECT: a suspended player is invoiced the amount
//          current when they pay (createPayment, strike.service.ts:107-145).
//
// THE BACKEND VALIDATES NOTHING. The body is an inline `{ price: number }` with no DTO class
// (admin-strike.controller.ts:35-38), so the global ValidationPipe has nothing to check. Ryan's rule
// is enforced here: whole dollars, $1 to $100 (membersPageModel.strikeFineRefusal).
//
// READ BACK through GET /strikes/cities/{abbr}, proven readable by the service account on production
// 2026-11-13 (ATX -> { amount: 2000 }). One fact: MatchDay. Logged to change_log.
import { randomUUID } from "node:crypto";
import { authenticateMatchOpsRead } from "@/lib/matchOpsAuth";
import { apiGet, apiWrite } from "@/lib/matchdayStageApi";
import { recordWrite, supabaseLogStore } from "@/lib/changeLog";
import { isEnv } from "@/lib/membershipRouteCommon";
import { errToResponse } from "@/lib/membershipRouteErrors";
import { resolveCityScope, cityNameFor } from "@/lib/cityScope";
import { strikeFineRefusal, twoFacts, usd } from "@/lib/membersPageModel";
import type { Change } from "@/lib/changeLogModel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Body = { dollars?: string | number; saveId?: string };

export async function POST(req: Request, ctx: { params: Promise<{ env: string; cityAbbr: string }> }) {
  const auth = await authenticateMatchOpsRead(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { env, cityAbbr } = await ctx.params;
  if (!isEnv(env)) return Response.json({ error: `unknown environment ${JSON.stringify(env)}` }, { status: 400 });
  const city = resolveCityScope(cityAbbr);
  if (!city) return Response.json({ error: "Unknown city." }, { status: 400 });

  if (!auth.isAdmin || auth.confinedCity) {
    console.warn(`[members] 403: ${auth.email} attempted to set the ${city.identifier} strike fine without admin`);
    return Response.json({ error: "Only an admin can change a city's strike fine." }, { status: 403 });
  }
  const body = (await req.json().catch(() => null)) as Body | null;
  const actor = { canEditMatches: auth.canEditMatches, isAdmin: auth.isAdmin, email: auth.email, userId: auth.appUserId };
  const finePath = `/strikes/cities/${city.identifier}`;

  try {
    const read = async (): Promise<Record<string, unknown>> => {
      const r = await apiGet<Record<string, unknown>>(env, finePath);
      return { amount: Number(r?.amount) };
    };
    const before = await read();
    const current = Number.isFinite(before.amount as number) ? (before.amount as number) : null;
    const { cents, why } = strikeFineRefusal(String(body?.dollars ?? ""), current);
    if (why || cents == null) return Response.json({ error: why ?? "Enter whole dollars." }, { status: 400 });

    const path = `/admin/strikes/cities/${city.identifier}`;
    const writeBody = { price: cents };
    const applied = (_b: Record<string, unknown>, a: Record<string, unknown>): boolean => Number(a.amount) === cents;
    const changes: Change[] = [{
      key: "strikeFine", field: `${cityNameFor(city.identifier) ?? city.identifier} strike fine`,
      before: current != null ? usd(current) : "unknown", after: usd(cents),
    }];
    const { result, error, outcome, logged } = await recordWrite(
      {
        env, source: "Members — city settings", actorName: auth.email, actorEmail: auth.email,
        saveId: body?.saveId || randomUUID(), matchId: null, matchName: `${city.identifier} strike fine`,
        method: "POST", path, body: writeBody, keys: [], label: (k) => k, applied, changes,
      },
      { readResource: () => read().catch(() => ({})), write: () => apiWrite(env, "POST", path, writeBody, actor, "admin"), now: () => new Date().toISOString() },
      supabaseLogStore(),
    );
    if (error) return errToResponse(error);
    const after = await read().catch(() => ({} as Record<string, unknown>));
    const known = Number.isFinite(after.amount as number);
    const facts = twoFacts("fine", known ? (Number(after.amount) === cents ? "moved" : "unchanged") : "unknown", "absent", null, { cents });
    return Response.json({
      ok: true, result, outcome, logRecorded: logged, landed: outcome === "landed",
      status: outcome === "landed" ? "LANDED" : outcome === "notapplied" ? "NOT APPLIED" : "UNKNOWN",
      facts, fineCents: known ? after.amount : null,
    });
  } catch (e) { return errToResponse(e); }
}
