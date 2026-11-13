import "server-only";
/* THE MEMBERS PAGE'S READS. Server only. Every decision lives in membersPageModel.ts; this file
 * only fetches and normalises.
 *
 * PRODUCTION reads OUR MIRROR, mdapi_subscriptions — never MatchDay's list endpoint — so a page load,
 * a tab switch and a keystroke in search cost the production API nothing. How fresh the mirror is
 * travels with every response (`syncedAt`).
 *
 * STAGING has no mirror, so it walks GET /admin/subscriptions on the STAGING API, one city and one
 * status at a time. Only fixed values are sent: a city code from CITY_SCOPES, a status from a fixed
 * list, sortColumn "membershipId". NEVER `email`: that parameter is pasted into raw SQL by the
 * backend (subscriptions.repository.ts:53-54), and search happens in memory instead. */

import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { selectAll } from "./supabasePagination";
import { apiGet, type MatchdayEnv } from "./matchdayStageApi";
import { CITY_SCOPES } from "./cityScope";
import { getStripe } from "./stripePayments";
import type { MemberRow, RowStripe } from "./membersPageModel";

const num = (v: unknown): number | null => { const n = Number(v); return v != null && v !== "" && Number.isFinite(n) ? n : null; };
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

/* ── ROWS ──────────────────────────────────────────────────────────────────────────────────── */

type MirrorRow = {
  membership_id: number; user_id: number; city_identifier: string | null; city_member_slug: string | null;
  member_email: string | null; first_name: string | null; last_name: string | null; phone_number: string | null;
  status: string | null; price: number | null; activation_date: string | null; canceled_at: string | null;
  cancel_reason: string | null; comment: string | null; suspended_to: string | null;
  strike_points: number | null; absent_owed: number | null; synced_at: string | null;
};
const MIRROR_COLS = "membership_id,user_id,city_identifier,city_member_slug,member_email,first_name,last_name,phone_number,status,price,activation_date,canceled_at,cancel_reason,comment,suspended_to,strike_points,absent_owed,synced_at";

export function rowFromMirror(r: MirrorRow): MemberRow {
  return {
    membershipId: Number(r.membership_id), userId: Number(r.user_id), city: r.city_identifier ?? "",
    slug: r.city_member_slug, firstName: r.first_name, lastName: r.last_name, email: r.member_email,
    phone: r.phone_number, status: r.status ?? "", priceDollars: num(r.price),
    activationDate: r.activation_date, canceledAt: r.canceled_at, cancelReason: r.cancel_reason,
    comment: r.comment, suspendedTo: r.suspended_to, strikePoints: num(r.strike_points) ?? 0,
    absentOwed: num(r.absent_owed) ?? 0,
  };
}

/** The list endpoint's own row shape (the same one the mirror is built from). */
export function rowFromApi(r: Record<string, unknown>, city: string): MemberRow | null {
  const id = num(r.membershipId), user = num(r.userId);
  if (id == null || user == null) return null;
  return {
    membershipId: id, userId: user, city, slug: str(r.cityIdentifierAndMemberId),
    firstName: str(r.firstName), lastName: str(r.lastName), email: str(r.memberEmail), phone: str(r.phoneNumber),
    status: str(r.status) ?? "", priceDollars: num(r.price), activationDate: str(r.activationDate),
    canceledAt: str(r.canceledAt), cancelReason: str(r.cancelReason), comment: str(r.comment),
    suspendedTo: str(r.suspendedTo), strikePoints: num(r.strikePoints) ?? 0, absentOwed: num(r.absentOwed) ?? 0,
  };
}

const CACHE_MS = 30_000;
const cache = new Map<string, { at: number; rows: MemberRow[]; syncedAt: string | null }>();

export async function loadMemberRows(env: MatchdayEnv, sb: SupabaseClient, fresh = false): Promise<{ rows: MemberRow[]; syncedAt: string | null; source: "mirror" | "staging-api" }> {
  const hit = cache.get(env);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return { rows: hit.rows, syncedAt: hit.syncedAt, source: env === "production" ? "mirror" : "staging-api" };
  let rows: MemberRow[]; let syncedAt: string | null = null;
  if (env === "production") {
    const raw = await selectAll<MirrorRow>(() => sb.from("mdapi_subscriptions").select(MIRROR_COLS).order("membership_id"));
    rows = raw.map(rowFromMirror);
    for (const r of raw) if (r.synced_at && (!syncedAt || r.synced_at > syncedAt)) syncedAt = r.synced_at;
  } else {
    rows = await walkStagingList(env);
    syncedAt = new Date().toISOString();
  }
  cache.set(env, { at: Date.now(), rows, syncedAt });
  return { rows, syncedAt, source: env === "production" ? "mirror" : "staging-api" };
}
/** After a write lands, the next read must not serve the old row. */
export const dropMemberCache = (env: MatchdayEnv) => { cache.delete(env); };

