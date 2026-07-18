import { sb } from "./_session_runner.mjs";
const g = await sb.from("goals").select("id, title, status, scope, city, quarter_key").or("title.ilike.%140 Matches%,title.ilike.%Matches Per Week%,title.ilike.%Close Seed%");
if (g.error) { console.log("goals query ERR:", g.error.message); }
else g.data.forEach(r=>console.log(`  title="${r.title}"  status=${JSON.stringify(r.status)}  scope=${r.scope}  city=${r.city}`));
console.log("\n=== distinct status values in goals table ===");
const all = await sb.from("goals").select("status");
if(!all.error){const c={};all.data.forEach(r=>c[JSON.stringify(r.status)]=(c[JSON.stringify(r.status)]||0)+1);console.log("  "+JSON.stringify(c,null,2));}
