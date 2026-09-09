/* THE GROSS-TO-NET GAP IN STRIPE, MONTH BY MONTH. READ-ONLY.
 *
 * Every call is a list or a retrieve. Nothing writes to Stripe, writes to Supabase, or syncs.
 *
 *   npx tsx scripts/stripe-gross-net-gap.mts [months-back]
 *
 * NEEDS STRIPE_SECRET_KEY IN THE ENVIRONMENT. It is empty in .env.local on a dev machine (the key
 * lives in Vercel), so this is written to be run wherever the key is present:
 *   STRIPE_SECRET_KEY=sk_live_... npx tsx scripts/stripe-gross-net-gap.mts
 *
 * WHY IT EXISTS. There are TWO different "net" figures and they are not the same:
 *   Stripe's own net    gross - fees - refunds - disputes - adjustments
 *   the Cockpit's net   gross - fees, and nothing else
 * stripeSync.ts computes net as gross - fees in three places and never reads a refund; there is no
 * amount_refunded anywhere in that file. So a refunded charge still counts its full gross as
 * revenue in fin_revenue and everywhere downstream of it. This script reports the Stripe side,
 * which the Cockpit cannot show you.
 *
 * THE BALANCE-TRANSACTION LEDGER IS THE AUTHORITY, not the charge list: a charge says what was
 * asked for, a balance transaction says what actually moved and what Stripe took. Every type is
 * bucketed and the unnamed ones are printed, so nothing can hide in a bucket this script forgot.
 */
