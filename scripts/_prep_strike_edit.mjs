import { sb } from "./_session_runner.mjs";
const startOf=(t)=>t.split(" - ")[0].trim();

// distinct audit actions already used (confirm update/delete allowed)
const aud = await sb.from("schedule_master_audit").select("action").limit(2000);
console.log("distinct audit actions in use:", JSON.stringify([...new Set((aud.data||[]).map(a=>a.action))].sort()));

// fetch all field 1387 July rows, full values
const sm = await sb.from("schedule_master").select("*").eq("mdapi_field_id",1387)
  .gte("match_date","2026-07-01").lte("match_date","2026-07-31").order("match_date");
const targets = {
  update: [["2026-07-13","8:00 PM"],["2026-07-20","8:00 PM"],["2026-07-30","9:00 PM"]],
  delete: [["2026-07-06","8:00 PM"],["2026-07-07","8:00 PM"]],
};
function findRows(d,startTime){ return sm.data.filter(r=>r.match_date===d && startOf(r.match_time)===startTime); }

console.log("\n=== UPDATE targets ===");
for (const [d,st] of targets.update){
  const rows=findRows(d,st);
  console.log(`  ${d} ${st}: ${rows.length} row(s)`);
  rows.forEach(r=>console.log("    "+JSON.stringify({id:r.id,city:r.city,venue:r.venue,detail:r.detail,match_date:r.match_date,match_time:r.match_time,max_spots:r.max_spots,mdapi_field_id:r.mdapi_field_id})));
  if (rows.length!==1) console.log("    *** WARNING: expected exactly 1 row ***");
}
console.log("\n=== DELETE targets ===");
for (const [d,st] of targets.delete){
  const rows=findRows(d,st);
  console.log(`  ${d} ${st}: ${rows.length} row(s)`);
  rows.forEach(r=>console.log("    "+JSON.stringify({id:r.id,city:r.city,venue:r.venue,detail:r.detail,match_date:r.match_date,match_time:r.match_time,max_spots:r.max_spots,mdapi_field_id:r.mdapi_field_id})));
  if (rows.length!==1) console.log("    *** WARNING: expected exactly 1 row ***");
}
const cnt=await sb.from("schedule_master").select("*",{count:"exact",head:true});
console.log("\nschedule_master current count:", cnt.count, "(expect 2134)");
