import "server-only";
// Disputes page: the reads. Read only: nothing here writes to Stripe, the backend or our tables
// (the change-log row for a view or a copy is written by the routes, through logDisputeEvent).
//
// STRIPE. The US account only: STRIPE_SECRET_KEY is MatchDay's US account (docs/matchday-api-facts.md,
// "both are the US Stripe account only (no Warsaw)"); Poland's licensee has its own Stripe and no key
// here. There is no Stripe gate in the Clubhouse (mdapiGate covers the MatchDay API only), so this file
// carries its own: ONE list read at a time per instance (single flight), pages fetched one after another,
// the result cached for CACHE_MS, a failure cached for FAIL_MS so a broken read is not repeated on every
// badge poll, and no retries.
//
// MATCHING (docs/disputes/investigation.md §a): dispute.payment_intent → stripe_member_invoices
// .payment_intent_id → md_user_id, md_membership_id (102 of 102 historic membership disputes resolve).
// Else the charge's customer → stripe_customers.md_user_id. The list makes no per-row network call;
// the backend evidence endpoint is read for the SELECTED dispute only, and may itself match a member
// by the Stripe customer when our tables could not.

import Stripe from "stripe";
import { getStripe } from "@/lib/stripePayments";
import { makeServerClient } from "@/lib/supabaseServer";
import { getMatchdayApiClient, MatchdayApiError } from "@/lib/matchdayApi";
import {
  bucketOf, type DisputeRow, type DisputeMember, type DisputeEvidence, type TermsAcceptance,
  type CancelConfirmation, type PeriodMatch, type ChatSummary,
} from "@/lib/disputesModel";

const CACHE_MS = 3 * 60_000;
const FAIL_MS = 60_000;
const LIST_DAYS = 365; // open disputes are far younger than this; the Closed tab shows 90 days
const MAX_PAGES = 10;  // 1,000 disputes; the account sees ~10 a month

type Listed = { rows: DisputeRow[]; readAt: string };
let listCache: { at: number; value?: Listed; error?: string } | null = null;
let listFlight: Promise<Listed> | null = null;

export class DisputesReadError extends Error { constructor(m: string) { super(m); this.name = "DisputesReadError"; } }

/** Every dispute created in the last year, matched to members. Cached; one read in flight at a time. */
export async function listDisputes(opts: { fresh?: boolean } = {}): Promise<Listed> {
  const now = Date.now();
  if (listCache && !opts.fresh) {
    if (listCache.value && now - listCache.at < CACHE_MS) return listCache.value;
    if (listCache.error && now - listCache.at < FAIL_MS) throw new DisputesReadError(listCache.error);
  }
  if (listFlight) return listFlight;
  listFlight = (async () => {
    try {
      const value = await readAll();
      listCache = { at: Date.now(), value };
      return value;
    } catch (e) {
      const msg = e instanceof Stripe.errors.StripeError ? `Stripe said: ${e.message}` : e instanceof Error ? e.message : String(e);
      listCache = { at: Date.now(), error: msg };
      throw new DisputesReadError(msg);
    } finally {
      listFlight = null;
    }
  })();
  return listFlight;
}

