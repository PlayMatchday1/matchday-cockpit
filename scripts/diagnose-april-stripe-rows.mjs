// Inspect representative Stripe rows from the latest import batch,
// plus look for any hint of refunded/disputed/charged-back handling.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = readFileSync(
  "/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local",
  "utf8",
);
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

const fmt = (n) =>
  "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function selectAll(table, filters = {}) {
  const out = []; let from = 0; const PAGE = 1000;
  while (true) {
    let q = sb.from(table).select("*").range(from, from + PAGE - 1);
    for (const [k, v] of Object.entries(filters)) q = q.eq(k, v);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

const apr = await selectAll("fin_revenue", { month: "Apr 2026" });
const stripe = apr.filter((r) => r.source === "Stripe");

// Latest batch = rows whose created_at starts with the most recent date prefix
const latestBatchPrefix = "2026-05-01";
const batch = stripe.filter((r) => String(r.created_at ?? "").startsWith(latestBatchPrefix));
batch.sort((a, b) => String(a.date ?? "").localeCompare(String(b.date ?? "")));

console.log(`=== Latest import batch (created_at ${latestBatchPrefix}*) ===`);
console.log(`Rows in batch: ${batch.length}`);
console.log(`Sum gross: ${fmt(batch.reduce((s, r) => s + Number(r.gross ?? 0), 0))}`);
console.log(`Date range in batch: ${batch[0]?.date} → ${batch.at(-1)?.date}`);

console.log(`\nEarliest charge (by date) in batch:`);
const earliest = batch[0];
if (earliest) {
  for (const [k, v] of Object.entries(earliest)) {
    console.log(`  ${k}: ${JSON.stringify(v)}`);
  }
}

console.log(`\nLatest charge (by date) in batch:`);
const latest = batch.at(-1);
if (latest) {
  for (const [k, v] of Object.entries(latest)) {
    console.log(`  ${k}: ${JSON.stringify(v)}`);
  }
}

// Look for unusual notes hints (refund/dispute/chargeback/partial)
const SUSPICIOUS = /refund|dispute|chargeback|charged.?back|reversal|partial|capture|adjust|hold/i;
const flagged = stripe.filter((r) =>
  SUSPICIOUS.test(r.notes ?? "") || SUSPICIOUS.test(r.description ?? ""),
);
console.log(`\n=== Stripe rows whose notes/description hint at refunds/disputes/etc. ===`);
console.log(`Matches: ${flagged.length}`);
for (const r of flagged.slice(0, 10)) {
  console.log(
    `  id=${r.id} date=${r.date} type=${r.type} gross=${fmt(r.gross)} notes="${r.notes ?? ""}"`,
  );
}

// Schema sanity: what columns does fin_revenue actually have?
console.log(`\n=== fin_revenue columns present on a Stripe row ===`);
console.log(Object.keys(stripe[0] ?? {}).join(", "));

// Negative-gross rows (would suggest refund handling)
const neg = stripe.filter((r) => Number(r.gross ?? 0) < 0);
console.log(`\n=== Negative-gross Stripe rows (refund signal) ===`);
console.log(`Count: ${neg.length}`);
for (const r of neg.slice(0, 10)) {
  console.log(
    `  id=${r.id} date=${r.date} type=${r.type} gross=${fmt(r.gross)} notes="${r.notes ?? ""}"`,
  );
}
