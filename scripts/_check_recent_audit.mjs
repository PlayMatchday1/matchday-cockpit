import { sb } from "./_session_runner.mjs";
// most recent audit rows
const a=await sb.from("schedule_master_audit").select("row_id, action, user_email, old_values, created_at").order("created_at",{ascending:false}).limit(8);
console.log("=== 8 most recent schedule_master_audit rows ===");
a.data.forEach(r=>{
  const ov=r.old_values; const label=ov?`${ov.venue||"?"} ${ov.match_date||"?"} ${ov.match_time||""}`:"";
  console.log(`  ${r.created_at}  ${r.action.padEnd(6)}  by=${r.user_email}  ${label}`);
});
// any delete not by rmancuso, or a delete after the Crossbar batch?
console.log("\n=== all 'delete' audit rows ===");
const d=await sb.from("schedule_master_audit").select("row_id, user_email, old_values, created_at").eq("action","delete").order("created_at",{ascending:false}).limit(10);
d.data.forEach(r=>{const ov=r.old_values;console.log(`  ${r.created_at}  by=${r.user_email}  ${ov?`${ov.venue} ${ov.match_date} "${ov.match_time}" field=${ov.mdapi_field_id}`:"(no old_values)"}`);});
