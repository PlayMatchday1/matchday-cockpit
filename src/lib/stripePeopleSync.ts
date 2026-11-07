/* WHO PAID: Stripe customers and paid membership invoices, tied to MatchDay people (migration 0236).
 * SERVER-ONLY. Every Stripe call here is a GET; every write is to the two service-role-only tables
 * or to fin_txn.customer_id.
 *
 * ── THE TWO KEYS (Ryan, 2026-10-27) ─────────────────────────────────────────────────────────────
 *   customer   MatchDay sets metadata.userId when it creates a Stripe customer (backend
 *              apps/api/src/core/stripe/stripe.service.ts:144-149), so a customer is a player.
 *   invoice    A membership invoice carries its subscription's metadata: userId and
 *              userSubscriptionId (= mdapi_subscriptions.membership_id). Its payment's payment
 *              intent joins fin_txn.payment_intent_id, so each membership charge in fin_txn finds
 *              its member and its membership.
 *
 * ── THREE JOBS, EACH ONE WINDOW ─────────────────────────────────────────────────────────────────
 *   customers   customers.list by creation date, then any customer fin_txn names that the list did
 *               not return (deleted customers are not listed) is read one by one.
 *   invoices    paid invoices by creation date, subscription invoices only.
 *   charges     fin_txn.customer_id for rows synced before 0236: charges.list by creation date and
 *               the customer copied onto every fin_txn row with that charge_id (its refunds and
 *               disputes carry the same charge_id, so they are filled too). Only empty cells are set.
 *
 * NOTHING HERE IS LOGGED ROW BY ROW. A row holds an email; the sync log and change_log get counts. */

import "server-only";
import Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readWithBackoff } from "./finTxnSync";

export type Window = { since: Date; until: Date };
export type PeopleJob = "customers" | "invoices" | "charges" | "unpaid";
export type PeopleSyncResult = {
  job: PeopleJob; fetched: number; written: number;
  /** customers: deleted customers read one by one. charges: fin_txn rows given a customer. */
  extra: number;
  sinceIso: string; untilIso: string;
};

const created = (w: Window) => ({ gte: Math.floor(w.since.getTime() / 1000), lt: Math.floor(w.until.getTime() / 1000) });
const iso = (s: number | null | undefined) => (s == null ? null : new Date(s * 1000).toISOString());
const idOf = (x: string | { id: string } | null | undefined) => (x == null ? null : typeof x === "string" ? x : x.id);
/** A metadata id as a positive integer, or null. MatchDay writes them as strings. */
const intOf = (v: unknown): number | null => {
  const n = Number(String(v ?? "").trim());
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

/** Hand paging so each page can wait out a rate limit (readWithBackoff), as finTxnSync does. */
async function listAll<T extends { id: string }>(page: (after?: string) => Promise<Stripe.ApiList<T>>): Promise<T[]> {
  const all: T[] = [];
  for (let after: string | undefined; ;) {
    const p = await readWithBackoff(() => page(after));
    all.push(...p.data);
    if (!p.has_more || p.data.length === 0) break;
    after = p.data[p.data.length - 1].id;
  }
  return all;
}

async function upsert(sb: SupabaseClient, table: string, key: string, rows: Record<string, unknown>[]) {
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await sb.from(table).upsert(rows.slice(i, i + 500), { onConflict: key });
    if (error) throw new Error(`${table} upsert failed: ${error.message}`);
  }
}

const customerRow = (c: Stripe.Customer | Stripe.DeletedCustomer, at: string) =>
  "deleted" in c && c.deleted
    ? { customer_id: c.id, email: null, md_user_id: null, deleted: true, created_at_utc: null, synced_at: at }
    : {
        customer_id: c.id,
        email: (c as Stripe.Customer).email?.trim() || null,
        md_user_id: intOf((c as Stripe.Customer).metadata?.userId),
        deleted: false,
        created_at_utc: iso((c as Stripe.Customer).created),
        synced_at: at,
      };

