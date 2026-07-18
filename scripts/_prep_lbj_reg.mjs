import { sb } from "./_session_runner.mjs";
const DOW={0:"Sun",1:"Mon",2:"Tue",3:"Wed",4:"Thu",5:"Fri",6:"Sat"};
const ld=(s)=>{const d=new Date(s);return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`;};
const dw=(s)=>DOW[new Date(s).getUTCDay()];
const lt=(s)=>{const d=new Date(s);let h=d.getUTCHours();const mi=d.getUTCMinutes();const ap=h>=12?"PM":"AM";const h12=h%12===0?12:h%12;return `${h12}:${String(mi).padStart(2,"0")} ${ap}`;};

// fin_venues schema + confirm LBJ absent
const fvCols = await sb.from("fin_venues").select("*").limit(1);
console.log("fin_venues columns:", Object.keys(fvCols.data[0]).join(", "));
const lbjV = await sb.from("fin_venues").select("id, venue_name").ilike("venue_name","%LBJ%");
console.log("existing fin_venues LBJ:", JSON.stringify(lbjV.data));

// fin_venue_fields schema + confirm 1486 unmapped
const vffCols = await sb.from("fin_venue_fields").select("*").limit(1);
console.log("fin_venue_fields columns:", Object.keys(vffCols.data[0]).join(", "));
const map1486 = await sb.from("fin_venue_fields").select("*").eq("mdapi_field_id",1486);
console.log("existing mapping for field 1486:", JSON.stringify(map1486.data));

// schedule_master current count (Phase 2 baseline guard)
const cnt = await sb.from("schedule_master").select("*",{count:"exact",head:true});
console.log("schedule_master current count:", cnt.count, "(expected 2085 from PRUMC batch)");

// === CROSS-CHECK: user's 18 specified rows vs current mdapi_matches (field 1486) ===
const spec = [
 ["2026-07-04","Sat","9:30 AM"],["2026-07-06","Mon","7:30 PM"],
 ["2026-07-10","Fri","7:30 PM"],["2026-07-11","Sat","9:30 AM"],["2026-07-12","Sun","7:30 PM"],["2026-07-13","Mon","7:30 PM"],["2026-07-14","Tue","7:30 PM"],
 ["2026-07-17","Fri","7:30 PM"],["2026-07-18","Sat","9:30 AM"],["2026-07-19","Sun","7:30 PM"],["2026-07-20","Mon","7:30 PM"],["2026-07-21","Tue","7:30 PM"],
 ["2026-07-24","Fri","7:30 PM"],["2026-07-25","Sat","9:30 AM"],["2026-07-26","Sun","7:30 PM"],["2026-07-27","Mon","7:30 PM"],["2026-07-28","Tue","7:30 PM"],
 ["2026-07-31","Fri","7:30 PM"],
];
console.log(`\nspecified rows: ${spec.length}`);
const mm = await sb.from("mdapi_matches").select("start_date, is_cancelled, deleted_at")
  .eq("field_id",1486).gte("start_date","2026-07-01T00:00:00Z").lt("start_date","2026-08-01T00:00:00Z");
const aliveSet = new Set((mm.data||[]).filter(m=>!m.is_cancelled && !m.deleted_at).map(m=>`${ld(m.start_date)}|${lt(m.start_date)}`));
console.log("mdapi alive LBJ slots:", JSON.stringify([...aliveSet].sort()));
let present=0, missing=[];
console.log("\n=== CROSS-CHECK (specified vs mdapi alive) ===");
for (const [d,wd,t] of spec){
  const key=`${d}|${t}`; const ok=aliveSet.has(key);
  if (ok) present++; else missing.push(`${d} ${wd} ${t}`);
  console.log(`  ${d} ${wd} ${t.padEnd(8)}  ${ok?"IN mdapi":"** NOT in mdapi **"}`);
}
console.log(`\nMatched in mdapi: ${present}/${spec.length}. Missing: ${missing.length}`);
if (missing.length) console.log("MISSING:\n  "+missing.join("\n  "));