async function readAll(): Promise<Listed> {
  const stripe = getStripe();
  const since = Math.floor(Date.now() / 1000) - LIST_DAYS * 86_400;
  const disputes: Stripe.Dispute[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    // One page at a time, never in parallel; Stripe's client retries are off for this read.
    const res = await stripe.disputes.list(
      { limit: 100, created: { gte: since }, expand: ["data.charge"], ...(startingAfter ? { starting_after: startingAfter } : {}) },
      { maxNetworkRetries: 0 },
    );
    disputes.push(...res.data);
    if (!res.has_more || res.data.length === 0) break;
    startingAfter = res.data[res.data.length - 1].id;
  }

  const idOf = (x: string | { id: string } | null | undefined) => (x == null ? null : typeof x === "string" ? x : x.id);
  const base = disputes.map((d) => {
    const ch = typeof d.charge === "string" ? null : d.charge;
    return {
      d,
      chargeId: idOf(d.charge),
      chargedAt: ch ? new Date(ch.created * 1000).toISOString() : null,
      pi: idOf(d.payment_intent),
      customer: ch ? idOf(ch.customer as string | Stripe.Customer | Stripe.DeletedCustomer | null) : null,
    };
  });

  const sb = makeServerClient();
  const pis = [...new Set(base.map((b) => b.pi).filter((x): x is string => !!x))];
  const invByPi = new Map<string, { md_user_id: number | null; md_membership_id: number | null }>();
  if (pis.length) {
    const { data, error } = await sb.from("stripe_member_invoices").select("payment_intent_id, md_user_id, md_membership_id").in("payment_intent_id", pis);
    if (error) throw new Error(`stripe_member_invoices read failed: ${error.message}`);
    for (const r of data ?? []) invByPi.set(r.payment_intent_id as string, { md_user_id: r.md_user_id as number | null, md_membership_id: r.md_membership_id as number | null });
  }
  const custs = [...new Set(base.filter((b) => !(b.pi && invByPi.get(b.pi)?.md_user_id)).map((b) => b.customer).filter((x): x is string => !!x))];
  const userByCust = new Map<string, number>();
  if (custs.length) {
    const { data, error } = await sb.from("stripe_customers").select("customer_id, md_user_id").in("customer_id", custs);
    if (error) throw new Error(`stripe_customers read failed: ${error.message}`);
    for (const r of data ?? []) if (r.md_user_id != null) userByCust.set(r.customer_id as string, Number(r.md_user_id));
  }

  const userIds = new Set<number>();
  for (const b of base) {
    const inv = b.pi ? invByPi.get(b.pi) : undefined;
    const u = inv?.md_user_id ?? (b.customer ? userByCust.get(b.customer) : undefined);
    if (u != null) userIds.add(Number(u));
  }
  const users = await readUsers([...userIds]);

  const rows: DisputeRow[] = base.map(({ d, chargeId, chargedAt, pi, customer }) => {
    const inv = pi ? invByPi.get(pi) : undefined;
    let member: DisputeMember | null = null;
    if (inv?.md_user_id != null) {
      const u = users.get(Number(inv.md_user_id));
      member = { userId: Number(inv.md_user_id), name: u?.name ?? null, city: u?.city ?? null, membershipId: inv.md_membership_id ?? null, via: "invoice" };
    } else if (customer && userByCust.has(customer)) {
      const id = userByCust.get(customer)!;
      const u = users.get(id);
      member = { userId: id, name: u?.name ?? null, city: u?.city ?? null, membershipId: null, via: "customer" };
    }
    return {
      id: d.id, status: d.status, bucket: bucketOf(d.status), amountCents: d.amount, currency: d.currency, reason: d.reason,
      createdAt: new Date(d.created * 1000).toISOString(),
      dueBy: d.evidence_details?.due_by ? new Date(d.evidence_details.due_by * 1000).toISOString() : null,
      pastDue: !!d.evidence_details?.past_due, hasEvidence: !!d.evidence_details?.has_evidence,
      chargeId, chargedAt, paymentIntentId: pi, customerId: customer, member,
      isMembershipCharge: !!inv,
    };
  });
  return { rows, readAt: new Date().toISOString() };
}

async function readUsers(ids: number[]): Promise<Map<number, { name: string | null; city: string | null }>> {
  const out = new Map<number, { name: string | null; city: string | null }>();
  if (!ids.length) return out;
  const { data, error } = await makeServerClient().from("mdapi_users").select("id, first_name, last_name, preferable_city_name").in("id", ids);
  if (error) throw new Error(`mdapi_users read failed: ${error.message}`);
  for (const r of data ?? []) {
    const name = [r.first_name, r.last_name].filter(Boolean).join(" ").trim() || null;
    out.set(Number(r.id), { name, city: (r.preferable_city_name as string | null) ?? null });
  }
  return out;
}

// ── One dispute's evidence ───────────────────────────────────────────────────────────────────────
type BackendEvidence = {
  user: { id: number; stripeCustomerId: string | null; deleted: boolean };
  memberships: { userSubscriptionId: number; stripeSubscriptionId: string | null; createdAt: string; canceledAt: string | null; cancelReason: string | null }[];
  termsAcceptances: (TermsAcceptance & { userSubscriptionId: number })[];
  cancelConfirmations: (CancelConfirmation & { userSubscriptionId: number })[];
};

const detailCache = new Map<string, { at: number; value: { row: DisputeRow; evidence: DisputeEvidence | null } }>();
const detailFlight = new Map<string, Promise<{ row: DisputeRow; evidence: DisputeEvidence | null }>>();

