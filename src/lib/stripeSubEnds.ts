/* STRIPE END DATES FOR UNDATED CANCELLATIONS — THE PROBES (2026-10-14). READ ONLY, everywhere.
 *
 * 597 paying-plan mdapi_subscriptions rows are CANCELED with no canceled_at. Revenue per Player
 * counts each only in its activation month until a real end date exists (growthAnalytics
 * .paidMemberMonths). Stripe holds that date; the backfill that fetches it is approved but waits on
 * two things this file measures FIRST, on a small sample, before anything is built on them:
 *
 *   probe "matchday"  Does GET /admin/players/{id} → userSubscriptions[].id equal our membership_id,
 *                     and does it return a CANCELED row at all? membershipAdminModel.ts records
 *                     (staging + users.repository.ts) that the include is `status in [ACTIVE] AND
 *                     currentPeriodEnd >= now` — if that holds on production, the 597 are not there
 *                     and their stripeSubscriptionId cannot come from MatchDay.
 *   probe "stripe"    The fallback if they are not: find the subscription in Stripe by the
 *                     customer's email, matched on start date and plan amount.
 *
 * NOTHING HERE WRITES. Not to MatchDay, not to Stripe, not to Supabase, not to fin_sync_log (the
 * new source is not in its allowlist yet). Output carries ids, statuses and dates — never a name or
 * an email. MatchDay calls are sequential with a gap (under three a second); Stripe calls likewise.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { selectAll } from "./supabasePagination";
import { isPaidMemberSubscription } from "./membershipStats";
import { apiGet } from "./matchdayStageApi";
import { getStripe } from "./stripePayments";

type SubRow = {
  membership_id: number; user_id: number; status: string | null; price: number | string | null;
  member_email: string | null; activation_date: string | null; canceled_at: string | null;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MD_GAP_MS = 400;     // MatchDay: at most ~2.5 calls a second
const STRIPE_GAP_MS = 250; // Stripe: ~4 a second, far under its read limit

/** The 597: paying plan, CANCELED, no canceled_at. */
export const isUndatedPaidCancel = (r: SubRow) =>
  r.status === "CANCELED" && !r.canceled_at && isPaidMemberSubscription(r);

/** A deterministic spread: n rows evenly across the list ordered by membership_id. */
export function spreadSample<T>(rows: T[], n: number): T[] {
  if (rows.length <= n) return rows;
  const step = rows.length / n;
  return Array.from({ length: n }, (_, i) => rows[Math.floor(i * step)]);
}

export async function loadSubs(sb: SupabaseClient): Promise<SubRow[]> {
  return selectAll<SubRow>(() => sb.from("mdapi_subscriptions")
    .select("membership_id,user_id,status,price,member_email,activation_date,canceled_at").order("membership_id"));
}

/* ── PROBE 1: MatchDay ids ────────────────────────────────────────────────────────────────── */
export type MatchdayProbeRow = {
  group: "undated_cancel" | "control_active";
  membershipId: number; userId: number;
  userSubscriptionIds: number[];      // what /admin/players/{id} returned
  statusesReturned: string[];
  idMatches: boolean;                 // our membership_id is among userSubscriptions[].id
  stripeIdOnMatch: boolean | null;    // the matched entry carries a stripeSubscriptionId
  error: string | null;
};

export async function probeMatchday(sb: SupabaseClient, n: number) {
  const subs = await loadSubs(sb);
  const undated = subs.filter(isUndatedPaidCancel);
  /* THE POSITIVE CONTROL. ACTIVE paying rows ARE returned by the endpoint per the repository note,
   * so a "no match" on the undated sample means something only if the controls DO match. */
  const control = spreadSample(subs.filter((r) => r.status === "ACTIVE" && isPaidMemberSubscription(r)), 3);
  const sample = [
    ...spreadSample(undated, n).map((r) => ({ r, group: "undated_cancel" as const })),
    ...control.map((r) => ({ r, group: "control_active" as const })),
  ];
  const rows: MatchdayProbeRow[] = [];
  for (const { r, group } of sample) {
    const out: MatchdayProbeRow = { group, membershipId: r.membership_id, userId: r.user_id, userSubscriptionIds: [],
      statusesReturned: [], idMatches: false, stripeIdOnMatch: null, error: null };
    try {
      const p = await apiGet<Record<string, unknown>>("production", `/admin/players/${r.user_id}`);
      const us = Array.isArray(p.userSubscriptions) ? (p.userSubscriptions as Record<string, unknown>[]) : [];
      out.userSubscriptionIds = us.map((u) => Number(u.id)).filter(Number.isFinite);
      out.statusesReturned = [...new Set(us.map((u) => String(u.status ?? "")))];
      const hit = us.find((u) => Number(u.id) === r.membership_id);
      out.idMatches = !!hit;
      out.stripeIdOnMatch = hit ? typeof hit.stripeSubscriptionId === "string" && hit.stripeSubscriptionId.length > 0 : null;
    } catch (e) {
      out.error = e instanceof Error ? e.message.slice(0, 160) : "read failed";
    }
    rows.push(out);
    await sleep(MD_GAP_MS);
  }
  const by = (g: MatchdayProbeRow["group"]) => rows.filter((x) => x.group === g);
  return {
    probe: "matchday", undatedTotal: undated.length,
    summary: {
      undated: { sampled: by("undated_cancel").length, idMatches: by("undated_cancel").filter((x) => x.idMatches).length,
        returnedAnySubscription: by("undated_cancel").filter((x) => x.userSubscriptionIds.length > 0).length,
        errors: by("undated_cancel").filter((x) => x.error).length },
      control: { sampled: by("control_active").length, idMatches: by("control_active").filter((x) => x.idMatches).length,
        withStripeId: by("control_active").filter((x) => x.stripeIdOnMatch).length,
        errors: by("control_active").filter((x) => x.error).length },
    },
    rows,
  };
}