export async function syncStripeCustomers(sb: SupabaseClient, stripe: Stripe, w: Window): Promise<PeopleSyncResult> {
  const at = new Date().toISOString();
  const listed = await listAll<Stripe.Customer>((after) => stripe.customers.list({
    created: created(w), limit: 100, ...(after ? { starting_after: after } : {}),
  }));
  await upsert(sb, "stripe_customers", "customer_id", listed.map((c) => customerRow(c, at)));

  /* CUSTOMERS FIN_TXN NAMES IN THIS WINDOW THAT WE DO NOT HOLD: deleted customers never appear in
   * customers.list, and an older customer can pay in a newer month. Read one by one, 3 at a time. */
  const named = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("fin_txn").select("customer_id")
      .not("customer_id", "is", null).gte("created_at_utc", w.since.toISOString()).lt("created_at_utc", w.until.toISOString())
      .order("id").range(from, from + 999);
    if (error) throw new Error(`fin_txn read failed: ${error.message}`);
    for (const r of data ?? []) named.add(String(r.customer_id));
    if ((data ?? []).length < 1000) break;
  }
  const held = new Set<string>();
  const ids = [...named];
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await sb.from("stripe_customers").select("customer_id").in("customer_id", ids.slice(i, i + 200));
    if (error) throw new Error(`stripe_customers read failed: ${error.message}`);
    for (const r of data ?? []) held.add(String(r.customer_id));
  }
  const queue = ids.filter((id) => !held.has(id));
  const extra: Record<string, unknown>[] = [];
  await Promise.all(Array.from({ length: 3 }, async () => {
    for (let id = queue.pop(); id; id = queue.pop()) {
      const c = await readWithBackoff(() => stripe.customers.retrieve(id));
      extra.push(customerRow(c, at));
    }
  }));
  await upsert(sb, "stripe_customers", "customer_id", extra);
  return { job: "customers", fetched: listed.length, written: listed.length + extra.length, extra: extra.length,
    sinceIso: w.since.toISOString(), untilIso: w.until.toISOString() };
}

/** The paid-invoice row (0236), plus attempt_count (0262): 1 = paid first time, N > 1 = N-1 failures first. */
function memberInvoiceRow(inv: Stripe.Invoice, at: string): Record<string, unknown> | null {
  const sd = inv.parent?.subscription_details;
  if (!sd) return null;   // not a subscription invoice
  // The payment that settled it: the first PAID payment, else the first one listed.
  const pays = inv.payments?.data ?? [];
  const pay = pays.find((p) => p.status === "paid") ?? pays[0];
  return {
    invoice_id: inv.id,
    customer_id: idOf(inv.customer as string | { id: string } | null),
    subscription_id: idOf(sd.subscription as string | { id: string }),
    md_user_id: intOf(sd.metadata?.userId),
    md_membership_id: intOf(sd.metadata?.userSubscriptionId),
    payment_intent_id: idOf(pay?.payment?.payment_intent as string | { id: string } | null | undefined),
    charge_id: idOf(pay?.payment?.charge as string | { id: string } | null | undefined),
    amount_paid_cents: inv.amount_paid,
    status: inv.status,
    billing_reason: inv.billing_reason,
    created_at_utc: iso(inv.created),
    paid_at_utc: iso(inv.status_transitions?.paid_at),
    attempt_count: typeof inv.attempt_count === "number" ? inv.attempt_count : null,
    synced_at: at,
  };
}

export async function syncMemberInvoices(sb: SupabaseClient, stripe: Stripe, w: Window): Promise<PeopleSyncResult> {
  const at = new Date().toISOString();
  const all = await listAll<Stripe.Invoice>((after) => stripe.invoices.list({
    created: created(w), status: "paid", limit: 100, expand: ["data.payments"],
    ...(after ? { starting_after: after } : {}),
  }));
  const rows = all.map((inv) => memberInvoiceRow(inv, at)).filter((r): r is Record<string, unknown> => r != null);
  await upsert(sb, "stripe_member_invoices", "invoice_id", rows);
  return { job: "invoices", fetched: all.length, written: rows.length, extra: all.length - rows.length,
    sinceIso: w.since.toISOString(), untilIso: w.until.toISOString() };
}

/* ── UNPAID MEMBERSHIP INVOICES (0262) ─────────────────────────────────────────────────────────
 * What stripe_member_invoices cannot hold: renewals Stripe has not been paid for.
 *   open           open invoices created since `openSince` (hourly: the last 45 days, which covers
 *                  Stripe's retry schedule; a month backfill: that month). NOT unbounded: listing every
 *                  open invoice in the account timed out the hourly route three runs in a row on
 *                  2026-11-07 (Vercel "Task timed out after 300 seconds", 0 rows written).
 *   uncollectible  in the window (Stripe gave up)
 *   void           in the window (cancelled before it was paid)
 * The last failure's code comes from the invoice's payment intent (last_payment_error), read only for
 * an invoice that has been attempted and whose attempt count moved since we last read it, at one GET
 * every 250 ms, up to PI_BUDGET a run and never past the run's deadline; the rest keep what they had
 * and are read next run. The listed rows are WRITTEN FIRST, so a run cut short still lands its rows.
 *
 * RECONCILE. A row we hold as open that Stripe no longer lists as open is read back: PAID moves to
 * stripe_member_invoices (with its attempt_count) and leaves this table; anything else is updated.
 * This also catches a retried renewal paid after the hourly paid sync's 3-day created window. */
