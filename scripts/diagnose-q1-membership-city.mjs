import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = readFileSync("/Users/ryanmancuso/Code/matchday-cockpit/.env.local","utf8");
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

async function paginateAll(q, pageSize = 1000) {
  let from = 0, all = [];
  for (;;) {
    const { data, error } = await q.range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all = all.concat(data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

// 1. mdapi_subscriptions shape — what's in the source-of-truth map
console.log("=== mdapi_subscriptions inventory ===");
const subs = await paginateAll(sb.from("mdapi_subscriptions").select("member_email, status, city_identifier, activation_date, canceled_at"));
const byStatus = new Map();
const cityHist = new Map();
for (const s of subs) {
  const st = s.status ?? "(null)";
  byStatus.set(st, (byStatus.get(st) ?? 0) + 1);
  if (s.city_identifier) cityHist.set(s.city_identifier, (cityHist.get(s.city_identifier) ?? 0) + 1);
}
console.log(`  total rows: ${subs.length}`);
console.log(`  status histogram: ${[...byStatus.entries()].map(([s,c]) => `${s}=${c}`).join(", ")}`);
console.log(`  distinct member_email: ${new Set(subs.filter(s => s.member_email).map(s => s.member_email.toLowerCase())).size}`);
console.log(`  earliest activation_date: ${[...subs.map(s => s.activation_date).filter(Boolean)].sort()[0]}`);
console.log(`  latest activation_date: ${[...subs.map(s => s.activation_date).filter(Boolean)].sort().slice(-1)[0]}`);

// 2. The Q1 "Deleted Account Revenue" Membership rows in fin_revenue
console.log("\n=== Q1 fin_revenue Membership rows routed to DELETED bucket ===");
const q1Deleted = await paginateAll(sb.from("fin_revenue")
  .select("date, gross, notes")
  .eq("type","Membership")
  .eq("source","Stripe")
  .eq("city","Deleted Account Revenue")
  .gte("date","2026-01-01").lte("date","2026-03-31"));
console.log(`  ${q1Deleted.length} aggregate rows, total $${Math.round(q1Deleted.reduce((s,r)=>s+(r.gross??0),0)).toLocaleString()}`);
// Parse "N Stripe subscription txns" from notes to total underlying charges
let totalTxns = 0;
for (const r of q1Deleted) {
  const m = (r.notes ?? "").match(/(\d+)\s+Stripe\s+subscription\s+txns?/);
  if (m) totalTxns += parseInt(m[1], 10);
}
console.log(`  underlying charges (parsed from notes): ${totalTxns}`);

// 3. April + May for comparison — most charges route to real cities; Deleted is small
console.log("\n=== Apr+May fin_revenue Membership ===");
const q2Deleted = await paginateAll(sb.from("fin_revenue")
  .select("date, gross, city")
  .eq("type","Membership").eq("source","Stripe")
  .gte("date","2026-04-01").lte("date","2026-05-31"));
const byCity = new Map();
for (const r of q2Deleted) {
  const c = r.city ?? "(null)";
  if (!byCity.has(c)) byCity.set(c, { rows: 0, gross: 0 });
  byCity.get(c).rows++; byCity.get(c).gross += r.gross ?? 0;
}
for (const [c, x] of [...byCity.entries()].sort()) {
  console.log(`  ${c.padEnd(28)} rows=${String(x.rows).padStart(3)} $${Math.round(x.gross).toLocaleString().padStart(7)}`);
}

// 4. Can we rescue from mdapi_users? Check what its email column / city column look like
console.log("\n=== mdapi_users columns (sample) ===");
const usrProbe = await sb.from("mdapi_users").select("*").limit(1);
if (usrProbe.data?.[0]) {
  for (const k of Object.keys(usrProbe.data[0])) {
    const v = usrProbe.data[0][k];
    if (typeof v === "string" && v.length > 60) console.log(`  ${k}: <truncated string>`);
    else console.log(`  ${k}: ${JSON.stringify(v)}`);
  }
}

console.log("\n=== mdapi_users with non-null preferable_city_normalized (count + city histogram) ===");
const usrCity = await paginateAll(sb.from("mdapi_users").select("preferable_city_normalized").not("preferable_city_normalized","is",null));
console.log(`  users with city: ${usrCity.length}`);
const ucHist = new Map();
for (const u of usrCity) {
  const c = u.preferable_city_normalized;
  ucHist.set(c, (ucHist.get(c) ?? 0) + 1);
}
for (const [c, n] of [...ucHist.entries()].sort((a,b)=>b[1]-a[1])) {
  console.log(`    ${c.padEnd(28)} ${n}`);
}

// 5. Subscription emails vs. user emails — does mdapi_users cover the unmatched
//    customer set? Pull a sample of unmatched canceled subs (the rescue candidates).
console.log("\n=== mdapi_users count vs mdapi_subscriptions count (email overlap) ===");
const usersAll = await paginateAll(sb.from("mdapi_users").select("email, preferable_city_normalized").not("email","is",null));
const userEmailToCity = new Map();
for (const u of usersAll) {
  if (u.email) userEmailToCity.set(u.email.toLowerCase().trim(), u.preferable_city_normalized);
}
console.log(`  mdapi_users distinct email: ${userEmailToCity.size}`);
const subEmails = new Set(subs.filter(s => s.member_email).map(s => s.member_email.toLowerCase().trim()));
console.log(`  mdapi_subscriptions distinct email: ${subEmails.size}`);
let subEmailsInUsers = 0;
for (const e of subEmails) if (userEmailToCity.has(e)) subEmailsInUsers++;
console.log(`  subscription emails that ALSO exist in mdapi_users: ${subEmailsInUsers} (${Math.round(subEmailsInUsers/subEmails.size*100)}%)`);
