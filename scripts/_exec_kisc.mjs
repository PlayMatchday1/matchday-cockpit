import { sb } from "./_session_runner.mjs";
const HALT=(m)=>{console.log("\n*** HALT ***\n"+m);process.exit(1);};
const parseHHMM=(t)=>{const m=/^\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?/i.exec(t);let h=+m[1];const mi=m[2]?+m[2]:0;const ap=(m[3]||"").toUpperCase();if(ap==="PM"&&h<12)h+=12;if(ap==="AM"&&h===12)h=0;return `${String(h).padStart(2,"0")}:${String(mi).padStart(2,"0")}`;};

const pre=await sb.from("schedule_master").select("*",{count:"exact",head:true});
if (pre.count!==2232) HALT(`pre-count ${pre.count} != 2232. Aborting.`);

const dates=["2026-07-03","2026-07-07","2026-07-10","2026-07-14","2026-07-17","2026-07-21","2026-07-24","2026-07-28","2026-07-31"];
const rows=dates.map(d=>({city:"Houston",venue:"KISC (Katy Intl)",detail:"Katy International Sports Complex",match_date:d,match_time:"8:00 PM - 9:00 PM",max_spots:16,mdapi_field_id:1156}));
if (rows.length!==9) HALT("rows != 9");
if (rows.some(r=>r.max_spots!==16)) HALT("all rows must be 16 spots");

const existing=await sb.from("schedule_master").select("match_date, match_time").eq("mdapi_field_id",1156).gte("match_date","2026-07-01").lte("match_date","2026-07-31");
const exKeys=new Set((existing.data||[]).map(s=>`${s.match_date}|${parseHHMM(s.match_time)}`));
const collide=rows.filter(r=>exKeys.has(`${r.match_date}|${parseHHMM(r.match_time)}`));
if (collide.length) HALT(`dedup found ${collide.length} collisions. Aborting.`);
console.log("dedup: 0 collisions, inserting 9 at 16 spots.");

const ins=await sb.from("schedule_master").insert(rows).select("id, city, venue, detail, match_date, match_time, max_spots, mdapi_field_id");
if (ins.error) HALT("insert failed: "+ins.error.message);
if (ins.data.length!==9) HALT(`returned ${ins.data.length} != 9. Investigate before audit.`);
console.log("schedule_master insert OK: 9 rows.");

const audit=ins.data.map(r=>({row_id:r.id, action:"create", user_email:"rmancuso@playmatchday.com", old_values:null,
  new_values:{id:r.id,city:r.city,venue:r.venue,detail:r.detail,match_date:r.match_date,match_time:r.match_time,max_spots:r.max_spots,mdapi_field_id:r.mdapi_field_id}}));
const aud=await sb.from("schedule_master_audit").insert(audit).select("id");
if (aud.error) HALT(`audit insert failed: ${aud.error.message}. schedule_master rows ARE written; audit incomplete.`);
if (aud.data.length!==9) HALT(`audit ${aud.data.length} != 9`);
console.log("schedule_master_audit insert OK: 9 rows.");

const ver=await sb.from("schedule_master").select("match_date, match_time, max_spots").eq("mdapi_field_id",1156).gte("match_date","2026-07-01").lte("match_date","2026-07-31").order("match_date");
console.log(`\n=== VERIFICATION — KISC (field 1156) July rows: ${ver.data.length} ===`);
ver.data.forEach(r=>console.log(`  ${r.match_date}  "${r.match_time}"  ${r.max_spots}sp`));
const post=await sb.from("schedule_master").select("*",{count:"exact",head:true});
const auditCount=await sb.from("schedule_master_audit").select("*",{count:"exact",head:true}).in("row_id", ins.data.map(r=>r.id));
const allSpots16=ver.data.every(r=>r.max_spots===16);
console.log(`\n  all rows at 16 spots: ${allSpots16}`);
console.log(`  schedule_master total: ${pre.count} -> ${post.count} (expect 2241)`);
console.log(`  audit 'create' rows for these ids: ${auditCount.count} (expect 9)`);

const probs=[];
if (ver.data.length!==9) probs.push(`KISC July rows ${ver.data.length} != 9`);
if (!allSpots16) probs.push("not all 16 spots");
if (post.count!==2241) probs.push(`total ${post.count} != 2241`);
if (auditCount.count!==9) probs.push(`audit ${auditCount.count} != 9`);
if (probs.length) HALT("Post-write mismatch:\n - "+probs.join("\n - "));
console.log("\nALL CHECKS PASSED.");