const STAGING_STATUSES = ["ACTIVE", "CANCELED"] as const; // ACTIVE admits ADDED_FROM_ADMIN; CANCELED admits PAST_DUE (repository :56-61)
const STAGING_LIMIT = 100;
const STAGING_MAX_PAGES = 30;

async function walkStagingList(env: MatchdayEnv): Promise<MemberRow[]> {
  const byId = new Map<number, MemberRow>();
  for (const c of CITY_SCOPES) {
    for (const status of STAGING_STATUSES) {
      for (let page = 1; page <= STAGING_MAX_PAGES; page++) {
        const res = await apiGet<{ data?: Record<string, unknown>[] }>(env, "/admin/subscriptions", {
          status, cityIdentifier: c.identifier, page, limit: STAGING_LIMIT, sortColumn: "membershipId", sortDirection: "asc",
        });
        const data = Array.isArray(res?.data) ? res.data : [];
        for (const d of data) { const r = rowFromApi(d, c.identifier); if (r) byId.set(r.membershipId, r); }
        // totalItems is unreliable on this endpoint (mdapiSubscriptionsSync); a short page ends it.
        if (data.length < STAGING_LIMIT) break;
      }
    }
  }
  return [...byId.values()];
}

/* ── STRIPE FACTS FROM OUR TABLES ─────────────────────────────────────────────────────────────
 * mdapi_subscription_stripe_end (0261, + 0272's three columns) and stripe_member_unpaid_invoices
 * (0262). Production only — staging memberships are not in either table. */
