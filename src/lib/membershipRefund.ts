import "server-only";
// MEMBERSHIP CHARGE REFUNDS (Ryan's rule, PLAYBOOK rule 22) — the Stripe side.
//
// THE ONLY STRIPE WRITE IN CLUBHOUSE. Everything else reads Stripe. A person with EDIT MEMBERSHIPS
// presses "Refund $71.99 + use draft" on a Player Chats draft; nothing automatic reaches here
// (applyDraftAction refuses an "Auto:" refund, and decideAutoSend sends an eligible refund to a person).
//
//   AT DRAFT TIME, from our copies (cheap, no Stripe call):
//     the charge   stripe_member_invoices: this month's paid subscription_cycle invoice for the
//                  player (md_user_id), amount_paid_cents as charged, tax included. Its charge id
//                  comes through fin_txn on the payment intent (the invoice row's own charge_id is
//                  not filled: 0 of 16 refunded membership charges in 2026 joined on it, 2026-11-02).
//     had a refund change_log under "Membership refund:", OR a Membership refund in fin_txn on any
//                  of the player's Stripe customers (stripe_customers.md_user_id). The refunds Ryan
//                  made by hand in Stripe are found this way: all 16 of 2026's joined, 2026-11-02.
//   AT THE PRESS, from Stripe itself (the copies can lag a day):
//     the charge is retrieved, and every charge on its customer and the player's other customers is
//     listed; liveRefundRefusal (aiDraftPolicy) decides. Then ONE refunds.create with an idempotency
//     key per draft, so a double press can't refund twice even past our own claim. Never retried.
//     LANDED only when the charge reads back refunded by at least the amount.
//
// The key is STRIPE_SECRET_KEY, never returned, logged or put in an error message.

import Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { recordWrite, supabaseLogStore } from "@/lib/changeLog";
import {
  liveRefundRefusal, membershipRefundPath, priorMembershipRefundFromLog, MEMBERSHIP_REFUND_REASON_PREFIX,
  type LiveCharge, type RefundLogRow,
} from "@/lib/aiDraftPolicy";
import type { MembershipCharge, StoredAction } from "@/lib/aiDraftRun";

export const STRIPE_HOST = "api.stripe.com";

/** The write client, pinned to Stripe's host and checked on the PARSED host. */
function stripeForWrite(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
  if (new URL(`https://${STRIPE_HOST}`).hostname !== "api.stripe.com") throw new Error("Refusing a Stripe write to another host");
  return new Stripe(key, { host: STRIPE_HOST, maxNetworkRetries: 0 });
}

const liveOf = (c: Stripe.Charge): LiveCharge => ({
  id: c.id, status: c.status, amount: c.amount, amount_refunded: c.amount_refunded ?? 0, refunded: c.refunded === true,
  disputed: c.disputed === true, created: c.created, metadata: (c.metadata ?? null) as Record<string, string> | null,
});

/** This month's paid renewal for the player, from the mirror. null: none (yet). Throws on a read error. */
export async function membershipChargeFromMirror(sb: SupabaseClient, playerId: number, monthStartIso: string): Promise<MembershipCharge | null> {
  const inv = await sb.from("stripe_member_invoices").select("created_at_utc, amount_paid_cents, payment_intent_id, charge_id, status")
    .eq("md_user_id", playerId).eq("billing_reason", "subscription_cycle").gte("created_at_utc", monthStartIso)
    .order("created_at_utc", { ascending: true }).limit(1).maybeSingle();
  if (inv.error) throw new Error(inv.error.message);
  if (!inv.data || inv.data.status !== "paid" || !(Number(inv.data.amount_paid_cents) > 0)) return null;
  let chargeId = (inv.data.charge_id as string | null) ?? null;
  if (!chargeId && inv.data.payment_intent_id) {
    const ch = await sb.from("fin_txn").select("charge_id").eq("kind", "charge").eq("payment_intent_id", inv.data.payment_intent_id).limit(1).maybeSingle();
    if (ch.error) throw new Error(ch.error.message);
    chargeId = (ch.data?.charge_id as string | null) ?? null;
  }
  return { at: inv.data.created_at_utc as string, amountCents: Number(inv.data.amount_paid_cents), chargeId };
}

async function customerIds(sb: SupabaseClient, playerId: number): Promise<string[]> {
  const r = await sb.from("stripe_customers").select("customer_id").eq("md_user_id", playerId);
  if (r.error) throw new Error(r.error.message);
  return (r.data ?? []).map((x) => x.customer_id as string);
}

