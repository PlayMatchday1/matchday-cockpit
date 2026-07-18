import { sb } from "./_session_runner.mjs";

const [{ data: vf }, { data: venues }] = await Promise.all([
  sb.from("fin_venue_fields").select("mdapi_field_id, fin_venue_id"),
  sb.from("fin_venues").select("id, city, venue_name"),
]);
const vById = new Map(venues.map(v=>[Number(v.id), v]));
console.log("=== fin_venue_fields -> venue map ===");
const mapRows = vf.map(r=>{const v=vById.get(Number(r.fin_venue_id));return {field_id:Number(r.mdapi_field_id), venue_id:Number(r.fin_venue_id), city:v?.city, venue:v?.venue_name};})
  .sort((a,b)=>(a.city||"").localeCompare(b.city||"")||(a.venue||"").localeCompare(b.venue||""));
for (const r of mapRows) console.log(`  field_id=${String(r.field_id).padStart(5)}  venue_id=${String(r.venue_id).padStart(3)}  ${(r.city||"").padEnd(12)} ${r.venue||""}`);

console.log("\n=== PRUMC confirmation ===");
const prumcVenues = venues.filter(v=>(v.venue_name||"").toLowerCase().includes("prumc"));
console.log("fin_venues rows matching PRUMC:", JSON.stringify(prumcVenues));
const prumcIds = new Set(prumcVenues.map(v=>Number(v.id)));
const prumcFields = vf.filter(r=>prumcIds.has(Number(r.fin_venue_id)));
console.log("fin_venue_fields for PRUMC:", JSON.stringify(prumcFields));
const fieldIds = prumcFields.map(r=>Number(r.mdapi_field_id));
if (fieldIds.length){
  const { data: mm } = await sb.from("mdapi_matches").select("field_id, field_title, city_identifier").in("field_id", fieldIds).limit(50);
  const uniq=[...new Map((mm||[]).map(m=>[m.field_title, m])).values()];
  console.log("mdapi field_title samples:", JSON.stringify(uniq));
}

const { data: smJul } = await sb.from("schedule_master")
  .select("id, city, venue, detail, match_date, match_time, max_spots, mdapi_field_id")
  .gte("match_date","2026-07-01").lte("match_date","2026-07-31").order("match_date");
const prumcExisting = (smJul||[]).filter(s=> fieldIds.includes(Number(s.mdapi_field_id)) || (s.venue||"").toLowerCase().includes("prumc"));
console.log(`\n=== Existing schedule_master PRUMC rows in July 2026: ${prumcExisting.length} (dedup source) ===`);
for (const s of prumcExisting) console.log(`  ${s.match_date} ${s.match_time} field=${s.mdapi_field_id} venue="${s.venue}" detail="${s.detail}"`);
// sample any PRUMC row (any month) to mirror city/venue/detail
const { data: anyPrumc } = await sb.from("schedule_master").select("city, venue, detail, mdapi_field_id").or(fieldIds.length?`mdapi_field_id.in.(${fieldIds.join(",")})`:"venue.ilike.%prumc%").limit(3);
console.log("Existing PRUMC row shape (any month):", JSON.stringify(anyPrumc));

const parseHHMM=(t)=>{const m=/^\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?/i.exec(t);let h=+m[1];const mi=m[2]?+m[2]:0;const ap=(m[3]||"").toUpperCase();if(ap==="PM"&&h<12)h+=12;if(ap==="AM"&&h===12)h=0;return `${String(h).padStart(2,"0")}:${String(mi).padStart(2,"0")}`;};
const DOW={0:"Sun",1:"Mon",2:"Tue",3:"Wed",4:"Thu",5:"Fri",6:"Sat"};
const spec={1:["7:00 PM - 8:00 PM",18],2:["7:00 PM - 8:00 PM",18],4:["7:00 PM - 8:00 PM",18],5:["7:00 PM - 8:00 PM",18],0:["6:00 PM - 7:00 PM",18]};
const proposed=[];
for(let d=1;d<=31;d++){const iso=`2026-07-${String(d).padStart(2,"0")}`;const dow=new Date(iso+"T00:00:00Z").getUTCDay();if(spec[dow]){const[mt,sp]=spec[dow];proposed.push({date:iso,dow:DOW[dow],match_time:mt,hhmm:parseHHMM(mt),max_spots:sp});}}
console.log(`\n=== Proposed July 2026 PRUMC rows: ${proposed.length} ===`);
const byDow={};
for(const p of proposed){byDow[p.dow]=(byDow[p.dow]||0)+1;const dup=prumcExisting.find(s=>s.match_date===p.date&&parseHHMM(s.match_time)===p.hhmm);console.log(`  ${p.date} ${p.dow}  ${p.match_time}  ${p.max_spots}sp  ${dup?`<-- DUP existing id=${dup.id} SKIP`:"NEW"}`);}
console.log("  by weekday:", JSON.stringify(byDow));
