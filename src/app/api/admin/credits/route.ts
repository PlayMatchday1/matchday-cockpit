/* GET /api/admin/credits — THE CREDITS REPORT (Ryan, 2026-11-10). Admins only. Read-only.
 *
 * Finance › Credits, the Monthly tab and its warning line. Our database only, no MatchDay API call:
 *   cancellation credits and credits used   rebuilt from mdapi_matches + mdapi_match_players (lib/creditsReport)
 *   staff credits                           change_log, exactly as the Staff tab counts them (lib/staffCredits),
 *                                           less Warsaw players and our own test accounts
 *   month-end balance                       credit_balance_snapshots (0269): the night snapshot on the 1st
 *   flags                                   negative balances (mdapi_users), "credit everyone who paid" on a
 *                                           match that was later cancelled
 * The E2E service account is refused whatever its row says (keyed on email, CLAUDE.md "Permissions").
 */

import { authenticateAdmin } from "@/lib/adminAuth";
import { E2E_SERVICE_EMAIL } from "@/lib/matchOpsAuth";
import { loadCreditsReport } from "@/lib/creditsReportLoad";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  if (auth.email.toLowerCase() === E2E_SERVICE_EMAIL) return Response.json({ error: "Service accounts cannot read this" }, { status: 403 });
  try {
    return Response.json(await loadCreditsReport(auth.supabase), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[api/admin/credits] failed", e instanceof Error ? e.message : e);
    return Response.json({ error: "Couldn't build the credits report." }, { status: 500 });
  }
}
