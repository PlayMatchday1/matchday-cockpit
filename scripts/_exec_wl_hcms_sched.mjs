import { sb } from "./_session_runner.mjs";
const HALT=(m)=>{console.log("\n*** HALT ***\n"+m);process.exit(1);};
const parseHHMM=(t)=>{const m=/^\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?/i.exec(t);let h=+m[1];const mi=m[2]?+m[2]:0;const ap=(m[3]||"").toUpperCase();if(ap==="PM"&&h<12)h+=12;if(ap==="AM"&&h===12)h=0;return `${String(h).padStart(2,"0")}:${String(mi).padStart(2,"0")}`;};

const pre = await sb.from("schedule_master").select("*",{count:"exact",head:true});
if (pre.count!==2103) HALT(`pre-count ${pre.count} != 2103. Aborting.`);

const T="8:00 PM - 9:00 PM";
const west=["2026-07-04","2026-07-05","2026-07-06","2026-07-08","2026-07-09","2026-07-10","2026-07-11","2026-07-12","2026-07-13","2026-07-15","2026-07-16","2026-07-17","2026-07-18","2026-07-19","2026-07-20","2026-07-22","2026-07-23","2026-07-24","2026-07-25","2026-07-26","2026-07-27","2026-07-29","2026-07-30","2026-07-31"];
const hcms=["2026-07-07","2026-07-14","2026-07-21","2026-07-28"];
if (west.length!==24||hcms.length!==4) HALT(`bad counts west=${west.length} hcms=${hcms.length}`);

const rows=[
  ...west.map(d=>({city:"Austin",venue:"Westlake",detail:"Westlake HS Field 3",match_date:d,match_time:T,max_spots:36,mdapi_field_id:1})),
  ...hcms.map(d=>({city:"Austin",venue:"Hill Country Middle School",detail:"Hill Country Middle School",match_date:d,match_time:T,max_spots:18,mdapi_field_id:1453})),
];
if (rows.length!==28) HALT("rows != 28");

// dedup guard (HALT if any exist)
const existing = await sb.from("schedule_master").select("match_date, match_time, mdapi_field_id")
  .in("mdapi_field_id",[1,1453]).gte("match_date","2026-07-01").lte("match_date","2026-07-31");
const exKeys=new Set((existing.data||[]).map(s=>`${s.mdapi_field_id}|${s.match_date}|${parseHHMM(s.match_time)}`));
const collide=rows.filter(r=>exKeys.has(`${r.mdapi_field_id}|${r.match_date}|${parseHHMM(r.match_time)}`));
if (collide.length) HALT(`dedup found ${collide.length} existing rows on these dates/fields. Aborting.\n`+JSON.stringify(collide));
console.log("dedup: 0 collisions, inserting 28.");

const ins=await sb.from("schedule_master").insert(rows).select("id, city, venue, detail, match_date, match_time, max_spots, mdapi_field_id");
if (ins.error) HALT("schedule_master insert failed: "+ins.error.message);
if (ins.data.length!==28) HALT(`expected 28 rows back, got ${ins.data.length}. Investigate before audit.`);
console.log("schedule_master insert OK: 28 rows.");

const audit=ins.data.map(r=>({row_id:r.id, action:"create", user_email:"rmancuso@playmatchday.com", old_values:null,
  new_values:{id:r.id,city:r.city,venue:r.venue,detail:r.detail,match_date:r.match_date,match_time:r.match_time,max_spots:r.max_spots,mdapi_field_id:r.mdapi_field_id}}));
const aud=await sb.from("schedule_master_audit").insert(audit).select("id");
if (aud.error) HALT(`audit insert failed: ${aud.error.message}. schedule_master rows ARE written; audit incomplete.`);
if (aud.data.length!==28) HALT(`expected 28 audit rows, got ${aud.data.length}.`);
console.log("schedule_master_audit insert OK: 28 rows.");

// verification
const vw=await sb.from("schedule_master").select("*",{count:"exact",head:true}).eq("mdapi_field_id",1).gte("match_date","2026-07-01").lte("match_date","2026-07-31");
const vh=await sb.from("schedule_master").select("*",{count:"exact",head:true}).eq("mdapi_field_id",1453).gte("match_date","2026-07-01").lte("match_date","2026-07-31");
const post=await sb.from("schedule_master").select("*",{count:"exact",head:true});
const auditCount=await sb.from("schedule_master_audit").select("*",{count:"exact",head:true}).in("row_id", ins.data.map(r=>r.id));
console.log(`\n=== VERIFICATION ===`);
console.log(`  Westlake (field 1) July rows:  ${vw.count} (expect 24)`);
console.log(`  HCMS (field 1453) July rows:   ${vh.count} (expect 4)`);
console.log(`  schedule_master total: ${pre.count} -> ${post.count} (expect 2131)`);
console.log(`  audit 'create' rows for these ids: ${auditCount.count} (expect 28)`);

const probs=[];
if (vw.count!==24) probs.push(`westlake ${vw.count}!=24`);
if (vh.count!==4) probs.push(`hcms ${vh.count}!=4`);
if (post.count!==2131) probs.push(`total ${post.count}!=2131`);
if (auditCount.count!==28) probs.push(`audit ${auditCount.count}!=28`);
if (probs.length) HALT("Post-write mismatch:\n - "+probs.join("\n - "));
console.log("\nALL CHECKS PASSED.");