/** Had a membership refund before: our log OR Stripe's own history (the mirror). Throws on a read error. */
export async function priorMembershipRefundAny(sb: SupabaseClient, playerId: number): Promise<boolean> {
  const log = await sb.from("change_log").select("outcome, changes").eq("endpoint", membershipRefundPath(playerId)).eq("env", "production");
  if (log.error) throw new Error(log.error.message);
  if (priorMembershipRefundFromLog((log.data ?? []) as RefundLogRow[])) return true;
  const ids = await customerIds(sb, playerId);
  if (!ids.length) return false;
  const ref = await sb.from("fin_txn").select("id").eq("kind", "refund").eq("type", "Membership").in("customer_id", ids).limit(1);
  if (ref.error) throw new Error(ref.error.message);
  return (ref.data ?? []).length > 0;
}

/** At the press: Stripe, live. Null when the refund may go ahead. */
export async function liveRefundPreflight(sb: SupabaseClient, action: StoredAction): Promise<string | null> {
  let stripe: Stripe;
  try { stripe = stripeForWrite(); } catch (e) { return e instanceof Error ? e.message : "Stripe is not configured."; }
  try {
    const target = await stripe.charges.retrieve(action.charge_id!);
    const customers = new Set(await customerIds(sb, action.player_id));
    if (typeof target.customer === "string") customers.add(target.customer);
    const all: LiveCharge[] = [];
    for (const c of customers) {
      const list = await stripe.charges.list({ customer: c, limit: 100 });
      all.push(...list.data.map(liveOf));
    }
    return liveRefundRefusal(liveOf(target), action.amount_cents!, all);
  } catch (e) {
    const code = (e as { code?: string })?.code;
    if (code === "resource_missing") return "That charge isn't in Stripe.";
    return `Stripe couldn't be read, nothing was refunded: ${e instanceof Error ? e.message.slice(0, 160) : "error"}`;
  }
}

/** ONE refund, logged. LANDED only when the charge reads back refunded by the amount. */
export async function refundMembershipCharge(args: { action: StoredAction; draftId: string; actorEmail: string; source: string }): Promise<{ status: "landed" | "failed" | "not_applied" | "unknown"; error?: string }> {
  const { action } = args;
  const stripe = stripeForWrite();
  const chargeId = action.charge_id!;
  const amount = action.amount_cents!;
  const reason = `${MEMBERSHIP_REFUND_REASON_PREFIX} ${action.reason}`.slice(0, 300);
  const res = await recordWrite(
    {
      env: "production", source: args.source, actorName: args.actorEmail, actorEmail: args.actorEmail, saveId: randomUUID(),
      matchId: null, matchName: `player ${action.player_id}`,
      method: "POST", path: membershipRefundPath(action.player_id),
      body: { charge_id: chargeId, amount_cents: amount, draft_id: args.draftId }, keys: [], label: (k) => k,
      applied: (b, a) => Number(a.amount_refunded ?? 0) - Number(b.amount_refunded ?? 0) >= amount,
      changes: [
        { key: "refund", field: "Membership refund", before: "", after: `$${(amount / 100).toFixed(2)} on ${chargeId}` },
        { key: "reason", field: "Reason", before: "", after: reason },
      ],
    },
    {
      readResource: async () => { const c = await stripe.charges.retrieve(chargeId); return { amount_refunded: c.amount_refunded ?? 0 }; },
      write: async () => {
        try {
          return await stripe.refunds.create({ charge: chargeId, amount, metadata: { clubhouse: "membership-refund", player_id: String(action.player_id) } }, { idempotencyKey: `membership-refund-${args.draftId}` });
        } catch (e) {
          // Stripe said no (bad request, card, permission): a settled FAILED. No answer at all stays UNKNOWN.
          const t = (e as { type?: string })?.type ?? "";
          if (/InvalidRequest|Card|Permission|Authentication|Idempotency/.test(t)) {
            const err = new Error(e instanceof Error ? e.message.slice(0, 200) : "Stripe refused the refund");
            err.name = "WriteFailedError";
            throw err;
          }
          throw e;
        }
      },
      now: () => new Date().toISOString(),
    },
    supabaseLogStore(),
  );
  if (res.outcome === "landed") return { status: "landed" };
  if (res.outcome === "failed") return { status: "failed", error: res.error?.message?.slice(0, 200) };
  if (res.outcome === "notapplied") return { status: "not_applied", error: "Stripe answered but the charge doesn't read back refunded. Check Stripe before doing anything else." };
  return { status: "unknown", error: "No clear answer from Stripe. Check the charge in Stripe before doing anything else." };
}
