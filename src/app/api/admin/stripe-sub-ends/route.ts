// GET /api/admin/stripe-sub-ends?probe=matchday|stripe|low_plans&n=10 — ADMIN ONLY, READ ONLY.
//
// The two probes that gate the Stripe end-date backfill (lib/stripeSubEnds). A GET because it
// changes nothing anywhere: it reads MatchDay (GET /admin/players/{id}) or Stripe (customers.list,
// subscriptions.list) for a small, deterministic sample and returns ids, statuses and dates — no
// names, no emails. The backfill itself (the POST that writes mdapi_subscription_stripe_end) is not
// here yet: it depends on a migration that has not been applied.

import { authenticateAdmin } from "@/lib/adminAuth";
import { probeLowPricePlans, probeMatchday, probeStripe } from "@/lib/stripeSubEnds";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const MAX_N = 12;

export async function GET(req: Request) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const url = new URL(req.url);
  const probe = url.searchParams.get("probe");
  const n = Math.min(MAX_N, Math.max(1, Number(url.searchParams.get("n") ?? 10) || 10));
  try {
    if (probe === "matchday") return Response.json(await probeMatchday(auth.supabase, n));
    if (probe === "stripe") return Response.json(await probeStripe(auth.supabase, n));
    if (probe === "low_plans") return Response.json(await probeLowPricePlans(auth.supabase));
    return Response.json({ error: 'probe must be "matchday", "stripe" or "low_plans"' }, { status: 400 });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message.slice(0, 200) : "probe failed" }, { status: 500 });
  }
}
