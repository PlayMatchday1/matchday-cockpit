import { sb } from "./_session_runner.mjs";
const HALT=(m)=>{console.log("\n*** HALT ***\n"+m);process.exit(1);};
const DOW={0:"Sun",1:"Mon",2:"Tue",3:"Wed",4:"Thu",5:"Fri",6:"Sat"};
const dw=(iso)=>DOW[new Date(iso+"T00:00:00Z").getUTCDay()];
const parseHHMM=(t)=>{const m=/^\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?/i.exec(t);let h=+m[1];const mi=m[2]?+m[2]:0;const ap=(m[3]||"").toUpperCase();if(ap==="PM"&&h<12)h+=12;if(ap==="AM"&&h===12)h=0;return `${String(h).padStart(2,"0")}:${String(mi).padStart(2,"0")}`;};
const pick=(r)=>({id:r.id,city:r.city,venue:r.venue,detail:r.detail,match_date:r.match_date,match_time:r.match_time,max_spots:r.max_spots,mdapi_field_id:r.mdapi_field_id});

const pre=await sb.from("schedule_master").select("*",{count:"exact",head:true});
if (pre.count!==2273) HALT(`pre-count ${pre.count} != 2273. Aborting.`);

// ===== PART 1: relabel existing 9 Tue/Thu "Onion Creek" -> "Onion Creek - Field A" =====
const existing = await sb.from("schedule_master").select("*").eq("mdapi_field_id",27).eq("detail","Onion Creek")
  .gte("match_date","2026-07-01").lte("match_date","2026-07-31").order("match_date");
if (existing.error) HALT("fetch existing failed: "+existing.error.message);
if (existing.data.length!==9) HALT(`expected 9 existing "Onion Creek" field-27 July rows, found ${existing.data.length}`);
if (!existing.data.every(r=>["Tue","Thu"].includes(dw(r.match_date)))) HALT("some existing rows are not Tue/Thu");
const updAudit=[];
for (const row of existing.data){
  const oldVals=pick(row);
  const upd=await sb.from("schedule_master").update({detail:"Onion Creek - Field A", updated_at:new Date().toISOString()}).eq("id",row.id).select("*");
  if (upd.error) HALT(`update failed ${row.id}: ${upd.error.message}`);
  if (upd.data.length!==1) HALT(`update affected ${upd.data.length} rows for ${row.id}`);
  updAudit.push({row_id:row.id, action:"update", user_email:"rmancuso@playmatchday.com", old_values:oldVals, new_values:pick(upd.data[0])});
}
console.log(`Part 1: relabeled ${existing.data.length} rows -> "Onion Creek - Field A"`);
const ua=await sb.from("schedule_master_audit").insert(updAudit).select("id");
if (ua.error||ua.data.length!==9) HALT(`update audit failed/count: ${ua.error?.message} got ${ua.data?.length}`);
console.log("Part 1: 9 update audit rows written.");

// ===== PART 2: INSERT 25 =====
const mk=(d,detail,time)=>({city:"Austin",venue:"Onion Creek",detail,match_date:d,match_time:time,max_spots:22,mdapi_field_id:27});
const PM="7:00 PM - 8:00 PM", AM="9:00 AM - 10:00 AM";
const fieldB=["2026-07-02","2026-07-07","2026-07-09","2026-07-14","2026-07-16","2026-07-21","2026-07-23","2026-07-28","2026-07-30"].map(d=>mk(d,"Onion Creek - Field B",PM));
const mon=["2026-07-13","2026-07-20","2026-07-27"].map(d=>mk(d,"Onion Creek",PM));
const wed=["2026-07-01","2026-07-08","2026-07-15","2026-07-22","2026-07-29"].map(d=>mk(d,"Onion Creek",PM));
const fri=["2026-07-03","2026-07-10","2026-07-17","2026-07-24","2026-07-31"].map(d=>mk(d,"Onion Creek",PM));
const wknd=["2026-07-11","2026-07-12","2026-07-25"].map(d=>mk(d,"Onion Creek",AM));
const rows=[...fieldB,...mon,...wed,...fri,...wknd];
if (rows.length!==25) HALT(`built ${rows.length} rows != 25`);

// detail-aware dedup guard
const cur = await sb.from("schedule_master").select("match_date, match_time, detail, mdapi_field_id").eq("mdapi_field_id",27).gte("match_date","2026-07-01").lte("match_date","2026-07-31");
const exKeys=new Set((cur.data||[]).map(s=>`${s.mdapi_field_id}|${s.match_date}|${parseHHMM(s.match_time)}|${s.detail}`));
const collide=rows.filter(r=>exKeys.has(`${r.mdapi_field_id}|${r.match_date}|${parseHHMM(r.match_time)}|${r.detail}`));
if (collide.length) HALT(`dedup found ${collide.length} collisions. Aborting.\n`+JSON.stringify(collide.map(c=>`${c.match_date} ${c.match_time} ${c.detail}`)));
console.log("Part 2 dedup (field|date|HH:MM|detail): 0 collisions.");

const ins=await sb.from("schedule_master").insert(rows).select("id, city, venue, detail, match_date, match_time, max_spots, mdapi_field_id");
if (ins.error) HALT("insert failed: "+ins.error.message);
if (ins.data.length!==25) HALT(`returned ${ins.data.length} != 25`);
console.log("Part 2: 25 rows inserted.");
const cAudit=ins.data.map(r=>({row_id:r.id, action:"create", user_email:"rmancuso@playmatchday.com", old_values:null, new_values:pick(r)}));
const ca=await sb.from("schedule_master_audit").insert(cAudit).select("id");
if (ca.error||ca.data.length!==25) HALT(`create audit failed/count: ${ca.error?.message} got ${ca.data?.length}`);
console.log("Part 2: 25 create audit rows written.");

// ===== VERIFICATION =====
const ver=await sb.from("schedule_master").select("detail, match_date").eq("mdapi_field_id",27).gte("match_date","2026-07-01").lte("match_date","2026-07-31");
const byDetail={}; ver.data.forEach(r=>byDetail[r.detail]=(byDetail[r.detail]||0)+1);
const post=await sb.from("schedule_master").select("*",{count:"exact",head:true});
console.log("\n=== VERIFICATION ===");
console.log("  Onion Creek (field 27) July rows by detail:", JSON.stringify(byDetail));
console.log(`  total OC July rows: ${ver.data.length} (expect 34)`);
console.log(`  schedule_master total: ${pre.count} -> ${post.count} (expect 2298)`);
console.log(`  updates: 9, inserts: 25`);

const probs=[];
if (byDetail["Onion Creek - Field A"]!==9) probs.push(`Field A ${byDetail["Onion Creek - Field A"]} != 9`);
if (byDetail["Onion Creek - Field B"]!==9) probs.push(`Field B ${byDetail["Onion Creek - Field B"]} != 9`);
if (byDetail["Onion Creek"]!==16) probs.push(`Onion Creek ${byDetail["Onion Creek"]} != 16`);
if (ins.data.length!==25) probs.push(`insert ${ins.data.length} != 25`);
if (post.count!==2298) probs.push(`post-count ${post.count} != 2298`);
if (probs.length) HALT("mismatch:\n - "+probs.join("\n - "));
console.log("\nALL CHECKS PASSED.");
