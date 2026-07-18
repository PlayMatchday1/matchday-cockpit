import { sb } from "./_session_runner.mjs";
const DOW={0:"Sun",1:"Mon",2:"Tue",3:"Wed",4:"Thu",5:"Fri",6:"Sat"};
const dw=(iso)=>DOW[new Date(iso+"T00:00:00Z").getUTCDay()];

// 1. The user's exact query: field 66, Jul 4/5
console.log("=== (1) schedule_master WHERE mdapi_field_id=66 AND match_date IN (Jul4,Jul5) ===");
const q = await sb.from("schedule_master").select("id, city, venue, detail, match_date, match_time, max_spots, mdapi_field_id, created_at")
  .eq("mdapi_field_id",66).in("match_date",["2026-07-04","2026-07-05"]).order("match_date").order("created_at");
console.log(`  ${q.data.length} rows`);
q.data.forEach(r=>console.log(`  ${r.match_date} ${dw(r.match_date)} "${r.match_time}" venue="${r.venue}" detail="${r.detail}" ${r.max_spots}sp id=${r.id} created=${r.created_at}`));

// 2. What venue is field 66?
console.log("\n=== (2) what is mdapi_field_id=66? ===");
const vff = await sb.from("fin_venue_fields").select("fin_venue_id, mdapi_field_id, field_title_at_link").eq("mdapi_field_id",66);
if(!vff.data.length) console.log("  field 66 NOT in fin_venue_fields (unmapped)");
for (const r of vff.data){const v=await sb.from("fin_venues").select("venue_name, city").eq("id",r.fin_venue_id);console.log(`  field 66 -> venue #${r.fin_venue_id} "${v.data[0]?.venue_name}" (${v.data[0]?.city})  linked="${r.field_title_at_link}"`);}
const mm = await sb.from("mdapi_matches").select("field_title, city_identifier").eq("field_id",66).limit(3);
console.log("  mdapi_matches field 66 title samples:", JSON.stringify([...new Set((mm.data||[]).map(m=>m.field_title+" / "+m.city_identifier))]));

// 3. ALL field-66 rows in July (any date) to understand
console.log("\n=== (3) ALL schedule_master field-66 July rows ===");
const all = await sb.from("schedule_master").select("match_date, match_time, venue, detail").eq("mdapi_field_id",66).gte("match_date","2026-07-01").lte("match_date","2026-07-31").order("match_date");
console.log(`  ${all.data.length} rows`);
all.data.forEach(r=>console.log(`  ${r.match_date} ${dw(r.match_date)} "${r.match_time}" venue="${r.venue}" detail="${r.detail}"`));

// 4. re-confirm Onion Creek (27/991) Jul 4/5
console.log("\n=== (4) re-confirm: Onion Creek (field 27/991) rows on Jul 4/5 ===");
const oc = await sb.from("schedule_master").select("id, match_date, match_time, detail").in("mdapi_field_id",[27,991]).in("match_date",["2026-07-04","2026-07-05"]);
console.log(`  ${oc.data.length} rows (expect 0)`);