export async function disputeDetail(id: string): Promise<{ row: DisputeRow; evidence: DisputeEvidence | null } | null> {
  const { rows } = await listDisputes();
  const listed = rows.find((r) => r.id === id);
  if (!listed) return null;
  const hit = detailCache.get(id);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const inFlight = detailFlight.get(id);
  if (inFlight) return inFlight;
  const p = (async () => {
    try {
      const value = await readDetail({ ...listed });
      detailCache.set(id, { at: Date.now(), value });
      return value;
    } finally { detailFlight.delete(id); }
  })();
  detailFlight.set(id, p);
  return p;
}

async function readDetail(row: DisputeRow): Promise<{ row: DisputeRow; evidence: DisputeEvidence | null }> {
  const sb = makeServerClient();
  // The disputed charge's invoice row: subscription, billing reason, invoice id (for the period).
  type InvRow = { invoice_id: string; subscription_id: string | null; md_membership_id: number | null; billing_reason: string | null; paid_at_utc: string | null };
  let inv: InvRow | null = null;
  if (row.paymentIntentId) {
    const { data } = await sb.from("stripe_member_invoices")
      .select("invoice_id, subscription_id, md_membership_id, billing_reason, paid_at_utc")
      .eq("payment_intent_id", row.paymentIntentId).limit(1);
    inv = (data?.[0] as InvRow | undefined) ?? null;
  }

  // Backend evidence: by player when matched, else by the charge's Stripe customer. One request, no retries.
  let backend: BackendEvidence | null = null;
  let backendNote: string | null = null;
  const query: Record<string, string | number> | null = row.member ? { userId: row.member.userId }
    : row.customerId ? { stripeCustomerId: row.customerId } : null;
  if (query) {
    try {
      backend = await getMatchdayApiClient().get<BackendEvidence>("/admin/membership-evidence", query, { maxRetries: 0 });
    } catch (e) {
      const status = e instanceof MatchdayApiError ? e.status : null;
      backendNote = status === 404 ? "The backend found no player for this charge."
        : status === 409 ? "More than one player shares this Stripe customer, so the backend would not pick one."
        : `The backend evidence could not be read${status ? ` (HTTP ${status})` : ""}.`;
    }
  }
  if (!row.member && backend) {
    const users = await readUsers([backend.user.id]);
    const u = users.get(backend.user.id);
    row.member = { userId: backend.user.id, name: u?.name ?? null, city: u?.city ?? null, membershipId: null, via: "backend" };
  }
  if (!row.member) return { row, evidence: null };
  if (!row.isMembershipCharge) return { row, evidence: null };

  const membershipId = inv?.md_membership_id ?? row.member.membershipId
    ?? backend?.memberships.find((m) => inv?.subscription_id && m.stripeSubscriptionId === inv.subscription_id)?.userSubscriptionId ?? null;
  const bm = backend?.memberships.find((m) => m.userSubscriptionId === membershipId) ?? null;
  let membership: DisputeEvidence["membership"] = bm
    ? { id: bm.userSubscriptionId, joinedAt: bm.createdAt, canceledAt: bm.canceledAt, cancelReason: bm.cancelReason }
    : null;
  if (!membership && membershipId != null) {
    const { data } = await sb.from("mdapi_subscriptions").select("membership_id, activation_date, canceled_at, cancel_reason").eq("membership_id", membershipId).limit(1);
    const r = data?.[0];
    if (r) membership = { id: Number(r.membership_id), joinedAt: (r.activation_date as string | null) ?? null, canceledAt: (r.canceled_at as string | null) ?? null, cancelReason: (r.cancel_reason as string | null) ?? null };
  }
  const terms = backend?.termsAcceptances.find((t) => t.userSubscriptionId === membershipId) ?? null;
  // The newest confirmation for this membership made before the charge, else the newest at all.
  const ccs = (backend?.cancelConfirmations ?? []).filter((c) => c.userSubscriptionId === membershipId);
  const cancel = ccs.find((c) => row.chargedAt && c.confirmedAt < row.chargedAt) ?? ccs[0] ?? null;

  // The period the charge paid for: the invoice's subscription line (one Stripe read, this dispute only).
  let period: DisputeEvidence["period"] = null;
  if (inv?.invoice_id) {
    try {
      const invoice = await getStripe().invoices.retrieve(inv.invoice_id, {}, { maxNetworkRetries: 0 });
      const line = invoice.lines?.data?.find((l) => l.period?.start && l.period?.end) ?? null;
      if (line) period = { start: new Date(line.period.start * 1000).toISOString(), end: new Date(line.period.end * 1000).toISOString(), source: "stripe-invoice" };
    } catch { /* period stays unknown and the checklist says so */ }
  }

  const [periodMatches, priorPaidCharges, refundsOnCharge, chats] = await Promise.all([
    period ? readPeriodMatches(row.member.userId, period) : Promise.resolve(null),
    inv?.subscription_id ? (async () => {
      const { count, error } = await sb.from("stripe_member_invoices").select("invoice_id", { count: "exact", head: true })
        .eq("subscription_id", inv!.subscription_id!).eq("status", "paid").lt("paid_at_utc", inv!.paid_at_utc ?? row.chargedAt ?? new Date().toISOString());
      return error ? null : count ?? 0;
    })() : Promise.resolve(null),
    row.chargeId ? (async () => {
      const { data, error } = await sb.from("fin_txn").select("gross_cents").eq("kind", "refund").eq("charge_id", row.chargeId!);
      return error ? null : (data ?? []).reduce((s, r) => s + Math.abs(Number(r.gross_cents) || 0), 0);
    })() : Promise.resolve(null),
    (async (): Promise<ChatSummary[] | null> => {
      const { data, error } = await sb.from("crm_threads").select("channel, created_at, last_message_at").eq("player_id", row.member!.userId);
      return error ? null : (data ?? []).map((t) => ({ channel: (t.channel as string | null) ?? null, createdAt: t.created_at as string, lastMessageAt: (t.last_message_at as string | null) ?? null }));
    })(),
  ]);

  const names = await sb.from("mdapi_users").select("first_name, last_name").eq("id", row.member.userId).limit(1);
  const n = names.data?.[0];
  return {
    row,
    evidence: {
      backendNote, membership, terms, cancel, period, billingReason: inv?.billing_reason ?? null,
      periodMatches, priorPaidCharges, refundsOnCharge, chats,
      customerName: n ? [n.first_name, n.last_name].filter(Boolean).join(" ") || null : null,
    },
  };
}

