// Staff app: THE DAY'S REVIEWS, for the Done section of Gameday. Read only.
//
// LIVE. The day's matches come from the same admin list Today reads; the reviews come from each
// finished match's live roster (a review is a roster row with a starRating, the rule mdapi_reviews is
// built on). Only finished matches the list says were rated cost a roster read, at most six in
// flight. The app asks for this only when the Done section is opened, so Today pays nothing for it.
//
// The scope is applied to the list before any roster is read: a match in a city this account may
// not see is never fetched, let alone returned.

import { authenticateApp, readRefusal } from "@/lib/appAuth";
import { cityAllowed, mapLimit } from "@/lib/appModel";
import { fetchDayLive, fetchPlayersLive, isEnv, LOW_RATING_MAX, reviewsOut } from "@/lib/appLive";
import { trimMatch } from "@/lib/gamedayApiShape";
import { matchGroup, type ApiMatch } from "@/lib/gamedayModel";
import { StageConfigError, StageHostGuardError } from "@/lib/matchdayStageApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: Request, ctx: { params: Promise<{ env: string }> }) {
  const auth = await authenticateApp(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const refused = readRefusal(auth);
  if (refused) return Response.json({ error: refused.error }, { status: refused.status });
  const { env } = await ctx.params;
  if (!isEnv(env)) return Response.json({ error: `unknown environment ${JSON.stringify(env)}` }, { status: 400 });
  const date = new URL(req.url).searchParams.get("date");
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return Response.json({ error: "date=YYYY-MM-DD required" }, { status: 400 });

  try {
    const now = Date.now();
    const rated = (await fetchDayLive(env, date))
      .map(trimMatch)
      .filter((m) => cityAllowed(auth, auth.scopeCityName, m.field.city.name))
      .filter((m) => matchGroup(m as unknown as ApiMatch, now) === "finished" && (m.starRatingCount ?? 0) > 0);
    const matches: { id: number; reviews: ReturnType<typeof reviewsOut> | null; low: number | null }[] = [];
    await mapLimit(rated, 6, async (m) => {
      try {
        const reviews = reviewsOut(await fetchPlayersLive(env, m.id));
        matches.push({ id: m.id, reviews, low: reviews.filter((r) => r.stars <= LOW_RATING_MAX).length });
      } catch {
        // One roster that fails leaves that match without reviews; the list still answers.
        matches.push({ id: m.id, reviews: null, low: null });
      }
    });
    return Response.json({ date, env, fetchedAt: new Date(now).toISOString(), lowRatingMax: LOW_RATING_MAX, matches });
  } catch (e) {
    if (e instanceof StageHostGuardError || e instanceof StageConfigError) return Response.json({ error: e.message }, { status: 500 });
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
