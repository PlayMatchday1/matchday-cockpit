// GET /api/growth/retention — the single cohort/retention aggregate for the
// retention-curve and cohort-table cards. Read-only, service-role, cached
// in-process keyed on the max match date (see retentionEngine). Returns timing
// headers so the before/after can be measured against the old cohort path.

import { authenticateCities } from "@/lib/growthAuth";
import { getRetentionAggregate } from "@/lib/retentionEngine";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: Request) {
  const auth = await authenticateCities(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  try {
    const t0 = Date.now();
    const agg = await getRetentionAggregate(auth.supabase);
    const totalMs = Date.now() - t0;
    const { cached, fetchMs, ...payload } = agg;
    return Response.json(
      { ...payload, timing: { cached, fetchMs, buildMs: payload.buildMs, totalMs } },
      {
        status: 200,
        headers: {
          "Cache-Control": "private, max-age=60, stale-while-revalidate=300",
          "Server-Timing": `retention;dur=${totalMs};desc="${cached ? "cache" : "fresh"}"`,
        },
      },
    );
  } catch (e) {
    console.error("[api/growth/retention] failed", e);
    return Response.json({ error: "Failed to compute retention" }, { status: 500 });
  }
}
