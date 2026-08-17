// APPLE MONTHLY ARCHIVE — its own step, its own budget, loud when it does not run.
//
// WHY IT IS NOT PART OF app-store-installs. That step has already been STARVED: the cron pipeline
// runs against a 300s ceiling and app-store-installs has been killed at +288s before it started
// (its own file says so). An archive appended to a step that silently does not run is the exact
// failure mode we have hit repeatedly — a control that looks live and does nothing. This has its
// own route, its own maxDuration, and it reports a skip or a timeout as a FAILURE rather than
// exiting clean.
//
// WHY IT EXISTS AT ALL. Apple keeps MONTHLY Sales and Trends reports for ONE YEAR and never
// regenerates them; once a month leaves that window it is gone for good. The daily ingest inherits
// the same rolling window, so it is not an archive. This copies each month Apple still serves into
// app_downloads at period_grain 'month', where it survives Apple dropping it.
//
// THE DEADLINE IS REAL: roughly twelve months are retrievable and one falls off every month.
//
// A 404 WRITES NOTHING. Not a zero — a zero would erase a month already archived on the day Apple
// stops serving it, which is precisely when the archive is the only copy left.
import { archiveAppStoreMonths, AppleAuthError } from "@/lib/appStoreInstallsSync";
import { authenticateAdmin } from "@/lib/adminAuth";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// ITS OWN BUDGET. ~18 sequential Apple calls; the daily step's ceiling is not shared.
export const maxDuration = 300;

function serviceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase service credentials are not configured");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

// Admin (a human triggering the backfill) OR the cron secret, once this is scheduled. Both are
// checked explicitly; there is no unauthenticated path.
async function authorize(req: Request): Promise<{ ok: true; who: string } | { ok: false; status: number; error: string }> {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization") ?? "";
  if (secret && auth === `Bearer ${secret}`) return { ok: true, who: "cron" };
  const a = await authenticateAdmin(req);
  if (a.ok) return { ok: true, who: a.email };
  return { ok: false, status: a.status, error: a.error };
}

export async function POST(req: Request) {
  const who = await authorize(req);
  if (!who.ok) return Response.json({ error: who.error }, { status: who.status });

  const months = Number(new URL(req.url).searchParams.get("months") ?? 24);
  const startedAt = Date.now();
  try {
    const summary = await archiveAppStoreMonths(serviceClient(), new Date(), {
      months: Number.isFinite(months) ? Math.min(36, Math.max(1, months)) : 24,
      stopAfterMisses: 3,
    });
    const elapsedMs = Date.now() - startedAt;

    // A RUN THAT ARCHIVED NOTHING IS A FAILURE, not a quiet success. Either the credentials are
    // wrong, or Apple served nothing at all — both need saying out loud, because the window this
    // protects is closing whether or not anyone reads a 200.
    if (summary.monthsArchived === 0) {
      return Response.json({
        ok: false,
        outcome: "NOT APPLIED",
        error: "No month was archived. Apple served no monthly report for any requested month.",
        elapsedMs, triggeredBy: who.who, ...summary,
      }, { status: 502 });
    }
    return Response.json({ ok: true, outcome: "LANDED", elapsedMs, triggeredBy: who.who, ...summary });
  } catch (e) {
    if (e instanceof AppleAuthError) {
      return Response.json({
        ok: false, outcome: "FAILED", error: `App Store Connect rejected the request: ${e.message}`,
        elapsedMs: Date.now() - startedAt,
      }, { status: 502 });
    }
    return Response.json({
      ok: false, outcome: "FAILED",
      error: e instanceof Error ? e.message : String(e),
      elapsedMs: Date.now() - startedAt,
    }, { status: 500 });
  }
}

// GET reports what is ALREADY archived, so the window can be checked without calling Apple.
export async function GET(req: Request) {
  const who = await authorize(req);
  if (!who.ok) return Response.json({ error: who.error }, { status: who.status });
  const sb = serviceClient();
  const { data, error } = await sb
    .from("app_downloads")
    .select("period_date, count")
    .eq("platform", "ios").eq("period_grain", "month")
    .order("period_date");
  if (error) return Response.json({ error: error.message }, { status: 500 });
  const rows = data ?? [];
  return Response.json({
    monthsArchived: rows.length,
    earliest: rows[0]?.period_date ?? null,
    latest: rows[rows.length - 1]?.period_date ?? null,
    unitsTotal: rows.reduce((a, r) => a + (Number(r.count) || 0), 0),
    months: rows.map((r) => ({ month: String(r.period_date).slice(0, 7), units: r.count })),
  });
}
