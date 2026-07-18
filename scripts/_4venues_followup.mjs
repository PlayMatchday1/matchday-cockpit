import { sb } from "./_session_runner.mjs";
const DOW={0:"Sun",1:"Mon",2:"Tue",3:"Wed",4:"Thu",5:"Fri",6:"Sat"};
const dw=(iso)=>DOW[new Date(iso+"T00:00:00Z").getUTCDay()];
// Lou Fusz Mon/Thu June rows: which field_id?
console.log("=== Lou Fusz June Mon/Thu rows with field_id ===");
const lf = await sb.from("schedule_master").select("match_date, match_time, detail, max_spots, mdapi_field_id").in("mdapi_field_id",[664,992]).gte("match_date","2026-06-01").lte("match_date","2026-06-30").order("match_date");
lf.data.filter(r=>["Mon","Thu"].includes(dw(r.match_date))).forEach(r=>console.log(`  ${r.match_date} ${dw(r.match_date)} "${r.match_time}" detail="${r.detail}" ${r.max_spots}sp f=${r.mdapi_field_id}`));
console.log("  field_id distribution (Mon/Thu):", JSON.stringify(lf.data.filter(r=>["Mon","Thu"].includes(dw(r.match_date))).reduce((a,r)=>{a[r.mdapi_field_id]=(a[r.mdapi_field_id]||0)+1;return a;},{})));
// Lou Fusz July existing on 664
console.log("  Lou Fusz (664/992) July existing:", (await sb.from("schedule_master").select("match_date",{count:"exact",head:true}).in("mdapi_field_id",[664,992]).gte("match_date","2026-07-01").lte("match_date","2026-07-31")).count);

// Centennial Commons field 760 ONLY, July
console.log("\n=== Centennial Commons (field 760) July existing ===");
const cc = await sb.from("schedule_master").select("match_date, match_time, detail, max_spots").eq("mdapi_field_id",760).gte("match_date","2026-07-01").lte("match_date","2026-07-31").order("match_date");
console.log(`  ${cc.data.length} rows`); cc.data.forEach(r=>console.log(`  ${r.match_date} ${dw(r.match_date)} "${r.match_time}" detail="${r.detail}" ${r.max_spots}sp`));

// PAC detail distribution June
console.log("\n=== PAC Global June detail/time distribution ===");
const pac = await sb.from("schedule_master").select("match_time, detail, max_spots").eq("mdapi_field_id",1189).gte("match_date","2026-06-01").lte("match_date","2026-06-30");
console.log("  details:", JSON.stringify(pac.data.reduce((a,r)=>{a[r.detail]=(a[r.detail]||0)+1;return a;},{})), "| times:", JSON.stringify([...new Set(pac.data.map(r=>r.match_time))]));

// ATH Katy July Sunday existing (field 892)
console.log("\n=== ATH Katy (892) July Sunday existing ===");
const ak = await sb.from("schedule_master").select("match_date, match_time").eq("mdapi_field_id",892).gte("match_date","2026-07-01").lte("match_date","2026-07-31");
console.log("  July Sunday rows:", ak.data.filter(r=>dw(r.match_date)==="Sun").length, "| any 6 PM rows:", ak.data.filter(r=>/6:00 PM/.test(r.match_time)).length);
