import { sb } from "./_session_runner.mjs";
const DOW={0:"Sun",1:"Mon",2:"Tue",3:"Wed",4:"Thu",5:"Fri",6:"Sat"};
const dw=(iso)=>DOW[new Date(iso+"T00:00:00Z").getUTCDay()];

// 1. ALL ATH Katy rows in July (any field, any venue spelling)
console.log("=== (1) ALL schedule_master ATH Katy July rows (venue/detail ilike, or field 892) ===");
const ak = await sb.from("schedule_master").select("id, match_date, match_time, venue, detail, max_spots, mdapi_field_id")
  .or("venue.ilike.%ath katy%,detail.ilike.%ath katy%,mdapi_field_id.eq.892").gte("match_date","2026-07-01").lte("match_date","2026-07-31").order("match_date");
console.log(`  ${ak.data.length} rows`);
ak.data.forEach(r=>console.log(`  ${r.match_date} ${dw(r.match_date)} "${r.match_time}" venue="${r.venue}" detail="${r.detail}" ${r.max_spots}sp f=${r.mdapi_field_id}`));
console.log("  Sunday rows:", ak.data.filter(r=>dw(r.match_date)==="Sun").length, "| 6:00 PM rows:", ak.data.filter(r=>/6:00 PM/.test(r.match_time)).length);

// 2. What DOES have 6:00 PM on Jul 5/12/19? (to find what the user may be thinking of)
console.log("\n=== (2) ALL schedule_master rows at 6:00 PM on Jul 5/12/19 (any venue) ===");
const six = await sb.from("schedule_master").select("match_date, match_time, venue, detail, max_spots, mdapi_field_id")
  .in("match_date",["2026-07-05","2026-07-12","2026-07-19"]).ilike("match_time","%6:00 PM%").order("match_date");
console.log(`  ${six.data.length} rows`);
six.data.forEach(r=>console.log(`  ${r.match_date} ${dw(r.match_date)} "${r.match_time}" venue="${r.venue}" detail="${r.detail}" f=${r.mdapi_field_id}`));

// 3. ATH Katy fin_venues spots re-confirm
console.log("\n=== (3) ATH Katy fin_venues spots ===");
const fv = await sb.from("fin_venues").select("id, venue_name, max_spots, per_match_rate").in("id",[7,23]);
fv.data.forEach(v=>console.log(`  #${v.id} "${v.venue_name}" max_spots=${v.max_spots} rate=${v.per_match_rate}`));