const chunks = <T,>(a: readonly T[], n: number): T[][] => { const o: T[][] = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

export async function loadRowStripe(sb: SupabaseClient, env: MatchdayEnv, ids: readonly number[]): Promise<Map<number, RowStripe>> {
  const out = new Map<number, RowStripe>();
  if (env !== "production" || !ids.length) return out;
  for (const part of chunks([...new Set(ids)], 200)) {
    const [ends, unpaid] = await Promise.all([
      sb.from("mdapi_subscription_stripe_end")
        .select("membership_id,stripe_status,stripe_ended_at,stripe_cancel_at,stripe_cancel_at_period_end,stripe_current_period_end,fetched_at")
        .in("membership_id", part),
      sb.from("stripe_member_unpaid_invoices")
        .select("md_membership_id,status,amount_due_cents,created_at_utc,next_payment_attempt_utc")
        .in("md_membership_id", part).eq("status", "open").order("created_at_utc", { ascending: false }),
    ]);
    if (ends.error) throw new Error(`mdapi_subscription_stripe_end: ${ends.error.message}`);
    if (unpaid.error) throw new Error(`stripe_member_unpaid_invoices: ${unpaid.error.message}`);
    for (const e of ends.data ?? []) {
      out.set(Number(e.membership_id), {
        ...(out.get(Number(e.membership_id)) ?? {}),
        endStatus: e.stripe_status, endedAt: e.stripe_ended_at, cancelAt: e.stripe_cancel_at,
        cancelAtPeriodEnd: e.stripe_cancel_at_period_end, currentPeriodEnd: e.stripe_current_period_end, endReadAt: e.fetched_at,
      });
    }
    for (const u of unpaid.data ?? []) {
      const k = Number(u.md_membership_id), cur = out.get(k) ?? {};
      if (cur.failedAt) continue; // newest first; keep the newest
      out.set(k, { ...cur, failedAt: u.created_at_utc, failedAmountCents: num(u.amount_due_cents), nextRetryAt: u.next_payment_attempt_utc });
    }
  }
  return out;
}

/* ── CITY SETTINGS, READ LIVE ─────────────────────────────────────────────────────────────────
 * Two single reads per city pick, both proven on production 2026-11-13 with the service account:
 * GET /admin/subscriptions/cities/ATX → { price 6650, stripePriceId, taxRate 8.25 } and
 * GET /strikes/cities/ATX → { amount 2000, city }. */
export type CitySettings = {
  city: string;
  planCents: number | null; planStripePriceId: string | null; taxRatePct: number | null; planUpdatedAt: string | null;
  fineCents: number | null; fineUpdatedAt: string | null;
  errors: string[];
};
export async function readCitySettings(env: MatchdayEnv, city: string): Promise<CitySettings> {
  const out: CitySettings = { city, planCents: null, planStripePriceId: null, taxRatePct: null, planUpdatedAt: null, fineCents: null, fineUpdatedAt: null, errors: [] };
  const [plan, fine] = await Promise.allSettled([
    apiGet<Record<string, unknown>>(env, `/admin/subscriptions/cities/${encodeURIComponent(city)}`),
    apiGet<Record<string, unknown>>(env, `/strikes/cities/${encodeURIComponent(city)}`),
  ]);
  if (plan.status === "fulfilled") {
    out.planCents = num(plan.value?.price); out.planStripePriceId = str(plan.value?.stripePriceId);
    out.taxRatePct = num(plan.value?.taxRate); out.planUpdatedAt = str(plan.value?.updatedAt);
  } else out.errors.push(`member price: ${plan.reason instanceof Error ? plan.reason.message.slice(0, 160) : "unreadable"}`);
  if (fine.status === "fulfilled") {
    out.fineCents = num(fine.value?.amount); out.fineUpdatedAt = str(fine.value?.updatedAt);
  } else out.errors.push(`strike fine: ${fine.reason instanceof Error ? fine.reason.message.slice(0, 160) : "unreadable"}`);
  return out;
}

/* ── ONE STRIPE SUBSCRIPTION, READ FOR THE PANEL ──────────────────────────────────────────────
 * GET only. Whether Stripe is scheduled to end it, when, and the card on it. In this Stripe API
 * version the period lives on the item (stripe v22 SubscriptionItems.d.ts:50). */
export type StripeMemberRead = {
  found: boolean; status: string | null; cancelAtPeriodEnd: boolean | null; cancelAt: string | null;
  currentPeriodEnd: string | null; unitAmount: number | null; card: string | null; error: string | null;
};
const iso = (s: unknown) => (typeof s === "number" ? new Date(s * 1000).toISOString() : null);
export async function readStripeMember(subId: string | null): Promise<StripeMemberRead> {
  const miss: StripeMemberRead = { found: false, status: null, cancelAtPeriodEnd: null, cancelAt: null, currentPeriodEnd: null, unitAmount: null, card: null, error: null };
  const id = (subId ?? "").trim();
  if (!id) return miss;
  let stripe: Stripe;
  try { stripe = getStripe(); } catch (e) { return { ...miss, error: e instanceof Error ? e.message : "Stripe is not configured" }; }
  try {
    const sub = await stripe.subscriptions.retrieve(id, { expand: ["default_payment_method"] });
    const item = sub.items?.data?.[0] as (Stripe.SubscriptionItem & { current_period_end?: number }) | undefined;
    const pm = sub.default_payment_method && typeof sub.default_payment_method === "object" ? sub.default_payment_method : null;
    const card = pm?.card ? `${cap(pm.card.brand)} •••• ${pm.card.last4}` : null;
    return {
      found: true, status: sub.status ?? null, cancelAtPeriodEnd: sub.cancel_at_period_end === true,
      cancelAt: iso(sub.cancel_at), currentPeriodEnd: iso(item?.current_period_end),
      unitAmount: typeof item?.price?.unit_amount === "number" ? item.price.unit_amount : null, card, error: null,
    };
  } catch (e) {
    if ((e as { code?: string })?.code === "resource_missing") return miss;
    return { ...miss, error: e instanceof Error ? e.message.slice(0, 200) : "Stripe request failed" };
  }
}
const cap = (s: string | null | undefined) => (s ? s[0].toUpperCase() + s.slice(1) : "Card");

/** The Stripe subscription id behind a membership, from our own paid invoices (the route the
 *  0261 backfill proved: 2,604 of 2,619 CANCELED memberships carry one). Newest invoice wins. */
export async function stripeSubIdFor(sb: SupabaseClient, membershipId: number): Promise<{ subId: string | null; lastPaid: { cents: number; at: string } | null }> {
  const { data, error } = await sb.from("stripe_member_invoices")
    .select("subscription_id,amount_paid_cents,paid_at_utc,created_at_utc,status")
    .eq("md_membership_id", membershipId).order("created_at_utc", { ascending: false }).limit(12);
  if (error) throw new Error(`stripe_member_invoices: ${error.message}`);
  const rows = data ?? [];
  const subId = rows.find((r) => r.subscription_id)?.subscription_id ?? null;
  const paid = rows.find((r) => (r.status ?? "paid") === "paid" && Number(r.amount_paid_cents) > 0);
  return { subId, lastPaid: paid ? { cents: Number(paid.amount_paid_cents), at: paid.paid_at_utc ?? paid.created_at_utc } : null };
}

/** Who last saved this membership's comment, and when — read from our change log, never from
 *  MatchDay (which keeps no author). Only a LANDED write counts. */
export async function commentMeta(sb: SupabaseClient, env: MatchdayEnv, membershipId: number): Promise<{ by: string | null; at: string | null }> {
  const { data } = await sb.from("change_log").select("actor_name,actor_email,created_at,outcome")
    .eq("env", env).eq("endpoint", `/api/v1/admin/user-subscriptions/${membershipId}`).eq("outcome", "landed")
    .order("created_at", { ascending: false }).limit(1);
  const r = data?.[0];
  return r ? { by: (r.actor_name as string) || (r.actor_email as string) || null, at: r.created_at as string } : { by: null, at: null };
}
