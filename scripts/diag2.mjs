import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
function pick(name){ const m = env.match(new RegExp("^"+name+"=(.+)$","m")); if(!m) return null; return m[1].trim().replace(/^['"]|['"]$/g,""); }
const url = pick("NEXT_PUBLIC_SUPABASE_URL");
const key = pick("SUPABASE_SERVICE_ROLE_KEY");
console.error("url ok:", !!url, "prefix", url?.slice(0,20), "| key len", key?.length);
const sb = createClient(url, key, { auth: { persistSession: false } });
const now = new Date();
const startDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
const last48 = new Date(now - 48*3600*1000);
const probe = await sb.from("fin_sync_log").select("*").limit(1);
if (probe.error){ console.log("ERR cols:", probe.error.message); }
else if (probe.data?.[0]) console.log("columns:", Object.keys(probe.data[0]).join(", "));
const { data: rows, error } = await sb.from("fin_sync_log").select("*").gte("started_at", last48.toISOString()).order("started_at",{ascending:false});
if (error){ console.log("query err:", error.message); process.exit(1); }
console.log(`\n=== ${rows.length} rows last 48h ===`);
const today = rows.filter(r=> new Date(r.started_at) >= startDay);
console.log(`\n--- TODAY ${today.length} rows by source ---`);
const by={};
for(const r of today)(by[r.source??"(null)"]??=[]).push(r);
for(const [s,l] of Object.entries(by).sort((a,b)=>b[1].length-a[1].length)){
  const d=l.map(r=>r.completed_at?(new Date(r.completed_at)-new Date(r.started_at))/1000:null);
  const f=d.filter(x=>x!=null); const unf=d.filter(x=>x==null).length; const e=l.filter(r=>r.error_message).length;
  const avg=f.length?(f.reduce((a,b)=>a+b,0)/f.length).toFixed(1):"-"; const mx=f.length?Math.max(...f).toFixed(1):"-";
  console.log(`  ${s.padEnd(28)} runs=${String(l.length).padStart(3)} avg=${avg}s max=${mx}s unfinalized=${unf} errors=${e}`);
}
console.log("\n--- TODAY timeline ---");
for(const r of today){ const dur=r.completed_at?`${Math.round((new Date(r.completed_at)-new Date(r.started_at))/1000)}s`:"STUCK"; console.log(`  ${r.started_at}  ${(r.source??"").padEnd(26)} by=${(r.triggered_by??"?").padEnd(7)} ${dur.padStart(8)}  ${r.error_message?"ERR:"+r.error_message.slice(0,90):""}`); }
const stuck=rows.filter(r=>!r.completed_at);
console.log(`\n=== Unfinalized last 48h: ${stuck.length} ===`);
for(const r of stuck){ const age=Math.round((now-new Date(r.started_at))/60000); console.log(`  ${r.started_at} ${r.source} by=${r.triggered_by} age=${age}min`); }