/* ── PROBE 2: Stripe by customer email (the fallback) ─────────────────────────────────────── */
export type StripeProbeRow = {
  membershipId: number; activation: string | null; planCents: number;
  customers: number;                  // Stripe customers holding that exact email
  subscriptions: number;              // every subscription across them, any status
  candidates: number;                 // start within 2 days of activation AND same plan amount
  candidateStatus: string | null; candidateCanceledAt: string | null; candidateEndedAt: string | null;
  error: string | null;
};

const iso = (s: number | null | undefined) => (typeof s === "number" ? new Date(s * 1000).toISOString() : null);

export async function probeStripe(sb: SupabaseClient, n: number) {
  const subs = await loadSubs(sb);
  const undated = subs.filter(isUndatedPaidCancel);
  const stripe = getStripe();
  const rows: StripeProbeRow[] = [];
  for (const r of spreadSample(undated, n)) {
    const planCents = Math.round(Number(r.price ?? 0) * 100);
    const out: StripeProbeRow = { membershipId: r.membership_id, activation: r.activation_date, planCents, customers: 0,
      subscriptions: 0, candidates: 0, candidateStatus: null, candidateCanceledAt: null, candidateEndedAt: null, error: null };
    try {
      const email = (r.member_email ?? "").trim();
      const cust = email ? await stripe.customers.list({ email, limit: 10 }) : { data: [] };
      out.customers = cust.data.length;
      const act = Date.parse(r.activation_date ?? "");
      const cands: { status: string; canceled_at: number | null; ended_at: number | null }[] = [];
      for (const c of cust.data) {
        await sleep(STRIPE_GAP_MS);
        const list = await stripe.subscriptions.list({ customer: c.id, status: "all", limit: 100 });
        out.subscriptions += list.data.length;
        for (const s of list.data) {
          const amt = s.items?.data?.[0]?.price?.unit_amount ?? null;
          const near = Number.isFinite(act) && Math.abs(s.start_date * 1000 - act) <= 2 * 86_400_000;
          if (near && amt === planCents) cands.push({ status: s.status, canceled_at: s.canceled_at ?? null, ended_at: s.ended_at ?? null });
        }
      }
      out.candidates = cands.length;
      if (cands.length === 1) {
        out.candidateStatus = cands[0].status;
        out.candidateCanceledAt = iso(cands[0].canceled_at);
        out.candidateEndedAt = iso(cands[0].ended_at);
      }
    } catch (e) {
      out.error = e instanceof Error ? e.message.slice(0, 160) : "read failed";
    }
    rows.push(out);
    await sleep(STRIPE_GAP_MS);
  }
  return {
    probe: "stripe", undatedTotal: undated.length,
    summary: {
      sampled: rows.length,
      noCustomer: rows.filter((x) => !x.error && x.customers === 0).length,
      uniqueCandidate: rows.filter((x) => x.candidates === 1).length,
      ambiguous: rows.filter((x) => x.candidates > 1).length,
      noCandidate: rows.filter((x) => !x.error && x.customers > 0 && x.candidates === 0).length,
      withEndedAt: rows.filter((x) => x.candidateEndedAt).length,
      withCanceledAt: rows.filter((x) => x.candidateCanceledAt).length,
      errors: rows.filter((x) => x.error).length,
    },
    rows,
  };
}
