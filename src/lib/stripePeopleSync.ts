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
export type PeopleJob = "customers" | "invoices" | "charges";
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

export async function syncMemberInvoices(sb: SupabaseClient, stripe: Stripe, w: Window): Promise<PeopleSyncResult> {
  const at = new Date().toISOString();
  const all = await listAll<Stripe.Invoice>((after) => stripe.invoices.list({
    created: created(w), status: "paid", limit: 100, expand: ["data.payments"],
    ...(after ? { starting_after: after } : {}),
  }));
  const rows = all.flatMap((inv) => {
    const sd = inv.parent?.subscription_details;
    if (!sd) return [];   // not a subscription invoice
    // The payment that settled it: the first PAID payment, else the first one listed.
    const pays = inv.payments?.data ?? [];
    const pay = pays.find((p) => p.status === "paid") ?? pays[0];
    return [{
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
      synced_at: at,
    }];
  });
  await upsert(sb, "stripe_member_invoices", "invoice_id", rows);
  return { job: "invoices", fetched: all.length, written: rows.length, extra: all.length - rows.length,
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