import Stripe from "stripe";
import { readFileSync, existsSync } from "node:fs";
if (existsSync(".env.local")) {
  for (const l of readFileSync(".env.local", "utf8").split("\n")) {
    const m = l.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const key = (process.env.STRIPE_SECRET_KEY ?? "").trim();
if (!key) {
  console.log("STRIPE_SECRET_KEY is empty or unset.");
  console.log("It is blank in .env.local on a dev machine - the key lives in Vercel. Run as:");
  console.log("  STRIPE_SECRET_KEY=sk_live_... npx tsx scripts/stripe-gross-net-gap.mts");
  process.exit(1);
}
const stripe = new Stripe(key);

const BACK = Number(process.argv[2] || 4);
const now = new Date();
const MONTHS: string[] = [];
for (let i = BACK - 1; i >= 0; i--) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
  MONTHS.push(d.toISOString().slice(0, 7));
}
const startOf = (ym: string) => Math.floor(Date.parse(`${ym}-01T00:00:00Z`) / 1000);
const endOf = (ym: string) => { const [y, m] = ym.split("-").map(Number);
  return Math.floor(Date.parse(`${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, "0")}-01T00:00:00Z`) / 1000); };
const usd = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pad = (s: unknown, w: number) => String(s).padEnd(w);
const rt = (s: unknown, w: number) => String(s).padStart(w);

type B = { count: number; amount: number; fee: number; net: number };
const zero = (): B => ({ count: 0, amount: 0, fee: 0, net: 0 });

const data = new Map<string, { byType: Map<string, B>; total: B }>();
for (const ym of MONTHS) {
  const byType = new Map<string, B>(); const total = zero();
  for await (const bt of stripe.balanceTransactions.list({ created: { gte: startOf(ym), lt: endOf(ym) }, limit: 100 })) {
    if (!byType.has(bt.type)) byType.set(bt.type, zero());
    const b = byType.get(bt.type)!;
    b.count++; b.amount += bt.amount; b.fee += bt.fee; b.net += bt.net;
    total.count++; total.amount += bt.amount; total.fee += bt.fee; total.net += bt.net;
  }
  data.set(ym, { byType, total });
  console.log(`  ${ym}: ${total.count} balance transactions`);
}

const g = (ym: string, t: string) => data.get(ym)!.byType.get(t) ?? zero();
console.log("\n== THE GAP, DECOMPOSED ==");
console.log(`${pad("month", 9)}${rt("gross", 13)}${rt("fees", 12)}${rt("refunds", 12)}${rt("disputes", 12)}${rt("other", 12)}${rt("NET", 13)}${rt("gap %", 9)}`);
for (const ym of MONTHS) {
  const { byType, total } = data.get(ym)!;
  const gross = g(ym, "charge").amount + g(ym, "payment").amount;
  const refunds = g(ym, "refund").amount + g(ym, "payment_refund").amount;
  const disputes = g(ym, "adjustment").amount + g(ym, "dispute").amount;
  const named = new Set(["charge", "payment", "refund", "payment_refund", "adjustment", "dispute", "payout", "payout_cancel", "payout_failure", "transfer"]);
  let other = 0; for (const [t, b] of byType) if (!named.has(t)) other += b.amount;
  const fees = total.fee;
  const net = gross + refunds + disputes + other - fees;
  const gap = gross - net;
  console.log(`${pad(ym, 9)}${rt(usd(gross), 13)}${rt(usd(-fees), 12)}${rt(usd(refunds), 12)}${rt(usd(disputes), 12)}${rt(usd(other), 12)}${rt(usd(net), 13)}${rt(`${((gap / (gross || 1)) * 100).toFixed(2)}%`, 9)}`);
}

console.log("\n== EFFECTIVE FEE RATE ==");
console.log(`${pad("month", 9)}${rt("gross", 13)}${rt("fees", 12)}${rt("rate", 9)}${rt("charges", 9)}${rt("avg", 11)}`);
for (const ym of MONTHS) {
  const c = g(ym, "charge"), p = g(ym, "payment");
  const gross = c.amount + p.amount, fee = c.fee + p.fee, n = c.count + p.count;
  console.log(`${pad(ym, 9)}${rt(usd(gross), 13)}${rt(usd(fee), 12)}${rt(`${((fee / (gross || 1)) * 100).toFixed(2)}%`, 9)}${rt(n, 9)}${rt(usd(gross / (n || 1)), 11)}`);
}

console.log("\n== EVERY TYPE SEEN, so nothing hides in an unnamed bucket ==");
const types = new Set<string>(); for (const ym of MONTHS) for (const t of data.get(ym)!.byType.keys()) types.add(t);
console.log(`${pad("type", 22)}${MONTHS.map((m) => rt(m, 17)).join("")}`);
for (const t of [...types].sort()) console.log(`${pad(t, 22)}${MONTHS.map((ym) => rt(`${usd(g(ym, t).amount)} (${g(ym, t).count})`, 17)).join("")}`);

/* REFUNDS ITEMISED for the last full month - does a big cancel explain it, or is it spread? */
const target = MONTHS[MONTHS.length - 2] ?? MONTHS[0];
console.log(`\n== REFUNDS ITEMISED, ${target} ==`);
const refs: { date: string; amount: number; reason: string; match: string; charge: string }[] = [];
for await (const r of stripe.refunds.list({ created: { gte: startOf(target), lt: endOf(target) }, limit: 100, expand: ["data.charge"] })) {
  const ch = r.charge as Stripe.Charge | string | null;
  const md = (typeof ch === "object" && ch ? ch.metadata : {}) ?? {};
  refs.push({ date: new Date(r.created * 1000).toISOString().slice(0, 10), amount: r.amount,
    reason: r.reason ?? "(none)", match: String(md.matchId ?? md.userMatchId ?? "-"),
    charge: typeof ch === "string" ? ch : (ch?.id ?? "-") });
}
console.log(`  ${refs.length} refunds, ${usd(refs.reduce((t, r) => t + r.amount, 0))} total`);
const byDay = new Map<string, number>(); const byMatch = new Map<string, number>();
for (const r of refs) { byDay.set(r.date, (byDay.get(r.date) ?? 0) + r.amount); byMatch.set(r.match, (byMatch.get(r.match) ?? 0) + r.amount); }
const topDay = [...byDay].sort((a, b) => b[1] - a[1])[0];
const topMatch = [...byMatch].sort((a, b) => b[1] - a[1])[0];
const tot = refs.reduce((t, r) => t + r.amount, 0) || 1;
console.log(`  biggest single DAY:   ${topDay?.[0]} ${usd(topDay?.[1] ?? 0)}  (${(((topDay?.[1] ?? 0) / tot) * 100).toFixed(0)}% of the month)`);
console.log(`  biggest single MATCH: ${topMatch?.[0]} ${usd(topMatch?.[1] ?? 0)}  (${(((topMatch?.[1] ?? 0) / tot) * 100).toFixed(0)}% of the month)`);
console.log(`  -> ${(((topDay?.[1] ?? 0) / tot) > 0.3 || ((topMatch?.[1] ?? 0) / tot) > 0.3) ? "CLUSTERED - a big cancel is a fair description" : "SPREAD - no single cancel explains it"}`);
console.log(`\n  ${pad("date", 12)}${rt("amount", 11)}  ${pad("reason", 20)}${pad("match", 10)}charge`);
for (const r of refs.sort((a, b) => b.amount - a.amount).slice(0, 40))
  console.log(`  ${pad(r.date, 12)}${rt(usd(r.amount), 11)}  ${pad(r.reason, 20)}${pad(r.match, 10)}${r.charge}`);

console.log(`\n== DISPUTES, named individually ==`);
let nd = 0;
for await (const d of stripe.disputes.list({ created: { gte: startOf(MONTHS[0]), lt: endOf(MONTHS[MONTHS.length - 1]) }, limit: 100 })) {
  nd++;
  console.log(`  ${new Date(d.created * 1000).toISOString().slice(0, 10)}  ${usd(d.amount)}  ${d.status.padEnd(20)} ${d.reason}  ${d.id}`);
}
if (!nd) console.log("  none in the window");

/* THE JOAO CHECK - is anything leaving the MAIN account that should not be? */
console.log(`\n== WHAT IS LEAVING THE MAIN ACCOUNT ==`);
for (const ym of MONTHS) {
  const t = g(ym, "transfer"), po = g(ym, "payout");
  console.log(`  ${ym}  transfers ${rt(usd(t.amount), 12)} (${t.count})   payouts ${rt(usd(po.amount), 13)} (${po.count})`);
}
let na = 0;
for await (const a of stripe.accounts.list({ limit: 100 })) { na++; console.log(`  connected account: ${a.id} ${a.business_profile?.name ?? ""} ${a.type}`); }
if (!na) console.log("  no connected accounts on this Stripe account - nothing is being routed out to one");
