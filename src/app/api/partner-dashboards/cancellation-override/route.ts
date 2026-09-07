// A CANCELLED DATE THAT OWES THE FIELD RENTAL — the operator's decision, stored and auditable.
//
// WHY THIS ROUTE EXISTS AT ALL. The signed terms let MatchDay be charged the rental on a booking
// cancelled with less than twelve hours' notice, and never on a weather cancellation the venue
// calls. Neither fact is in our data:
//   - NO CANCELLATION TIMESTAMP. mdapi_matches carries is_cancelled, auto_canceled,
//     auto_canceled_minutes, created_at, updated_at and deleted_at — and nothing that says when a
//     match was cancelled. On the Sep 5 PARMER match (api_id 18321, kickoff 20:00) updated_at is
//     22:50, 2h50m AFTER kickoff, because the roster was still being edited then.
//   - NOBODY RECORDS WHO CANCELLED. No change_log row for 18321, 18185 or 18182 sets isCancelled;
//     none of them was cancelled through Cockpit.
// So the notice cannot be derived and the weather case cannot be inferred. This is the operator
// saying so, once, with a reason, in a row that outlives the page.
//
// NOT LOCAL STATE. It decides what a real venue is paid, so it lands in
// partner_match_rental_overrides and goes through recordWrite into change_log with the operator's
// name on it. Clearing an override is a DELETE and is logged as its own change — the fact that it
// once existed survives in change_log.
//
// The amount is never taken from the client: this route stores a boolean and a reason, and every
// figure is recomputed server-side from the partner row's own parameters.

import { randomUUID } from "node:crypto";
import { authenticateCapability } from "@/lib/capabilityAuth";
import { recordWrite, supabaseLogStore } from "@/lib/changeLog";
import type { Change } from "@/lib/changeLogModel";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const auth = await authenticateCapability(req, "matchops");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const supabase = auth.supabase;

  const body = (await req.json().catch(() => null)) as
    | { partnerId?: unknown; matchApiId?: unknown; rentalCharged?: unknown; reason?: unknown }
    | null;
  const partnerId = typeof body?.partnerId === "string" ? body.partnerId : "";
  const matchApiId = Number(body?.matchApiId);
  // THREE STATES, and null is a real one: charge it, waive it, or say nothing (which clears the
  // row and returns the date to owing nothing).
  const rentalCharged = body?.rentalCharged === true ? true : body?.rentalCharged === false ? false : null;
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";

  if (!partnerId || !Number.isFinite(matchApiId) || matchApiId <= 0) {
    return Response.json({ error: "partnerId and matchApiId are required" }, { status: 400 });
  }
  // A REASON IS MANDATORY ON A DECISION, because "weather" and "they cancelled that morning" are
  // the two cases and neither is recoverable from the data afterwards. Clearing needs none.
  if (rentalCharged !== null && reason.length < 3) {
    return Response.json({ error: "A reason is required (3-500 characters)" }, { status: 400 });
  }
  if (reason.length > 500) return Response.json({ error: "Reason is too long (500 characters)" }, { status: 400 });

  const { data: partner } = await supabase
    .from("partner_dashboards")
    .select("id, partner_name")
    .eq("id", partnerId)
    .maybeSingle();
  if (!partner) return Response.json({ error: "Partner not found" }, { status: 404 });

  const readRow = async (): Promise<Record<string, unknown>> => {
    const { data } = await supabase
      .from("partner_match_rental_overrides")
      .select("rental_charged, reason")
      .eq("partner_dashboard_id", partnerId)
      .eq("match_api_id", matchApiId)
      .maybeSingle();
    return {
      decision: data == null ? "none" : data.rental_charged === true ? "charged" : "waived",
      reason: (data?.reason as string | null) ?? "—",
    };
  };

  const before = await readRow();
  const afterDecision = rentalCharged === null ? "none" : rentalCharged ? "charged" : "waived";
  const changes: Change[] = [
    { key: "decision", field: `${partner.partner_name} · match ${matchApiId}`, before: String(before.decision), after: afterDecision },
    { key: "reason", field: "Reason", before: String(before.reason), after: reason || "—" },
  ];

  const { error: writeErr, outcome } = await recordWrite(
    {
      env: "production", source: "Partner Dashboards · cancellation fee",
      actorName: auth.email, actorEmail: auth.email, saveId: randomUUID(),
      matchId: matchApiId, matchName: null,
      method: "POST", path: `/partner-dashboards/${partnerId}/cancellation-override/${matchApiId}`,
      body: { rentalCharged, reason },
      keys: ["decision", "reason"],
      label: (k) => (k === "decision" ? "Rental on a cancelled date" : "Reason"),
      // THE VERDICT COMES FROM A RE-READ, never from the absence of an error.
      applied: (_b, a) => a.decision === afterDecision,
      changes,
    },
    {
      now: () => new Date().toISOString(),
      readResource: readRow,
      write: async () => {
        if (rentalCharged === null) {
          // pg_safeupdate: every write here is keyed on both columns, never unqualified.
          const { error } = await supabase
            .from("partner_match_rental_overrides")
            .delete()
            .eq("partner_dashboard_id", partnerId)
            .eq("match_api_id", matchApiId);
          if (error) throw new Error(error.message);
          return { cleared: true };
        }
        const { error } = await supabase
          .from("partner_match_rental_overrides")
          .upsert(
            {
              partner_dashboard_id: partnerId,
              match_api_id: matchApiId,
              rental_charged: rentalCharged,
              reason,
              created_by: auth.email,
              updated_at: new Date().toISOString(),
            },
            { onConflict: "partner_dashboard_id,match_api_id" },
          );
        if (error) throw new Error(error.message);
        return { ok: true };
      },
    },
    supabaseLogStore(),
  );

  if (writeErr) return Response.json({ error: writeErr.message, outcome }, { status: 500 });
  return Response.json({ ok: true, outcome, decision: afterDecision });
}
