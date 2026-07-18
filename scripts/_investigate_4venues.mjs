import { sb } from "./_session_runner.mjs";
const DOW={0:"Sun",1:"Mon",2:"Tue",3:"Wed",4:"Thu",5:"Fri",6:"Sat"};
const dw=(iso)=>DOW[new Date(iso+"T00:00:00Z").getUTCDay()];

async function venueInfo(label, nameLike){
  console.log(`\n========== ${label} ==========`);
  const fv = await sb.from("fin_venues").select("id, venue_name, city, billing_type, per_match_rate, cost_per_match, max_spots, charge_on_cancel, is_active").ilike("venue_name", nameLike);
  fv.data.forEach(v=>console.log(`  fin_venues: id=${v.id} "${v.venue_name}" (${v.city}) billing=${v.billing_type} rate=${v.per_match_rate} spots=${v.max_spots} coc=${v.charge_on_cancel}`));
  const ids = fv.data.map(v=>v.id);
  const vff = await sb.from("fin_venue_fields").select("fin_venue_id, mdapi_field_id, field_title_at_link").in("fin_venue_id", ids);
  vff.data.forEach(r=>console.log(`  field: ${r.mdapi_field_id} -> venue #${r.fin_venue_id}  linked="${r.field_title_at_link}"`));
  const fieldIds = vff.data.map(r=>Number(r.mdapi_field_id));
  if(!fieldIds.length){console.log("  (no field mappings)"); return {fv:fv.data, fieldIds:[]};}
  // June rows
  const jun = await sb.from("schedule_master").select("match_date, match_time, venue, detail, max_spots").in("mdapi_field_id",fieldIds).gte("match_date","2026-06-01").lte("match_date","2026-06-30").order("match_date");
  console.log(`  --- JUNE rows (${jun.data.length}) ---`);
  const combos=new Map(); jun.data.forEach(r=>{const k=`${dw(r.match_date)} "${r.match_time}" venue="${r.venue}" detail="${r.detail}" ${r.max_spots}sp`;combos.set(k,(combos.get(k)||0)+1);});
  [...combos.entries()].sort((a,b)=>b[1]-a[1]).forEach(([k,n])=>console.log(`    ${n}x  ${k}`));
  // July existing
  const jul = await sb.from("schedule_master").select("match_date, match_time, detail, max_spots").in("mdapi_field_id",fieldIds).gte("match_date","2026-07-01").lte("match_date","2026-07-31").order("match_date");
  console.log(`  --- JULY existing (${jul.data.length}) ---`);
  jul.data.forEach(r=>console.log(`    ${r.match_date} ${dw(r.match_date)} "${r.match_time}" detail="${r.detail}" ${r.max_spots}sp`));
  return {fv:fv.data, fieldIds};
}

await venueInfo("VENUE 1: PAC Global","%pac global%");
await venueInfo("VENUE 2: Lou Fusz","%lou fusz%");
await venueInfo("VENUE 3: Centennial Commons","%centennial%");
const katy = await venueInfo("VENUE 4: ATH Katy","%ath katy%");

// ATH Katy Sunday deep-dive
console.log("\n========== ATH KATY Sunday deep-dive ==========");
const kf = katy.fieldIds;
const sun = await sb.from("schedule_master").select("match_date, match_time, venue, detail, max_spots, mdapi_field_id").in("mdapi_field_id",kf).gte("match_date","2026-06-01").lte("match_date","2026-07-31").order("match_date");
console.log("  All ATH Katy rows Jun-Jul (to see Sunday detail/time convention):");
sun.data.filter(r=>dw(r.match_date)==="Sun").forEach(r=>console.log(`    ${r.match_date} Sun "${r.match_time}" venue="${r.venue}" detail="${r.detail}" ${r.max_spots}sp f=${r.mdapi_field_id}`));

const cnt=await sb.from("schedule_master").select("*",{count:"exact",head:true});
console.log("\nschedule_master current count:", cnt.count);