const PI_GAP_MS = 250;
const PI_BUDGET = 150;
const RECONCILE_BUDGET = 100;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Failure = { code: string | null; message: string | null };

function unpaidRow(inv: Stripe.Invoice, at: string, failure: Failure | null): Record<string, unknown> | null {
  const sd = inv.parent?.subscription_details;
  if (!sd) return null;
  if (inv.status !== "open" && inv.status !== "uncollectible" && inv.status !== "void") return null;
  const pays = inv.payments?.data ?? [];
  const pay = pays[0];
  return {
    invoice_id: inv.id,
    customer_id: idOf(inv.customer as string | { id: string } | null),
    subscription_id: idOf(sd.subscription as string | { id: string }),
    md_user_id: intOf(sd.metadata?.userId),
    md_membership_id: intOf(sd.metadata?.userSubscriptionId),
    payment_intent_id: idOf(pay?.payment?.payment_intent as string | { id: string } | null | undefined),
    amount_due_cents: inv.amount_due,
    status: inv.status,
    billing_reason: inv.billing_reason,
    attempt_count: typeof inv.attempt_count === "number" ? inv.attempt_count : null,
    next_payment_attempt_utc: iso(inv.next_payment_attempt),
    last_failure_code: failure?.code ?? null,
    last_failure_message: failure?.message ?? null,
    created_at_utc: iso(inv.created),
    synced_at: at,
  };
}

