import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = readFileSync("/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local", "utf8");
// Values in .env.local are quoted ("https://…"). Strip surrounding
// quotes after trimming, or createClient throws "Invalid supabaseUrl".
const readEnv = (name) => {
  const m = env.match(new RegExp(`^${name}=(.+)$`, "m"));
  if (!m) throw new Error(`${name} not found in .env.local`);
  return m[1].trim().replace(/^["']|["']$/g, "");
};
const url = readEnv("NEXT_PUBLIC_SUPABASE_URL");
const key = readEnv("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(url, key, { auth: { persistSession: false } });

const now = new Date();
const startOfDayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
const last48h = new Date(now.getTime() - 48 * 3600 * 1000);

console.log(`NOW (UTC): ${now.toISOString()}`);
console.log(`Day start (UTC): ${startOfDayUTC.toISOString()}`);
console.log("");

// ---- 1. fin_sync_log columns ----
const probe = await sb.from("fin_sync_log").select("*").limit(1);
if (probe.error) { console.log("fin_sync_log error:", probe.error.message); }
else if (probe.data?.[0]) console.log("fin_sync_log columns:", Object.keys(probe.data[0]).join(", "), "\n");

// ---- 2. All sync activity last 48h ----
const { data: rows, error } = await sb
  .from("fin_sync_log")
  .select("*")
  .gte("started_at", last48h.toISOString())
  .order("started_at", { ascending: false });

if (error) { console.log("query error:", error.message); process.exit(1); }

console.log(`=== ${rows.length} fin_sync_log rows in last 48h ===\n`);

// Group by source, today only
const today = rows.filter(r => new Date(r.started_at) >= startOfDayUTC);
console.log(`--- TODAY (${today.length} rows) grouped by source ---`);
const bySource = {};
for (const r of today) {
  const s = r.source ?? "(null)";
  (bySource[s] ??= []).push(r);
}
for (const [src, list] of Object.entries(bySource).sort((a,b)=>b[1].length-a[1].length)) {
  const durs = list.map(r => r.completed_at ? (new Date(r.completed_at)-new Date(r.started_at))/1000 : null);
  const finished = durs.filter(d => d != null);
  const unfinalized = durs.filter(d => d == null).length;
  const errs = list.filter(r => r.error_message).length;
  const avg = finished.length ? (finished.reduce((a,b)=>a+b,0)/finished.length).toFixed(1) : "—";
  const max = finished.length ? Math.max(...finished).toFixed(1) : "—";
  console.log(`  ${src.padEnd(28)} runs=${String(list.length).padStart(3)}  avg=${avg}s max=${max}s  unfinalized=${unfinalized}  errors=${errs}`);
}

console.log("\n--- TODAY full timeline (source | started | triggered_by | dur | err) ---");
for (const r of today) {
  const dur = r.completed_at ? `${Math.round((new Date(r.completed_at)-new Date(r.started_at))/1000)}s` : "STUCK/UNFINALIZED";
  console.log(`  ${r.started_at}  ${(r.source??"").padEnd(26)} by=${(r.triggered_by??"?").padEnd(7)} ${dur.padStart(18)}  ${r.error_message? "ERR: "+r.error_message.slice(0,80):""}`);
}

// ---- 3. Unfinalized / stuck rows in last 48h ----
const stuck = rows.filter(r => !r.completed_at);
console.log(`\n=== Unfinalized rows (no completed_at) in last 48h: ${stuck.length} ===`);
for (const r of stuck) {
  const age = Math.round((now - new Date(r.started_at))/60000);
  console.log(`  ${r.started_at}  ${r.source}  by=${r.triggered_by}  age=${age}min`);
}

// ---- 4. pg_stat_activity via RPC if available ----
console.log("\n=== Attempting pg_stat_activity probe (active queries / locks) ===");
const probes = ["diag_active_queries", "pg_stat_activity_snapshot", "admin_active_queries"];
let gotActivity = false;
for (const fn of probes) {
  const r = await sb.rpc(fn);
  if (!r.error) { console.log(`RPC ${fn}:`, JSON.stringify(r.data, null, 2)); gotActivity = true; break; }
}
if (!gotActivity) console.log("(no diagnostic RPC available; pg_stat_activity not reachable via service-role REST — will check Vercel/Supabase dashboards instead)");
