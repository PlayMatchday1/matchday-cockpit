import { sb } from "./_session_runner.mjs";
const HALT=(m)=>{console.log("\n*** HALT ***\n"+m);process.exit(1);};
const pick=(r)=>({id:r.id,city:r.city,venue:r.venue,detail:r.detail,match_date:r.match_date,match_time:r.match_time,max_spots:r.max_spots,mdapi_field_id:r.mdapi_field_id});

const pre=await sb.from("schedule_master").select("*",{count:"exact",head:true});
if (pre.count!==2140) HALT(`pre-count ${pre.count} != 2140 (inserts should be done). Aborting.`);

// locate the Jul 10 Fri row at field 628
const target=await sb.from("schedule_master").select("*").eq("mdapi_field_id",628).eq("match_date","2026-07-10");
if (target.error) HALT("fetch failed: "+target.error.message);
if (target.data.length!==1) HALT(`expected exactly 1 Jul-10 row at field 628, found ${target.data.length}: `+JSON.stringify(target.data.map(pick)));
const row=target.data[0];
console.log("target row:", JSON.stringify(pick(row)));

// verify justification: no ALIVE mdapi match on Jul 10 field 628
const mm=await sb.from("mdapi_matches").select("start_date, is_cancelled, deleted_at")
  .eq("field_id",628).gte("start_date","2026-07-10T00:00:00Z").lt("start_date","2026-07-11T00:00:00Z");
const alive=(mm.data||[]).filter(m=>!m.is_cancelled && !m.deleted_at);
console.log(`mdapi field 628 on Jul 10: ${mm.data.length} total, ${alive.length} alive.`);
(mm.data||[]).forEach(m=>console.log(`  ${m.start_date} cancelled=${m.is_cancelled} deleted_at=${m.deleted_at}`));
if (alive.length>0) HALT(`Jul 10 has ${alive.length} ALIVE mdapi match(es) at field 628 — contradicts "leftover, no match in MatchDay". NOT deleting. Please re-confirm.`);
console.log("=> confirmed: no alive mdapi match on Jul 10 (leftover). Proceeding with delete.");

// delete audit FIRST would orphan; standard: delete row, write audit with old_values
const del=await sb.from("schedule_master").delete().eq("id",row.id).select("id");
if (del.error) HALT("delete failed: "+del.error.message);
if (del.data.length!==1) HALT(`delete affected ${del.data.length} rows (expected 1)!`);
console.log("deleted 1 row:", row.id);

const aud=await sb.from("schedule_master_audit").insert({row_id:row.id, action:"delete", user_email:"rmancuso@playmatchday.com", old_values:pick(row), new_values:null}).select("id");
if (aud.error) HALT(`delete-audit insert failed: ${aud.error.message}. ROW IS DELETED; audit missing.`);
console.log("delete audit row written:", aud.data[0].id);

// verification
const post=await sb.from("schedule_master").select("*",{count:"exact",head:true});
const ver=await sb.from("schedule_master").select("match_date, match_time").eq("mdapi_field_id",628).gte("match_date","2026-07-01").lte("match_date","2026-07-31").order("match_date");
console.log(`\n=== VERIFICATION — Bicentennial (field 628) July rows: ${ver.data.length} ===`);
ver.data.forEach(r=>console.log(`  ${r.match_date}  "${r.match_time}"`));
const jul10gone=!ver.data.some(r=>r.match_date==="2026-07-10");
console.log(`\n  Jul 10 removed: ${jul10gone}`);
console.log(`  schedule_master total: ${pre.count} -> ${post.count} (expect 2139)`);

const probs=[];
if (!jul10gone) probs.push("Jul 10 still present");
if (ver.data.length!==8) probs.push(`field-628 July rows ${ver.data.length} != 8`);
if (post.count!==2139) probs.push(`total ${post.count} != 2139`);
if (probs.length) HALT("mismatch:\n - "+probs.join("\n - "));
console.log("\nALL CHECKS PASSED.");
