/* POST /api/admin/credits/rebuild { month: "YYYY-MM" } — REBUILD ONE STORED MONTH of Finance › Credits (Ryan,
 * 2026-11-10). Admins only. Writes our database only (credit_months, change_log), never the MatchDay API. The night
 * run never overwrites a stored month; this is the one thing that does (lib/creditsReportLoad rebuildStoredMonth).
 * The E2E service account is refused whatever its row says (keyed on email, CLAUDE.md "Permissions").
 */

import { authenticateAdmin } from "@/lib/adminAuth";
import { E2E_SERVICE_EMAIL } from "@/lib/matchOpsAuth";
import { rebuildStoredMonth } from "@/lib/creditsReportLoad";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  if (auth.email.toLowerCase() === E2E_SERVICE_EMAIL) return Response.json({ error: "Service accounts cannot do this" }, { status: 403 });
  const body = await req.json().catch(() => null) as { month?: unknown } | null;
  const month = typeof body?.month === "string" ? body.month : "";
  try {
    const r = await rebuildStoredMonth(auth.supabase, month, { email: auth.email, name: auth.email });
    return r.ok ? Response.json(r, { headers: { "Cache-Control": "no-store" } }) : Response.json({ error: r.error }, { status: r.status });
  } catch (e) {
    console.error("[api/admin/credits/rebuild] failed", e instanceof Error ? e.message : e);
    return Response.json({ error: "Couldn't rebuild the month." }, { status: 500 });
  }
}
