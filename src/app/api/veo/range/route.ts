/* GET /api/veo/range?from=YYYY-MM-DD&to=YYYY-MM-DD — the Month view's data. READ ONLY.
 *
 * Same gate, same scoping and same source as /api/veo: authenticateCrm, mdapi_matches read-only,
 * and the confined city resolved FROM THE SESSION rather than from a query param. The only
 * difference is the shape — a date range instead of a Monday-anchored week, because a range that
 * spans months has no single Monday to anchor a dayIdx to.
 *
 * THE BOUND IS CAPPED. A range is operator-chosen and an unbounded one is a full-table scan on a
 * mirror with years of history in it. 92 days is a calendar quarter, which is more than the month
 * view ever shows and leaves room for a range dragged across a boundary.
 */

import { authenticateCrm } from "@/lib/crmAuth";
import { fetchVeoRange } from "@/lib/veoSchedule";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 92;

/** Days between two YYYY-MM-DD strings. Parsed at UTC MIDNIGHT and only ever subtracted — this is
 *  arithmetic on calendar bounds, not a wall-clock instant, so there is nothing to re-shift. */
const daysBetween = (a: string, b: string): number =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

export async function GET(req: Request) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const url = new URL(req.url);
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";
  if (!ISO.test(from) || !ISO.test(to)) {
    return Response.json({ error: "from and to are required as YYYY-MM-DD" }, { status: 400 });
  }
  if (to < from) return Response.json({ error: "to is before from" }, { status: 400 });
  const span = daysBetween(from, to);
  if (span > MAX_DAYS) {
    return Response.json({ error: `Range is ${span + 1} days; the most this view will load is ${MAX_DAYS + 1}.` }, { status: 400 });
  }

  try {
    const range = await fetchVeoRange(auth.supabase, new Date(), from, to, auth.confinedCity ?? null);
    return Response.json(range, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    // LOUD. An empty grid and a failed read must never look the same.
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
