import { sb } from "./_session_runner.mjs";
const HALT=(m)=>{console.log("\n*** HALT ***\n"+m);process.exit(1);};
const parseHHMM=(t)=>{const m=/^\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?/i.exec(t);let h=+m[1];const mi=m[2]?+m[2]:0;const ap=(m[3]||"").toUpperCase();if(ap==="PM"&&h<12)h+=12;if(ap==="AM"&&h===12)h=0;return `${String(h).padStart(2,"0")}:${String(mi).padStart(2,"0")}`;};

const pre=await sb.from("schedule_master").select("*",{count:"exact",head:true});
if (pre.count!==2131) HALT(`pre-count ${pre.count} != 2131. Aborting.`);

const rows=[
  {city:"Austin",venue:"Hattrick",detail:"The Hattrick",match_date:"2026-07-11",match_time:"7:00 PM - 8:00 PM",max_spots:18,mdapi_field_id:1024},
  {city:"Austin",venue:"Hattrick",detail:"The Hattrick",match_date:"2026-07-18",match_time:"7:00 PM - 8:00 PM",max_spots:18,mdapi_field_id:1024},
  {city:"Austin",venue:"Hattrick",detail:"The Hattrick",match_date:"2026-07-25",match_time:"7:00 PM - 8:00 PM",max_spots:18,mdapi_field_id:1024},
];

// dedup guard
const existing=await sb.from("schedule_master").select("match_date, match_time, mdapi_field_id")
  .eq("mdapi_field_id",1024).gte("match_date","2026-07-01").lte("match_date","2026-07-31");
const exKeys=new Set((existing.data||[]).map(s=>`${s.match_date}|${parseHHMM(s.match_time)}`));
const collide=rows.filter(r=>exKeys.has(`${r.match_date}|${parseHHMM(r.match_time)}`));
if (collide.length) HALT(`dedup found ${collide.length} existing rows. Aborting.\n`+JSON.stringify(collide));
console.log("dedup: 0 collisions, inserting 3.");

const ins=await sb.from("schedule_master").insert(rows).select("id, city, venue, detail, match_date, match_time, max_spots, mdapi_field_id");
if (ins.error) HALT("schedule_master insert failed: "+ins.error.message);
if (ins.data.length!==3) HALT(`expected 3 rows, got ${ins.data.length}. Investigate before audit.`);
console.log("schedule_master insert OK: 3 rows.");

const audit=ins.data.map(r=>({row_id:r.id, action:"create", user_email:"rmancuso@playmatchday.com", old_values:null,
  new_values:{id:r.id,city:r.city,venue:r.venue,detail:r.detail,match_date:r.match_date,match_time:r.match_time,max_spots:r.max_spots,mdapi_field_id:r.mdapi_field_id}}));
const aud=await sb.from("schedule_master_audit").insert(audit).select("id");
if (aud.error) HALT(`audit insert failed: ${aud.error.message}. schedule_master rows ARE written; audit incomplete.`);
if (aud.data.length!==3) HALT(`expected 3 audit rows, got ${aud.data.length}.`);
console.log("schedule_master_audit insert OK: 3 rows.");

const ver=await sb.from("schedule_master").select("match_date, match_time, max_spots")
  .eq("mdapi_field_id",1024).gte("match_date","2026-07-01").lte("match_date","2026-07-31").order("match_date");
const post=await sb.from("schedule_master").select("*",{count:"exact",head:true});
const auditCount=await sb.from("schedule_master_audit").select("*",{count:"exact",head:true}).in("row_id", ins.data.map(r=>r.id));
console.log("\n=== VERIFICATION — Hattrick (field 1024) July rows ===");
ver.data.forEach(r=>console.log(`  ${r.match_date}  ${r.match_time}  ${r.max_spots}sp`));
console.log(`\n  schedule_master total: ${pre.count} -> ${post.count} (expect 2134)`);
console.log(`  audit 'create' rows for these ids: ${auditCount.count} (expect 3)`);

const probs=[];
if (ver.data.length!==3) probs.push(`hattrick ${ver.data.length}!=3`);
if (post.count!==2134) probs.push(`total ${post.count}!=2134`);
if (auditCount.count!==3) probs.push(`audit ${auditCount.count}!=3`);
if (probs.length) HALT("Post-write mismatch:\n - "+probs.join("\n - "));
console.log("\nALL CHECKS PASSED.");