export async function syncUnpaidInvoices(sb: SupabaseClient, stripe: Stripe, w: Window,
  opts: { openSince?: Date; budgetMs?: number } = {}): Promise<PeopleSyncResult> {
  const at = new Date().toISOString();
  const deadline = Date.now() + (opts.budgetMs ?? 200_000);
  const openW: Window = { since: opts.openSince ?? w.since, until: w.until };
  const list = (status: "open" | "uncollectible" | "void", win: Window) => listAll<Stripe.Invoice>((after) => stripe.invoices.list({
    status, limit: 100, expand: ["data.payments"], created: created(win),
    ...(after ? { starting_after: after } : {}),
  }));
  const open = await list("open", openW);
  const listed = [...open, ...await list("uncollectible", w), ...await list("void", w)]
    .filter((inv) => inv.parent?.subscription_details);
  const ids = listed.map((i) => i.id);

  // What we hold already: failure fields to keep, and attempt counts to compare.
  const held = new Map<string, { attempt_count: number | null; last_failure_code: string | null; last_failure_message: string | null }>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await sb.from("stripe_member_unpaid_invoices").select("invoice_id,attempt_count,last_failure_code,last_failure_message").in("invoice_id", ids.slice(i, i + 200));
    if (error) throw new Error(`stripe_member_unpaid_invoices read failed: ${error.message}`);
    for (const r of data ?? []) held.set(String(r.invoice_id), r as never);
  }

  // 1. Every listed row, with the failure we already hold: lands even if the reads below are cut short.
  const keep = (inv: Stripe.Invoice): Failure | null => {
    const b = held.get(inv.id);
    return b ? { code: b.last_failure_code, message: b.last_failure_message } : null;
  };
  const rows = listed.map((inv) => unpaidRow(inv, at, keep(inv))).filter((r): r is Record<string, unknown> => r != null);
  await upsert(sb, "stripe_member_unpaid_invoices", "invoice_id", rows);

  // 2. The last failure for attempted invoices whose attempt count moved, paced, budgeted, deadlined.
  let piReads = 0;
  const updated: Record<string, unknown>[] = [];
  for (const inv of listed) {
    if (piReads >= PI_BUDGET || Date.now() > deadline) break;
    const before = held.get(inv.id);
    const pi = idOf(inv.payments?.data?.[0]?.payment?.payment_intent as string | { id: string } | null | undefined);
    const moved = !before || before.attempt_count !== (inv.attempt_count ?? null);
    if (!pi || (inv.attempt_count ?? 0) <= 0 || !moved) continue;
    if (piReads > 0) await pause(PI_GAP_MS);
    piReads++;
    const intent = await readWithBackoff(() => stripe.paymentIntents.retrieve(pi));
    const e = intent.last_payment_error;
    if (!e) continue;
    const row = unpaidRow(inv, at, { code: (e.decline_code ?? e.code ?? null) as string | null, message: e.message ? e.message.slice(0, 200) : null });
    if (row) updated.push(row);
    if (updated.length >= 25) await upsert(sb, "stripe_member_unpaid_invoices", "invoice_id", updated.splice(0));
  }
  await upsert(sb, "stripe_member_unpaid_invoices", "invoice_id", updated);

  // Reconcile rows we hold as open that Stripe no longer lists as open.
  const openNow = new Set(open.map((i) => i.id));
  // Only rows inside the open window: an older open row is outside what was listed, not evidence it moved.
  const { data: stale, error: staleErr } = await sb.from("stripe_member_unpaid_invoices").select("invoice_id").eq("status", "open")
    .gte("created_at_utc", openW.since.toISOString()).lt("created_at_utc", openW.until.toISOString()).limit(1000);
  if (staleErr) throw new Error(`stripe_member_unpaid_invoices read failed: ${staleErr.message}`);
  let movedToPaid = 0, reads = 0;
  for (const r of (stale ?? []).filter((x) => !openNow.has(String(x.invoice_id))).slice(0, RECONCILE_BUDGET)) {
    if (Date.now() > deadline) break;
    if (reads > 0) await pause(PI_GAP_MS);
    reads++;
    const inv = await readWithBackoff(() => stripe.invoices.retrieve(String(r.invoice_id), { expand: ["payments"] }));
    if (inv.status === "paid") {
      const paid = memberInvoiceRow(inv, at);
      if (paid) await upsert(sb, "stripe_member_invoices", "invoice_id", [paid]);
      const { error } = await sb.from("stripe_member_unpaid_invoices").delete().eq("invoice_id", inv.id);
      if (error) throw new Error(`stripe_member_unpaid_invoices delete failed: ${error.message}`);
      movedToPaid++;
    } else {
      const { data: keep } = await sb.from("stripe_member_unpaid_invoices").select("last_failure_code,last_failure_message").eq("invoice_id", inv.id).maybeSingle();
      const row = unpaidRow(inv, at, keep ? { code: keep.last_failure_code as string | null, message: keep.last_failure_message as string | null } : null);
      if (row) await upsert(sb, "stripe_member_unpaid_invoices", "invoice_id", [row]);
    }
  }
  return { job: "unpaid", fetched: listed.length, written: rows.length, extra: movedToPaid,
    sinceIso: w.since.toISOString(), untilIso: w.until.toISOString() };
}

export async function backfillChargeCustomers(sb: SupabaseClient, stripe: Stripe, w: Window): Promise<PeopleSyncResult> {
  const charges = await listAll<Stripe.Charge>((after) => stripe.charges.list({
    created: created(w), limit: 100, ...(after ? { starting_after: after } : {}),
  }));
  const byCustomer = new Map<string, string[]>();
  for (const c of charges) {
    const cus = idOf(c.customer as string | { id: string } | null);
    if (!cus) continue;
    byCustomer.set(cus, [...(byCustomer.get(cus) ?? []), c.id]);
  }
  // One update per customer, only into empty cells, 8 at a time.
  let filled = 0;
  const queue = [...byCustomer];
  await Promise.all(Array.from({ length: 8 }, async () => {
    for (let job = queue.pop(); job; job = queue.pop()) {
      const [cus, ids] = job;
      for (let i = 0; i < ids.length; i += 200) {
        const { data, error } = await sb.from("fin_txn").update({ customer_id: cus })
          .in("charge_id", ids.slice(i, i + 200)).is("customer_id", null).select("id");
        if (error) throw new Error(`fin_txn customer update failed: ${error.message}`);
        filled += (data ?? []).length;
      }
    }
  }));
  return { job: "charges", fetched: charges.length, written: byCustomer.size, extra: filled,
    sinceIso: w.since.toISOString(), untilIso: w.until.toISOString() };
}

export const peopleLogPatch = (r: PeopleSyncResult) => ({
  rows_imported: r.written,
  charges_fetched: r.fetched,
  ...(r.job === "charges" ? { rows_replaced: r.extra } : {}),
});
