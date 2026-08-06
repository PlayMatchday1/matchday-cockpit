// (d)-critical reconciliation for the manager year report, over HTTP against the
// running build. Mints an admin session, pulls the year report for a real manager,
// and independently sums the Manager Pay per-week compute (/api/manager-pay/week)
// over the year — filtered to in-year (Central) matches — then compares.
// "If (d) fails, do not ship."  Run: node scripts/e2e/recon-year.mjs

import { createClient } from "@supabase/supabase-js";
process.loadEnvFile(".env.local");
const BASE = "http://localhost:3000", YEAR = 2026;
const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });

const link = await svc.auth.admin.generateLink({ type: "magiclink", email: "rmancuso@playmatchday.com" });
const v = await anon.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token });
const TOK = v.data.session.access_token;
const get = async (path) => { const r = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${TOK}` } }); return { status: r.status, json: await r.json().catch(() => null) }; };
const addDays = (iso, n) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

const list = await get(`/api/manager-pay/manager-year?year=${YEAR}`);
console.log(`managers in ${YEAR}: ${list.json.managers.length}  (route status ${list.status})`);

// pick the first manager with >=8 worked (or an email passed as argv[2])
const wantEmail = process.argv[2];
let pick = null, rep = null;
for (const m of list.json.managers) {
  if (wantEmail && m.email.toLowerCase() !== wantEmail.toLowerCase()) continue;
  const r = await get(`/api/manager-pay/manager-year?year=${YEAR}&manager=${encodeURIComponent(m.email)}`);
  if (wantEmail || r.json?.worked >= 8) { pick = m; rep = r.json; break; }
}
if (!rep) { console.log("no manager with >=8 worked matches — pick relaxed"); const r0 = await get(`/api/manager-pay/manager-year?year=${YEAR}&manager=${encodeURIComponent(list.json.managers[0].email)}`); pick = list.json.managers[0]; rep = r0.json; }

console.log(`\nMANAGER: ${rep.managerName} <${pick.email}>`);
console.log(`raw spellings: [${rep.rawSpellings.join(" | ")}] → collapsed ${rep.collapsedCount}; unresolved ${rep.unresolved.length}`);
console.log(`worked=${rep.worked} cancelled=${rep.cancelled} matchPay=$${rep.matchPay} adj=$${rep.adjustmentsTotal} grand=$${rep.grand} weeks=${rep.weeksWorked}/${rep.weeksElapsed}`);
console.log(`events flagged as fields: ${rep.events.length ? rep.events.join(", ") : "none"}`);

const eq = (x, y) => x === y ? "✓" : "✗";
const aSum = rep.rows.filter(r => !r.cancelled).reduce((s, r) => s + r.pay, 0) + rep.adjustments.reduce((s, x) => s + x.amount, 0);
console.log(`\n(a) sum(match pay)+adj $${aSum} == grand $${rep.grand} ${eq(aSum, rep.grand)}`);
const bSum = rep.weeks.reduce((s, w) => s + w.total, 0);
console.log(`(b) week totals $${bSum} == grand ${eq(bSum, rep.grand)}`);
const fm = rep.fields.reduce((s, f) => s + f.matches, 0), fp = rep.fields.reduce((s, f) => s + f.pay, 0);
const cm = rep.cities.reduce((s, c) => s + c.matches, 0), cp = rep.cities.reduce((s, c) => s + c.pay, 0);
console.log(`(c) field matches ${fm}==worked ${rep.worked} ${eq(fm, rep.worked)} | field pay $${fp}==grand-adj $${rep.grand - rep.adjustmentsTotal} ${eq(fp, rep.grand - rep.adjustmentsTotal)} | city==field ${eq(cm, fm)}${eq(cp, fp)}`);

// (d) independent per-week sum from /api/manager-pay/week over the year
let firstMon = `${YEAR}-01-01`; { const d = new Date(firstMon + "T00:00:00Z"); const w = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - w); firstMon = d.toISOString().slice(0, 10); }
let dSum = 0; const diverge = [];
for (let mon = firstMon; mon <= `${YEAR}-12-28`; mon = addDays(mon, 7)) {
  const wk = await get(`/api/manager-pay/week?week=${mon}`);
  if (wk.status !== 200) continue;
  let acc = 0;
  for (const c of wk.json.cities || []) for (const mr of c.managers) {
    if ((mr.managerEmail || "").toLowerCase() !== pick.email.toLowerCase()) continue;
    for (const mm of mr.matches) if (String(mm.centralDate).slice(0, 4) === String(YEAR)) acc += mm.payAmount;
    if (mon.slice(0, 4) === String(YEAR)) acc += mr.adjustment;
  }
  const rw = rep.weeks.find(w => w.weekStart === mon);
  if (acc !== (rw ? rw.total : 0)) diverge.push(`${mon}: page $${acc} vs report $${rw ? rw.total : 0}`);
  dSum += acc;
}
console.log(`\n(d) Manager Pay per-week sum (in-year) $${dSum} == report grand $${rep.grand}  ${dSum === rep.grand ? "✓ RECONCILES" : "✗ DIVERGES — DO NOT SHIP"}`);
if (diverge.length) console.log("   diverging weeks:\n   " + diverge.join("\n   "));
