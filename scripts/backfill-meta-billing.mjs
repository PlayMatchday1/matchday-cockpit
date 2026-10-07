// BACKFILL fin_meta_billing_charge (migration 0212) from Meta's Payment activity page (Ryan, 2026-10-07).
//   node --env-file=.env.local scripts/backfill-meta-billing.mjs <payment_activity.csv>          dry run
//   node --env-file=.env.local scripts/backfill-meta-billing.mjs <payment_activity.csv> --write  writes
//
// The CSV (transaction_id,date,amount_usd,payment_method,reference,status) was read off Meta's
// Billing & payments > Payment activity page, which has every charge; the activity log misses some.
//   · PAID rows only. Failed payments are never charges. The "Ad credit" row is not a card charge.
//   · charged_at: the activity log's time for the same transaction_id (GET, read-only), else noon
//     America/Chicago on the page's date (CDT for every date Jul–Oct: 17:00 UTC).
//   · Then ONE balance row (the account's balance and amount_spent), so OpEx has a starting point.
// One INSERT per table, no retry, no upsert: on a table that already has rows the insert fails on
// the primary key and nothing is written. The daily sync adds everything after this.
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

const [file, flag] = process.argv.slice(2);
const WRITE = flag === "--write";
const ACT = "act_1613092135872657";
const T = process.env.META_ADS_ACCESS_TOKEN?.trim();
if (!file || !T) throw new Error("usage: backfill-meta-billing.mjs <csv> [--write]  (needs META_ADS_ACCESS_TOKEN)");

const lines = fs.readFileSync(file, "utf8").trim().split(/\r?\n/);
if (lines[0].trim() !== "transaction_id,date,amount_usd,payment_method,reference,status") throw new Error(`unexpected header: ${lines[0]}`);
const rows = lines.slice(1).map((l) => {
  const [id, date, amt, pm, , st] = l.split(",");
  const cents = Math.round(Number(amt) * 100);
  if (!/^\d+-\d+$/.test(id) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isInteger(cents) || cents <= 0) throw new Error(`bad row: ${l}`);
  return { id, date, cents, pm, st };
});

const get = async (u) => { const r = await fetch(u, { headers: { Authorization: `Bearer ${T}` } }); const j = await r.json(); if (!r.ok) throw new Error(`meta ${r.status}: ${j?.error?.message ?? ""}`.slice(0, 200)); return j; };
let url = `https://graph.facebook.com/v25.0/${ACT}/activities?fields=event_time,event_type,extra_data&since=2026-07-01&limit=100`;
const logAt = new Map();
while (url) {
  const j = await get(url);
  for (const r of j.data ?? []) if (r.event_type === "ad_account_billing_charge") { const x = JSON.parse(r.extra_data); logAt.set(x.transaction_id, { at: new Date(r.event_time).toISOString(), cents: x.new_value }); }
  url = j.paging?.next ?? "";
}

const paid = rows.filter((r) => r.st === "Paid" && r.pm !== "Ad credit");
const skipped = rows.filter((r) => !(r.st === "Paid" && r.pm !== "Ad credit"));
const out = paid.map((r) => {
  const l = logAt.get(r.id);
  if (l && l.cents !== r.cents) throw new Error(`${r.id}: page says ${r.cents}, log says ${l.cents}`);
  return {
    transaction_id: r.id, ad_account_id: ACT,
    charged_at: l ? l.at : `${r.date}T17:00:00.000Z`,
    amount_cents: r.cents, kind: "charge",
    event_type: l ? "ad_account_billing_charge" : "payment_activity_page", currency: "USD",
  };
});
const sum = (a) => a.reduce((s, r) => s + (r.amount_cents ?? r.cents), 0);
const byMonth = {};
for (const r of paid) byMonth[r.date.slice(0, 7)] = (byMonth[r.date.slice(0, 7)] ?? 0) + r.cents;
console.log(`rows ${rows.length}: paid card ${paid.length}, left out ${skipped.length} (${skipped.filter((r) => r.st !== "Paid").length} failed, ${skipped.filter((r) => r.pm === "Ad credit").length} ad credit)`);
console.log("paid by month:", Object.fromEntries(Object.entries(byMonth).map(([k, v]) => [k, (v / 100).toFixed(2)])), "total", (sum(out) / 100).toFixed(2));
console.log(`times: ${out.filter((r) => r.event_type === "ad_account_billing_charge").length} from the activity log, ${out.filter((r) => r.event_type !== "ad_account_billing_charge").length} at noon Central`);
console.log("activity-log charges not on the page:", [...logAt.keys()].filter((id) => !rows.some((r) => r.id === id)).length);

const acct = await get(`https://graph.facebook.com/v25.0/${ACT}?fields=balance,amount_spent,currency`);
if (acct.currency !== "USD") throw new Error(`account currency ${acct.currency}`);
const balance = { ad_account_id: ACT, read_at: new Date().toISOString(), balance_cents: Number(acct.balance), amount_spent_cents: Number(acct.amount_spent) };
console.log("balance now", (balance.balance_cents / 100).toFixed(2));

if (!WRITE) { console.log("DRY RUN — nothing written. Add --write to insert."); process.exit(0); }
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL.trim(), process.env.SUPABASE_SERVICE_ROLE_KEY.trim(), { auth: { persistSession: false } });
const a = await sb.from("fin_meta_billing_charge").insert(out).select("transaction_id");
console.log("charges:", a.error ? `FAILED ${a.error.message}` : `LANDED ${a.data.length} rows`);
if (a.error) process.exit(1);
const b = await sb.from("fin_meta_billing_balance").insert(balance).select("read_at");
console.log("balance:", b.error ? `FAILED ${b.error.message}` : `LANDED ${b.data.length} row`);
// READ BACK: what is stored now, independent of what was sent.
const back = await sb.from("fin_meta_billing_charge").select("amount_cents");
console.log("read back:", back.error ? back.error.message : `${back.data.length} rows, $${(back.data.reduce((s, r) => s + r.amount_cents, 0) / 100).toFixed(2)}`);
