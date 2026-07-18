import { sb } from "./_session_runner.mjs";
const HALT=(m)=>{console.log("\n*** HALT ***\n"+m);process.exit(1);};
const parseHHMM=(t)=>{const m=/^\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?/i.exec(t);let h=+m[1];const mi=m[2]?+m[2]:0;const ap=(m[3]||"").toUpperCase();if(ap==="PM"&&h<12)h+=12;if(ap==="AM"&&h===12)h=0;return `${String(h).padStart(2,"0")}:${String(mi).padStart(2,"0")}`;};

const pre=await sb.from("schedule_master").select("*",{count:"exact",head:true});
if (pre.count!==2150) HALT(`pre-count ${pre.count} != 2150. Aborting.`);

const mk=(d,t)=>({city:"OKC",venue:"Scissortail Park",detail:"Scissortail Park",match_date:d,match_time:t,max_spots:22,mdapi_field_id:1090});
const part1=[mk("2026-07-01","8:00 PM - 9:00 PM"),mk("2026-07-02","7:00 PM - 8:00 PM"),mk("2026-07-05","7:00 PM - 8:00 PM"),mk("2026-07-07","7:00 PM - 8:00 PM"),mk("2026-07-08","8:00 PM - 9:00 PM")];
const part2=["2026-07-09","2026-07-12","2026-07-14","2026-07-16","2026-07-19","2026-07-21","2026-07-23","2026-07-26","2026-07-28","2026-07-30"].map(d=>mk(d,"8:00 PM - 9:00 PM"));
const rows=[...part1,...part2];
if (rows.length!==15) HALT("rows != 15");
if (rows.some(r=>r.max_spots!==22)) HALT("all rows must be 22 spots");

// dedup guard
const existing=await sb.from("schedule_master").select("match_date, match_time").eq("mdapi_field_id",1090).gte("match_date","2026-07-01").lte("match_date","2026-07-31");
const exKeys=new Set((existing.data||[]).map(s=>`${s.match_date}|${parseHHMM(s.match_time)}`));
const collide=rows.filter(r=>exKeys.has(`${r.match_date}|${parseHHMM(r.match_time)}`));
if (collide.length) HALT(`dedup found ${collide.length} collisions. Aborting.\n`+JSON.stringify(collide.map(c=>`${c.match_date} ${c.match_time}`)));
console.log("dedup: 0 collisions, inserting 15.");

const ins=await sb.from("schedule_master").insert(rows).select("id, city, venue, detail, match_date, match_time, max_spots, mdapi_field_id");
if (ins.error) HALT("insert failed: "+ins.error.message);
if (ins.data.length!==15) HALT(`expected 15 rows, got ${ins.data.length}. Investigate before audit.`);
console.log("schedule_master insert OK: 15 rows.");

const audit=ins.data.map(r=>({row_id:r.id, action:"create", user_email:"rmancuso@playmatchday.com", old_values:null,
  new_values:{id:r.id,city:r.city,venue:r.venue,detail:r.detail,match_date:r.match_date,match_time:r.match_time,max_spots:r.max_spots,mdapi_field_id:r.mdapi_field_id}}));
const aud=await sb.from("schedule_master_audit").insert(audit).select("id");
if (aud.error) HALT(`audit insert failed: ${aud.error.message}. schedule_master rows ARE written; audit incomplete.`);
if (aud.data.length!==15) HALT(`expected 15 audit rows, got ${aud.data.length}`);
console.log("schedule_master_audit insert OK: 15 rows.");

// verification
const ver=await sb.from("schedule_master").select("match_date, match_time, max_spots").eq("mdapi_field_id",1090).gte("match_date","2026-07-01").lte("match_date","2026-07-31").order("match_date");
console.log(`\n=== VERIFICATION — Scissortail (field 1090) July rows: ${ver.data.length} ===`);
ver.data.forEach(r=>console.log(`  ${r.match_date}  "${r.match_time}"  ${r.max_spots}sp`));
const post=await sb.from("schedule_master").select("*",{count:"exact",head:true});
const auditCount=await sb.from("schedule_master_audit").select("*",{count:"exact",head:true}).in("row_id", ins.data.map(r=>r.id));
console.log(`\n  schedule_master total: ${pre.count} -> ${post.count} (expect 2165)`);
console.log(`  audit 'create' rows for these ids: ${auditCount.count} (expect 15)`);
const allSpots22 = ver.data.every(r=>r.max_spots===22);
console.log(`  all field-1090 July rows at 22 spots: ${allSpots22}`);

const probs=[];
if (ver.data.length!==15) probs.push(`field-1090 July rows ${ver.data.length} != 15`);
if (post.count!==2165) probs.push(`total ${post.count} != 2165`);
if (auditCount.count!==15) probs.push(`audit ${auditCount.count} != 15`);
if (!allSpots22) probs.push("not all rows at 22 spots");
if (probs.length) HALT("Post-write mismatch:\n - "+probs.join("\n - "));
console.log("\nALL CHECKS PASSED.");
