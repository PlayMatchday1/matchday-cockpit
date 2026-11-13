// SET A CITY'S MEMBER PRICE — NEW SIGNUPS ONLY. ADMIN ONLY.
//
//   POST /admin/subscriptions  { name, price, cityAbbr }   — the call Retool's Change Master Price makes
//       -> createOrUpdateSubscription (subscriptions.service.ts:64-104 at backend 8965437):
//          a new Stripe Product + a new MONTHLY recurring Price, then the city's `subscriptions` row
//          takes the new price / stripeProductId / stripePriceId. NO EXISTING SUBSCRIPTION IS TOUCHED:
//          members keep the price they joined at. An unchanged price returns early with no Stripe call.
//
// ADMIN ONLY, read fresh from the database on every request (matchOpsAuth -> app_users.is_admin), and
// re-checked inside apiWrite (requires "admin") so a route that forgot its own check is still stopped.
//
// TWO FACTS AFTER THE WRITE. MatchDay: the city plan read back carries the new price AND a new
// stripePriceId. Stripe: that price is read and must be the new amount, monthly. Logged to change_log.
import { randomUUID } from "node:crypto";
import { authenticateMatchOpsRead } from "@/lib/matchOpsAuth";
import { apiGet, apiWrite } from "@/lib/matchdayStageApi";
import { recordWrite, supabaseLogStore } from "@/lib/changeLog";
import { isEnv } from "@/lib/membershipRouteCommon";
import { errToResponse } from "@/lib/membershipRouteErrors";
import { resolveCityScope, cityNameFor } from "@/lib/cityScope";
import { getStripe } from "@/lib/stripePayments";
import { planPriceRefusal, planName, twoFacts, usd, type StripeVerdict } from "@/lib/membersPageModel";
import type { Change } from "@/lib/changeLogModel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Body = { cents?: number; saveId?: string };

export async function POST(req: Request, ctx: { params: Promise<{ env: string; cityAbbr: string }> }) {
  const auth = await authenticateMatchOpsRead(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { env, cityAbbr } = await ctx.params;
  if (!isEnv(env)) return Response.json({ error: `unknown environment ${JSON.stringify(env)}` }, { status: 400 });
  const city = resolveCityScope(cityAbbr);
  if (!city) return Response.json({ error: "Unknown city." }, { status: 400 });

  if (!auth.isAdmin || auth.confinedCity) {
    console.warn(`[members] 403: ${auth.email} attempted to set the ${city.identifier} member price without admin`);
    return Response.json({ error: "Only an admin can change a city's member price." }, { status: 403 });
  }
  const body = (await req.json().catch(() => null)) as Body | null;
  const cents = Number(body?.cents);
  const actor = { canEditMatches: auth.canEditMatches, isAdmin: auth.isAdmin, email: auth.email, userId: auth.appUserId };
  const planPath = `/admin/subscriptions/cities/${city.identifier}`;

  try {
    const read = async (): Promise<Record<string, unknown>> => {
      const r = await apiGet<Record<string, unknown>>(env, planPath);
      return { price: Number(r?.price), stripePriceId: typeof r?.stripePriceId === "string" ? r.stripePriceId : null };
    };
    const before = await read();
    const why = planPriceRefusal(Number.isFinite(cents) ? cents : null, Number.isFinite(before.price as number) ? (before.price as number) : null);
    if (why) return Response.json({ error: why }, { status: 400 });

    const path = "/admin/subscriptions";
    const writeBody = { name: planName(new Date(), cents), price: cents, cityAbbr: city.identifier };
    const applied = (b: Record<string, unknown>, a: Record<string, unknown>): boolean =>
      Number(a.price) === cents && !!a.stripePriceId && a.stripePriceId !== b.stripePriceId;
    const changes: Change[] = [{
      key: "planPrice", field: `${cityNameFor(city.identifier) ?? city.identifier} member price (new signups only)`,
      before: Number.isFinite(before.price as number) ? usd(before.price as number) : "unknown",
      after: usd(cents),
    }];
    const { result, error, outcome, logged } = await recordWrite(
      {
        env, source: "Members — city settings", actorName: auth.email, actorEmail: auth.email,
        saveId: body?.saveId || randomUUID(), matchId: null, matchName: `${city.identifier} member price`,
        method: "POST", path, body: writeBody, keys: [], label: (k) => k, applied, changes,
      },
      { readResource: () => read().catch(() => ({})), write: () => apiWrite(env, "POST", path, writeBody, actor, "admin"), now: () => new Date().toISOString() },
      supabaseLogStore(),
    );
    if (error) return errToResponse(error);

    const after = await read().catch(() => ({} as Record<string, unknown>));
    const rowMoved = applied(before, after);
    let stripe: StripeVerdict = "absent";
    const priceId = typeof after.stripePriceId === "string" ? after.stripePriceId : null;
    if (priceId && env === "production") {
      try {
        const p = await getStripe().prices.retrieve(priceId);
        stripe = p.unit_amount === cents && p.recurring?.interval === "month" ? "moved" : "unchanged";
      } catch (e) {
        stripe = (e as { code?: string })?.code === "resource_missing" ? "unchanged" : "unreadable";
      }
    } else if (priceId) {
      // Staging prices live in Stripe's test mode; the production key cannot read them.
      stripe = "unreadable";
    }
    const facts = twoFacts("plan", Number.isFinite(after.price as number) ? (rowMoved ? "moved" : "unchanged") : "unknown", stripe, priceId, { cents });
    return Response.json({
      ok: true, result, outcome, logRecorded: logged, landed: outcome === "landed",
      status: outcome === "landed" ? "LANDED" : outcome === "notapplied" ? "NOT APPLIED" : "UNKNOWN",
      facts, planCents: Number.isFinite(after.price as number) ? after.price : null,
    });
  } catch (e) { return errToResponse(e); }
}
