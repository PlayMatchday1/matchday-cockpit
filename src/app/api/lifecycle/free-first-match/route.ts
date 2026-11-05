/* GET /api/lifecycle/free-first-match — the Free First Match page's payload. READ ONLY.
 *
 * ONE PAYLOAD, NO PARAMETERS. The page filters by range and city itself: the follow-up windows
 * (paid within 30 days, member within 60) are anchored on each player's own first match and do not
 * depend on the range, so the server computes them once per person and the page selects people.
 *
 * ── THE ROWS ARE growth_participation's (0208) ──────────────────────────────────────────────
 * Who counts is decided once, in the view: staff, @matchday.com and fake accounts out, fake-fill
 * bookings out, cancelled and unsettled (WAITING) bookings out, cancelled and deleted matches out,
 * a re-registered player's two accounts as one person. Nothing here re-checks a flag. The raw
 * booking row is read back only for what the view does not carry: user_type, amount and the
 * promocode the booking used.
 *
 * ── THE COHORTS ──────────────────────────────────────────────────────────────────────────────
 *   free   a standing booking carrying FIRST-MATCH-AUTO; anchored on that match's day
 *   paid / code / ref   growth_player_profile.first_match_date in Aug 7 … Nov 4, 2026, classified
 *          by the earliest participating row: paid with no promo; a new-user 100% code; a per-player
 *          referral code. A first match that is none of those (a member's free spot, a field-launch
 *          code, a comp) is in no group and is not shown.
 *
 * ── SIZE ─────────────────────────────────────────────────────────────────────────────────────
 * The before groups are fixed (about three months of first-time players). The free group and the
 * match list grow from Nov 5 on; the match list is every live match from launch, for the Paid
 * spots card and the log, and is the part to revisit once it is a year long.
 */

import { authenticateCapability } from "@/lib/capabilityAuth";
import { buildFreeFirstMatch } from "@/lib/freeFirstMatchBuild";
import type { Payload } from "@/lib/freeFirstMatchModel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/* A short warm cache: the payload is a few dozen reads, and every open of the page would repeat
 * them. Five minutes is well inside the daily sync, so a warm instance never serves anything the
 * mirror has moved past. */
let cache: { at: number; payload: Payload } | null = null;
let building: Promise<Payload> | null = null;
const CACHE_MS = 5 * 60 * 1000;

export async function GET(req: Request) {
  const auth = await authenticateCapability(req, "lifecycle");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const fresh = new URL(req.url).searchParams.get("fresh") === "1";
  try {
    if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return Response.json(cache.payload);
    if (!building) {
      building = buildFreeFirstMatch(auth.supabase).then((p) => { cache = { at: Date.now(), payload: p }; return p; }).finally(() => { building = null; });
    }
    return Response.json(await building);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