/** Bookings that held a spot (not cancelled, not an unsettled WAITING checkout) in the charged period. */
async function readPeriodMatches(userId: number, period: { start: string; end: string }): Promise<PeriodMatch[] | null> {
  const sb = makeServerClient();
  const { data: mp, error } = await sb.from("mdapi_match_players")
    .select("match_api_id, paid_status, user_status, is_cancelled, is_absent, deleted_at")
    .eq("user_id", userId).eq("is_cancelled", false).is("deleted_at", null).neq("paid_status", "WAITING").limit(2000);
  if (error) return null;
  const byMatch = new Map<number, { user_status: string | null; is_absent: boolean | null }>();
  for (const r of mp ?? []) byMatch.set(Number(r.match_api_id), { user_status: (r.user_status as string | null) ?? null, is_absent: (r.is_absent as boolean | null) ?? null });
  if (!byMatch.size) return [];
  const { data: ms, error: e2 } = await sb.from("mdapi_matches")
    .select("api_id, start_date_utc, field_title, city_name, is_cancelled")
    .in("api_id", [...byMatch.keys()]).gte("start_date_utc", period.start).lt("start_date_utc", period.end).eq("is_cancelled", false);
  if (e2) return null;
  return (ms ?? [])
    .map((m) => {
      const p = byMatch.get(Number(m.api_id))!;
      const status = p.user_status;
      return { startUtc: m.start_date_utc as string, field: (m.field_title as string | null) ?? null, city: (m.city_name as string | null) ?? null,
        checkedIn: status === "ON_TIME" || status === "LATE", status };
    })
    .sort((a, b) => a.startUtc.localeCompare(b.startUtc));
}

/** A change_log row for a view or a copy: who and which dispute. Never the evidence, never an IP. */
export async function logDisputeEvent(kind: "VIEW" | "COPY", disputeId: string, email: string): Promise<boolean> {
  const { error } = await makeServerClient().from("change_log").insert({
    save_id: crypto.randomUUID(), actor_name: email, actor_email: email, source: "Disputes", env: "production",
    match_id: null, match_name: null, method: kind, endpoint: `stripe:disputes/${disputeId}`,
    request_body: { disputeId, action: kind === "VIEW" ? "viewed dispute" : "copied evidence" }, outcome: "landed",
    server_said: null, changes: [],
  });
  return !error;
}
