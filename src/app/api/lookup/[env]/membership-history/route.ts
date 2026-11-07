// GET /api/lookup/{env}/membership-history?id=<playerId>
// One player's membership history sources, READ ONLY, from our own database. No MatchDay request and
// no Stripe request is made here, so opening a profile adds no load to the production API.
//
// RETURNS the raw rows; the page builds the history with src/lib/membershipHistory.ts, joining the
// live membership the profile already read (current status, price, period end). Building it there
// keeps this read free of a second GET /admin/players/{id}.
//
//   mdapi_subscriptions     the player's membership rows (no email, phone or name is selected)
//   stripe_member_invoices  their paid invoices (service role only, 0236)
//   fin_txn                 Membership refunds, linked charge → payment intent → invoice
//   mdapi_subscription_stripe_end  Stripe's end date per CANCELED membership (0261), when asked
//   stripe_member_unpaid_invoices  renewals Stripe was not paid for, with attempts (0262)
//
// GATE: the same as the Membership card today — the Player Lookup profile read (Match Ops read,
// authenticateMatchOpsRead), and for a confined account the same city union the profile route
// applies (home city OR a played match in the city), from our mirror. Staging has no copy of these
// tables, so a staging request answers ok:false and says so.

import { authenticateMatchOpsRead } from "@/lib/matchOpsAuth";
import { cityNameFor } from "@/lib/cityScope";
import { CONFINED_CITY_ERROR, playerInConfinedScope } from "@/lib/cityConfinement";
import { hasPlayedInCity } from "@/lib/playerCityScope";
import { isFakePlayerEmail } from "@/lib/mdapiFakePlayer";
import { makeServerClient } from "@/lib/supabaseServer";
import type { InvoiceRow, RefundRow, SubRow, UnpaidRow } from "@/lib/membershipHistory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MAX = 1000; // a player with more than 1,000 invoices or rows does not exist; refuse rather than truncate

