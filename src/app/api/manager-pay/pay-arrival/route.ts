// Manager Pay estimated-arrival override — ADMIN ONLY (authenticateAdmin).
//
//   PUT    { weekStart, arrivalDate, reason } → set/replace the hand-set arrival
//          for a week. Records set_by + set_at (server trigger not needed — we
//          stamp set_at here with the service role). reason is required.
//   DELETE ?week=YYYY-MM-DD → reset to the computed value (removes the row).
//
// An override is never silent: it carries who/when/reason and the UI marks it and
// offers reset. A token-authenticated (share-link) caller has no session Bearer
// and is rejected 401 — this endpoint is unreachable with just the share token.

import { authenticateAdmin } from "@/lib/adminAuth";
import { ISO_DATE_RX, weekdayUtc } from "@/lib/managerPayCompute";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(req: Request) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const body = await req.json().catch(() => null);
  const weekStart = typeof body?.weekStart === "string" ? body.weekStart : "";
  const arrivalDate = typeof body?.arrivalDate === "string" ? body.arrivalDate : "";
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  if (!ISO_DATE_RX.test(weekStart) || weekdayUtc(weekStart) !== 1) {
    return Response.json({ error: "weekStart must be a Monday (YYYY-MM-DD)" }, { status: 400 });
  }
  if (!ISO_DATE_RX.test(arrivalDate)) {
    return Response.json({ error: "arrivalDate must be YYYY-MM-DD" }, { status: 400 });
  }
  if (!reason) return Response.json({ error: "A reason is required" }, { status: 400 });

  const { error } = await auth.supabase.from("manager_pay_arrival_overrides").upsert(
    { week_start: weekStart, arrival_date: arrivalDate, reason, set_by: auth.appUserId, set_at: new Date().toISOString() },
    { onConflict: "week_start" },
  );
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ ok: true });
}

export async function DELETE(req: Request) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const week = new URL(req.url).searchParams.get("week") ?? "";
  if (!ISO_DATE_RX.test(week)) return Response.json({ error: "?week must be YYYY-MM-DD" }, { status: 400 });
  const { error } = await auth.supabase.from("manager_pay_arrival_overrides").delete().eq("week_start", week);
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ ok: true });
}
