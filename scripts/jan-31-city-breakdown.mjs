import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = readFileSync("/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local","utf8");
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

async function paginateAll(q, pageSize=1000){let from=0,all=[];for(;;){const{data,error}=await q.range(from,from+pageSize-1);if(error)throw error;if(!data||!data.length)break;all=all.concat(data);if(data.length<pageSize)break;from+=pageSize;}return all;}

console.log("=== (3) Jan 1-31 Membership by city (post-sync state right now) ===");
const mem = await paginateAll(sb.from("fin_revenue").select("city, gross").eq("type","Membership").eq("source","Stripe").gte("date","2026-01-01").lte("date","2026-01-31"));
const byCity = new Map();
for (const r of mem) {
  const c = r.city ?? "(null)";
  if (!byCity.has(c)) byCity.set(c,{rows:0,gross:0});
  byCity.get(c).rows++; byCity.get(c).gross += r.gross??0;
}
const sorted = [...byCity.entries()].sort((a,b)=>b[1].gross-a[1].gross);
for (const [c, x] of sorted) {
  console.log(`  ${c.padEnd(28)} rows=${String(x.rows).padStart(3)}  $${Math.round(x.gross).toLocaleString().padStart(7)}`);
}
const grand = sorted.reduce((s,[,x])=>s+x.gross,0);
console.log(`  ${"".padEnd(28)} ${"-".repeat(20)}`);
console.log(`  ${"GRAND TOTAL".padEnd(28)} rows=${String(mem.length).padStart(3)}  $${Math.round(grand).toLocaleString().padStart(7)}`);

console.log("\n=== (4) DPP Jan drift ===");
const dpp = await paginateAll(sb.from("fin_revenue").select("gross").eq("type","DPP").eq("source","Stripe").gte("date","2026-01-01").lte("date","2026-01-31"));
const dT = dpp.reduce((s,r)=>s+(r.gross??0),0);
console.log(`  rows=${dpp.length} (baseline 230)  $${Math.round(dT).toLocaleString()} (baseline $39,787)  Δ=${Math.round(dT-39787) === 0 ? "ZERO ✓" : "⚠️"}`);

console.log("\n=== (5) Verify the fallback would resolve real emails (local service-role probe) ===");
// Build the emailToCity map the same way the route does, and count
// resolvable emails. If this matches what I simulated earlier (~20,282
// total entries), production should be seeing the same coverage.
const memberRows = await paginateAll(sb.from("mdapi_subscriptions").select("member_email, city_identifier").order("membership_id"));
const CITY = {ATX:"Austin",HOU:"Houston",SATX:"San Antonio",DFW:"Dallas",ATL:"Atlanta",OKC:"OKC",STL:"St. Louis",ELP:"El Paso"};
const DEL = "Deleted Account Revenue";
const map = new Map();
let prim = 0;
for (const m of memberRows) {
  if (m.member_email) {
    map.set(m.member_email.toLowerCase().trim(), CITY[m.city_identifier?.trim()] ?? DEL);
    prim++;
  }
}
const userRows = await paginateAll(sb.from("mdapi_users").select("email, preferable_city_normalized").not("email","is",null).not("preferable_city_normalized","is",null));
let fb = 0;
for (const u of userRows) {
  const e = u.email.toLowerCase().trim();
  if (map.has(e)) continue;
  map.set(e, CITY[u.preferable_city_normalized?.trim()] ?? DEL);
  fb++;
}
console.log(`  Service-role build: ${prim} from subs + ${fb} from users fallback = ${map.size} total`);
console.log(`  If route is on the new code, its log line should show numbers matching this exactly.`);
