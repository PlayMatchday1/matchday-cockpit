import { sb } from "./_session_runner.mjs";
async function pageAll(f){const o=[];let x=0;for(;;){const{data,error}=await f().range(x,x+999);if(error)throw error;if(!data?.length)break;o.push(...data);if(data.length<1000)break;x+=1000;}return o;}
const DOW={0:"Sun",1:"Mon",2:"Tue",3:"Wed",4:"Thu",5:"Fri",6:"Sat"};
const ld=(s)=>{const d=new Date(s);return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`;};
const lt=(s)=>{const d=new Date(s);let h=d.getUTCHours();const mi=d.getUTCMinutes();const ap=h>=12?"PM":"AM";const h12=h%12===0?12:h%12;return `${h12}:${String(mi).padStart(2,"0")} ${ap}`;};
const dw=(iso)=>DOW[new Date(iso.length>10?iso:iso+"T00:00:00Z").getUTCDay()];
const parseHHMM=(t)=>{const m=/^\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?/i.exec(t);if(!m)return"";let h=+m[1];const mi=m[2]?+m[2]:0;const ap=(m[3]||"").toUpperCase();if(ap==="PM"&&h<12)h+=12;if(ap==="AM"&&h===12)h=0;return `${String(h).padStart(2,"0")}:${String(mi).padStart(2,"0")}`;};

// 1. fin_venues search
console.log("=== (1) fin_venues search: Striker / Little Elm / Stadium ===");
const fv = await sb.from("fin_venues").select("id, venue_name, city, billing_type, per_match_rate, cost_per_match, max_spots, is_active")
  .or("venue_name.ilike.%striker%,venue_name.ilike.%little elm%,venue_name.ilike.%stadium%");
fv.data.forEach(v=>console.log("  "+JSON.stringify(v)));
if(!fv.data.length) console.log("  (none found)");

// 2. field mapping
console.log("\n=== (2) fin_venue_fields for those venue(s) ===");
const ids = fv.data.map(v=>v.id);
let strikerFieldIds = [];
if (ids.length){
  const vff = await sb.from("fin_venue_fields").select("fin_venue_id, mdapi_field_id, field_title_at_link").in("fin_venue_id", ids);
  vff.data.forEach(r=>console.log("  "+JSON.stringify(r)));
  strikerFieldIds = vff.data.map(r=>Number(r.mdapi_field_id));
}
// also search mdapi_matches directly by title in case name differs
console.log("\n  (cross-check) mdapi_matches field_title ILIKE striker/little elm:");
const mmTitle = await pageAll(()=>sb.from("mdapi_matches").select("field_id, field_title, city_identifier").or("field_title.ilike.%striker%,field_title.ilike.%little elm%"));
[...new Map(mmTitle.map(r=>[r.field_id+"|"+r.field_title,r])).values()].forEach(r=>console.log("    "+JSON.stringify(r)));

console.log("\n  => Striker field_id(s):", JSON.stringify(strikerFieldIds));
if (!strikerFieldIds.length){ console.log("\n*** No field mapping — stopping steps 3-5 (need field_id). ***"); process.exit(0); }
const FID = strikerFieldIds[0];

// 3. mdapi_matches July (alive)
console.log(`\n=== (3) mdapi_matches field ${FID} July 2026 (deleted_at IS NULL) ===`);
const mm = await pageAll(()=>sb.from("mdapi_matches").select("start_date, is_cancelled, deleted_at, max_player_count")
  .eq("field_id",FID).gte("start_date","2026-07-01T00:00:00Z").lt("start_date","2026-08-01T00:00:00Z").is("deleted_at",null));
const mmRows = mm.map(m=>({date:ld(m.start_date), dow:dw(m.start_date), time:lt(m.start_date), hhmm:parseHHMM(lt(m.start_date)), cancelled:m.is_cancelled, cap:m.max_player_count}))
  .sort((a,b)=>a.date.localeCompare(b.date)||a.hhmm.localeCompare(b.hhmm));
mmRows.forEach(r=>console.log(`  ${r.date} ${r.dow} ${r.time.padEnd(8)} cap=${r.cap} ${r.cancelled?"CANCELLED":"alive"}`));
const mmSet = new Set(mmRows.filter(r=>!r.cancelled).map(r=>`${r.date}|${r.hhmm}`));
const mmDateSet = new Set(mmRows.filter(r=>!r.cancelled).map(r=>r.date));

// 4. schedule_master July
console.log(`\n=== (4) schedule_master field ${FID} July 2026 ===`);
const sm = await sb.from("schedule_master").select("match_date, match_time, max_spots").eq("mdapi_field_id",FID)
  .gte("match_date","2026-07-01").lte("match_date","2026-07-31").order("match_date");
sm.data.forEach(r=>console.log(`  ${r.match_date} ${dw(r.match_date)} ${r.match_time} ${r.max_spots}sp`));
if(!sm.data.length) console.log("  (none)");
const smSet = new Set(sm.data.map(r=>`${r.match_date}|${parseHHMM(r.match_time)}`));
const smDateSet = new Set(sm.data.map(r=>r.match_date));

// 5. compare expected list
const expected = [
  ["2026-07-09","Thu","9:00 PM - 10:00 PM"],["2026-07-13","Mon","9:00 PM - 10:00 PM"],["2026-07-14","Tue","8:00 PM - 9:00 PM"],
  ["2026-07-16","Thu","9:00 PM - 10:00 PM"],["2026-07-20","Mon","9:00 PM - 10:00 PM"],["2026-07-21","Tue","8:00 PM - 9:00 PM"],
  ["2026-07-23","Thu","9:00 PM - 10:00 PM"],["2026-07-27","Mon","8:00 PM - 9:00 PM"],["2026-07-28","Tue","8:00 PM - 9:00 PM"],
  ["2026-07-30","Thu","8:00 PM - 9:00 PM"],
];
console.log(`\n=== (5) COMPARE expected (${expected.length}) vs mdapi & schedule_master ===`);
console.log("date        dow  expected-time        in_mdapi(exact)  in_sm(exact)  notes");
const missSM=[], missMD=[];
for (const [d,wd,t] of expected){
  const hh=parseHHMM(t);
  const inMDexact=mmSet.has(`${d}|${hh}`); const inMDdate=mmDateSet.has(d);
  const inSMexact=smSet.has(`${d}|${hh}`); const inSMdate=smDateSet.has(d);
  let note="";
  if (inMDdate && !inMDexact){ const mdt=mmRows.find(r=>r.date===d&&!r.cancelled); note+=`mdapi has this date at ${mdt?mdt.time:"?"} (TIME MISMATCH) `; }
  if (!inSMexact) missSM.push(`${d} ${wd} ${t}`);
  if (!inMDexact) missMD.push(`${d} ${wd} ${t}${inMDdate?" (date exists, diff time)":""}`);
  console.log(`  ${d} ${wd}  ${t.padEnd(18)} ${String(inMDexact).padEnd(15)} ${String(inSMexact).padEnd(12)} ${note}`);
}
console.log(`\nMISSING from schedule_master (${missSM.length}):`); missSM.forEach(x=>console.log("  "+x));
console.log(`\nMISSING from mdapi exact (${missMD.length}):`); missMD.forEach(x=>console.log("  "+x));
// mdapi alive dates not in expected list (extra upstream)
const expDates=new Set(expected.map(e=>e[0]));
const extraMD=[...mmDateSet].filter(d=>!expDates.has(d)).sort();
console.log(`\nmdapi alive Striker dates NOT in your expected list (${extraMD.length}):`, JSON.stringify(extraMD));
