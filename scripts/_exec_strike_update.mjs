import { sb } from "./_session_runner.mjs";
const HALT=(m)=>{console.log("\n*** HALT ***\n"+m);process.exit(1);};
const pick=(r)=>({id:r.id,city:r.city,venue:r.venue,detail:r.detail,match_date:r.match_date,match_time:r.match_time,max_spots:r.max_spots,mdapi_field_id:r.mdapi_field_id});

const pre=await sb.from("schedule_master").select("*",{count:"exact",head:true});
if (pre.count!==2134) HALT(`pre-count ${pre.count} != 2134. Aborting.`);

const updates=[
  {id:"2df24f92-3ed8-4577-8008-69c61e0403e1", newTime:"9:00 PM - 10:00 PM", date:"2026-07-13"},
  {id:"660b7f04-d030-4269-b894-2d41443bd56c", newTime:"9:00 PM - 10:00 PM", date:"2026-07-20"},
  {id:"f656cb4a-98d2-4bf7-930e-466c89d4a06a", newTime:"8:00 PM - 9:00 PM",  date:"2026-07-30"},
];
const auditRows=[];
for (const u of updates){
  // capture true old value
  const cur=await sb.from("schedule_master").select("*").eq("id",u.id);
  if (cur.error) HALT("fetch failed for "+u.id+": "+cur.error.message);
  if (cur.data.length!==1) HALT(`expected 1 row for ${u.id}, got ${cur.data.length}`);
  const oldRow=cur.data[0];
  if (oldRow.mdapi_field_id!==1387 || oldRow.match_date!==u.date) HALT(`row ${u.id} mismatch: field=${oldRow.mdapi_field_id} date=${oldRow.match_date}`);
  const oldVals=pick(oldRow);
  // update, targeted by id, return updated row
  const upd=await sb.from("schedule_master").update({match_time:u.newTime, updated_at:new Date().toISOString()}).eq("id",u.id).select("*");
  if (upd.error) HALT(`update failed for ${u.id}: ${upd.error.message}`);
  if (upd.data.length!==1) HALT(`update affected ${upd.data.length} rows for ${u.id} (expected 1)!`);
  const newVals=pick(upd.data[0]);
  if (newVals.match_time!==u.newTime) HALT(`post-update match_time is "${newVals.match_time}", expected "${u.newTime}"`);
  auditRows.push({row_id:u.id, action:"update", user_email:"rmancuso@playmatchday.com", old_values:oldVals, new_values:newVals});
  console.log(`updated ${u.date} (${u.id}): "${oldRow.match_time.replace(/\n/g,'\\n')}" -> "${newVals.match_time}"`);
}

const aud=await sb.from("schedule_master_audit").insert(auditRows).select("id");
if (aud.error) HALT(`audit insert failed: ${aud.error.message}. Rows ARE updated; audit incomplete.`);
if (aud.data.length!==3) HALT(`expected 3 audit rows, got ${aud.data.length}`);
console.log(`\naudit 'update' rows inserted: ${aud.data.length}`);

// verification
const ver=await sb.from("schedule_master").select("match_date, match_time, max_spots")
  .in("id", updates.map(u=>u.id)).order("match_date");
console.log("\n=== VERIFICATION (the 3 updated rows) ===");
ver.data.forEach(r=>console.log(`  ${r.match_date}  "${r.match_time}"  ${r.max_spots}sp`));
const post=await sb.from("schedule_master").select("*",{count:"exact",head:true});
console.log(`\n  schedule_master total: ${pre.count} -> ${post.count} (expect unchanged 2134)`);

const expect={"2026-07-13":"9:00 PM - 10:00 PM","2026-07-20":"9:00 PM - 10:00 PM","2026-07-30":"8:00 PM - 9:00 PM"};
const probs=[];
for (const r of ver.data){ if (r.match_time!==expect[r.match_date]) probs.push(`${r.match_date} is "${r.match_time}", expected "${expect[r.match_date]}"`); }
if (post.count!==2134) probs.push(`count ${post.count} != 2134`);
if (probs.length) HALT("Mismatch:\n - "+probs.join("\n - "));
console.log("\nALL CHECKS PASSED.");
