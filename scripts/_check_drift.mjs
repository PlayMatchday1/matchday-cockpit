import { sb } from "./_session_runner.mjs";
const a=await sb.from("schedule_master_audit").select("row_id, action, user_email, old_values, created_at").order("created_at",{ascending:false}).limit(6);
console.log("=== 6 most recent audit rows ===");
a.data.forEach(r=>{const ov=r.old_values;console.log(`  ${r.created_at}  ${r.action.padEnd(6)} by=${r.user_email}  ${ov?`${ov.venue} ${ov.match_date} "${ov.match_time}" f=${ov.mdapi_field_id}`:""}`);});
// recent deletes
console.log("\n=== recent 'delete' audit rows ===");
const d=await sb.from("schedule_master_audit").select("row_id, old_values, created_at").eq("action","delete").order("created_at",{ascending:false}).limit(4);
d.data.forEach(r=>{const ov=r.old_values;console.log(`  ${r.created_at}  ${ov?`${ov.venue} ${ov.match_date} "${ov.match_time}" f=${ov.mdapi_field_id}`:"(no old_values)"}`);});
const cnt=await sb.from("schedule_master").select("*",{count:"exact",head:true});
console.log("\ncurrent count:", cnt.count);
