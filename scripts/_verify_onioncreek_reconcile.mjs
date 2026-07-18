import { sb } from "./_session_runner.mjs";
const DOW={0:"Sun",1:"Mon",2:"Tue",3:"Wed",4:"Thu",5:"Fri",6:"Sat"};
const dw=(iso)=>DOW[new Date(iso+"T00:00:00Z").getUTCDay()];

// A. Do Jul 4/5 weekend rows exist at all? Search broadly.
console.log("=== A. schedule_master Jul 4 & Jul 5 (ALL venues, to find the '8-10 AM' rows) ===");
const j45 = await sb.from("schedule_master").select("id, match_date, match_time, venue, detail, max_spots, mdapi_field_id")
  .in("match_date",["2026-07-04","2026-07-05"]).order("match_date");
console.log(`  ${j45.data.length} rows total on Jul 4/5:`);
j45.data.forEach(r=>console.log(`  ${r.match_date} ${dw(r.match_date)} "${r.match_time}" venue="${r.venue}" detail="${r.detail}" f=${r.mdapi_field_id} ${r.max_spots}sp id=${r.id}`));
const ocWeekend = j45.data.filter(r=>/onion creek/i.test(r.venue||"")||/onion creek/i.test(r.detail||"")||[27,991].includes(r.mdapi_field_id));
console.log(`\n  => Onion Creek rows on Jul 4/5: ${ocWeekend.length}`);
ocWeekend.forEach(r=>console.log(`     ${r.match_date} "${r.match_time}" id=${r.id}`));

// B. Any Onion Creek AM rows in July at all (8-10 AM style)?
console.log("\n=== B. Onion Creek July rows with AM times (any) ===");
const oc = await sb.from("schedule_master").select("id, match_date, match_time, detail, mdapi_field_id")
  .in("mdapi_field_id",[27,991]).gte("match_date","2026-07-01").lte("match_date","2026-07-31").order("match_date");
const amRows = oc.data.filter(r=>/AM/i.test(r.match_time));
console.log(`  Onion Creek July rows total: ${oc.data.length}, with AM times: ${amRows.length}`);
amRows.forEach(r=>console.log(`  ${r.match_date} ${dw(r.match_date)} "${r.match_time}" detail="${r.detail}" id=${r.id}`));

// C. exact existing Tue/Thu detail values (for Field A/B reconciliation)
console.log("\n=== C. existing Onion Creek Tue/Thu July rows (detail exactness) ===");
oc.data.filter(r=>["Tue","Thu"].includes(dw(r.match_date))).forEach(r=>console.log(`  ${r.match_date} ${dw(r.match_date)} "${r.match_time}" detail="${r.detail}" f=${r.mdapi_field_id} id=${r.id}`));
console.log(`\n  distinct details among existing July OC rows: ${JSON.stringify([...new Set(oc.data.map(r=>r.detail))])}`);