export async function GET(req: Request, ctx: { params: Promise<{ env: string }> }) {
  const auth = await authenticateMatchOpsRead(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { env } = await ctx.params;
  if (env !== "production" && env !== "staging") return Response.json({ error: "unknown environment" }, { status: 400 });
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!/^\d+$/.test(id)) return Response.json({ error: "id must be numeric" }, { status: 400 });
  if (env === "staging") {
    return Response.json({ ok: false, error: "Membership history is read from production records; staging has no copy." });
  }
  const uid = Number(id);
  const sb = makeServerClient();
  const t0 = Date.now();

  if (auth.confined) {
    if (!auth.confinedCity) return Response.json({ error: CONFINED_CITY_ERROR }, { status: 403 });
    const want = cityNameFor(auth.confinedCity) ?? "";
    const u = await sb.from("mdapi_users").select("preferable_city_name, email").eq("id", uid).maybeSingle();
    if (u.error) return Response.json({ error: `Could not read the player: ${u.error.message}` }, { status: 502 });
    const home = (u.data?.preferable_city_name as string | null) ?? null;
    const played = home === want ? false : await hasPlayedInCity(sb, want, uid);
    const allowed = playerInConfinedScope(auth.confinedCity, {
      homeCityName: home,
      playedInScope: played && !isFakePlayerEmail((u.data?.email as string | null) ?? null),
    });
    if (!allowed) return Response.json({ error: CONFINED_CITY_ERROR }, { status: 403 });
  }

  const [subs, invs, ends, unpaidQ] = await Promise.all([
    sb.from("mdapi_subscriptions")
      .select("membership_id, status, price, activation_date, canceled_at, cancel_reason, synced_at", { count: "exact" })
      .eq("user_id", uid).order("membership_id").limit(MAX),
    sb.from("stripe_member_invoices")
      .select("md_membership_id, amount_paid_cents, billing_reason, created_at_utc, payment_intent_id, attempt_count", { count: "exact" })
      .eq("md_user_id", uid).order("created_at_utc").limit(MAX),
    sb.from("mdapi_subscription_stripe_end")
      .select("membership_id, stripe_status, stripe_ended_at, match_method")
      .eq("user_id", uid).limit(MAX),
    sb.from("stripe_member_unpaid_invoices")
      .select("md_membership_id, amount_due_cents, status, billing_reason, attempt_count, next_payment_attempt_utc, last_failure_code, created_at_utc")
      .eq("md_user_id", uid).limit(MAX),
  ]);
  if (subs.error) return Response.json({ ok: false, error: `Membership records could not be read: ${subs.error.message}` }, { status: 502 });
  if (invs.error) return Response.json({ ok: false, error: `Invoices could not be read: ${invs.error.message}` }, { status: 502 });
  if (unpaidQ.error) return Response.json({ ok: false, error: `Unpaid invoices could not be read: ${unpaidQ.error.message}` }, { status: 502 });
  if (ends.error) return Response.json({ ok: false, error: `Stripe end dates could not be read: ${ends.error.message}` }, { status: 502 });
  /* ONLY A MATCHED ROW SPEAKS. "unmatched" (no subscription, or Stripe's metadata naming another
   * membership) leaves the card on its estimate. */
  const endOf = new Map((ends.data ?? []).filter((e) => e.match_method === "stripe_metadata")
    .map((e) => [Number(e.membership_id), { status: e.stripe_status as string | null, ended: e.stripe_ended_at as string | null }]));
  if ((subs.count ?? 0) > MAX || (invs.count ?? 0) > MAX) {
    return Response.json({ ok: false, error: "More rows than this read takes; nothing was shown rather than a partial history." }, { status: 502 });
  }

  // Refunds: charge rows carrying these payment intents, then refund rows on those charges. A refund
  // row carries the charge, not the payment intent (2026-11-07), hence the two steps.
  const pis = [...new Set((invs.data ?? []).map((v) => v.payment_intent_id as string | null).filter((x): x is string => !!x))];
  let refunds: RefundRow[] = [];
  if (pis.length) {
    const charges = await sb.from("fin_txn").select("charge_id, payment_intent_id").eq("kind", "charge").in("payment_intent_id", pis);
    if (charges.error) return Response.json({ ok: false, error: `Refunds could not be read: ${charges.error.message}` }, { status: 502 });
    const piOf = new Map<string, string>();
    for (const c of charges.data ?? []) if (c.charge_id && c.payment_intent_id) piOf.set(c.charge_id as string, c.payment_intent_id as string);
    if (piOf.size) {
      const rf = await sb.from("fin_txn").select("charge_id, gross_cents, created_at_utc").eq("kind", "refund").in("charge_id", [...piOf.keys()]);
      if (rf.error) return Response.json({ ok: false, error: `Refunds could not be read: ${rf.error.message}` }, { status: 502 });
      refunds = (rf.data ?? []).map((r) => ({
        payment_intent_id: piOf.get(r.charge_id as string) as string,
        cents: Math.abs(Number(r.gross_cents) || 0),
        created_at_utc: r.created_at_utc as string,
      }));
    }
  }

  const rows: SubRow[] = (subs.data ?? []).map((r) => ({
    membership_id: Number(r.membership_id), status: r.status as string | null, price: r.price == null ? null : Number(r.price),
    activation_date: r.activation_date as string | null, canceled_at: r.canceled_at as string | null, cancel_reason: r.cancel_reason as string | null,
    stripe_status: endOf.get(Number(r.membership_id))?.status ?? null,
    stripe_ended_at: endOf.get(Number(r.membership_id))?.ended ?? null,
  }));
  const invoices: InvoiceRow[] = (invs.data ?? []).map((v) => ({
    md_membership_id: Number(v.md_membership_id), amount_paid_cents: Number(v.amount_paid_cents), billing_reason: v.billing_reason as string | null,
    created_at_utc: v.created_at_utc as string, payment_intent_id: v.payment_intent_id as string | null,
    attempt_count: v.attempt_count == null ? null : Number(v.attempt_count),
  }));
  const unpaid: UnpaidRow[] = (unpaidQ.data ?? []).filter((u) => u.md_membership_id != null).map((u) => ({
    md_membership_id: Number(u.md_membership_id), amount_due_cents: Number(u.amount_due_cents), status: u.status as string,
    billing_reason: u.billing_reason as string | null, attempt_count: u.attempt_count == null ? null : Number(u.attempt_count),
    next_payment_attempt_utc: u.next_payment_attempt_utc as string | null, last_failure_code: u.last_failure_code as string | null,
    created_at_utc: u.created_at_utc as string,
  }));
  const syncedAt = (subs.data ?? []).map((r) => r.synced_at as string | null).filter(Boolean).sort().pop() ?? null;
  return new Response(JSON.stringify({ ok: true, rows, invoices, refunds, unpaid, syncedAt, ms: Date.now() - t0 }), {
    status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
