// DELETE /api/city-check-ins/[id] — remove one city_manager_check_ins row.
//
// Ryan: "I also need to be able to delete the checkin". Shaped on /api/inventory/[id]: validate the
// uuid, mutate with the session client, report how many rows actually went.
//
// ── THE GATE IS is_admin, AND THAT IS A DELIBERATE DIFFERENCE FROM THE FILE THIS COPIES ──────
// /api/inventory/[id] gates on authenticateCapability(req, "matchops") while its own header
// comment says it gates on authenticateAdmin. The comment is wrong there, and copying the code
// would have made the card's `appUser?.is_admin === true` gate a courtesy: matchops is held by
// non-admin operators, so any of them could delete another city's check-in through the API while
// the button was hidden from them. authenticateAdmin makes the visible gate the real one.
//
// It also refuses a CONFINED account before it reaches the admin test, so a city manager carrying
// a stray is_admin flag is still refused — see adminAuth.ts. That matters here because matchops is
// IN CONFINED_CAPABILITIES: confinement does not withhold the matchops capability, it withholds
// the ROUTES, via assertConfinedRoute's allowlist. This path is not on that allowlist and must
// never be added to it.
//
// Deleting the latest row needs no "fall back" logic. The row is gone, the page refetches, and
// buildCheckInsData naturally surfaces that city's previous submission — or returns the card to
// No Response if none remains, because it builds statuses from MANAGERS regardless of rows.

import { authenticateAdmin } from "@/lib/adminAuth";

export const runtime = "nodejs";
export const maxDuration = 10;

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Ctx = { params: Promise<{ id: string }> };

export async function DELETE(req: Request, ctx: Ctx) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const { id } = await ctx.params;
  if (!id || !UUID_RX.test(id)) {
    return Response.json({ error: "Invalid check-in id" }, { status: 400 });
  }

  /* .select("id") SO removed IS A MEASUREMENT, NOT AN ASSUMPTION. A delete that matches nothing is
   * a 2xx with no error in PostgREST — the caller would report success for a row that is still
   * there, or for one someone else removed a second earlier. */
  const del = await auth.supabase
    .from("city_manager_check_ins")
    .delete()
    .eq("id", id)
    .select("id");
  if (del.error) {
    console.error("[city-check-ins:delete] delete failed", del.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }
  const removed = del.data?.length ?? 0;
  if (removed === 0) {
    return Response.json({ error: "Check-in not found" }, { status: 404 });
  }

  console.log(`[city-check-ins:delete] id=${id} removed=${removed} by=${auth.appUserId}`);
  return Response.json({ ok: true, removed }, { status: 200 });
}
