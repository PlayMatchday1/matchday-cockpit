/* GET /api/lifecycle/free-first-match?from=YYYY-MM-DD&to=YYYY-MM-DD&city=ATX — the Free First Match
 * page. READ ONLY.
 *
 * The BASE (every first-timer, match, leave, rating and play the page can need) is built once from the
 * mirror (freeFirstMatchBuild.ts) and kept warm for five minutes; each request is then a pure
 * `summarize(base, range, city)` (freeFirstMatchModel.ts) with no further reads. No range = Nov 5 to
 * yesterday; no city = every included city. `fresh=1` rebuilds the base (the page asks for it after a
 * field switch, so the On / Off column reads the write-through).
 *
 * Counting rules, money and sold out: the header of freeFirstMatchModel.ts. */

import { authenticateCapability } from "@/lib/capabilityAuth";
import { buildFreeFirstMatch } from "@/lib/freeFirstMatchBuild";
import { summarize, type Base } from "@/lib/freeFirstMatchModel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

let cache: { at: number; base: Base } | null = null;
let building: Promise<Base> | null = null;
const CACHE_MS = 5 * 60 * 1000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: Request) {
  const auth = await authenticateCapability(req, "lifecycle");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const q = new URL(req.url).searchParams;
  const fresh = q.get("fresh") === "1";
  const from = q.get("from") ?? undefined, to = q.get("to") ?? undefined, city = q.get("city") || null;
  if ((from && !DAY.test(from)) || (to && !DAY.test(to))) return Response.json({ error: "from and to are YYYY-MM-DD" }, { status: 400 });
  try {
    let base: Base;
    if (!fresh && cache && Date.now() - cache.at < CACHE_MS) base = cache.base;
    else {
      if (!building) building = buildFreeFirstMatch(auth.supabase).then((b) => { cache = { at: Date.now(), base: b }; return b; }).finally(() => { building = null; });
      base = await building;
    }
    return Response.json(summarize(base, { from, to, city }));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
