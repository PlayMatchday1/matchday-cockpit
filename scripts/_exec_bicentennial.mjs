import { sb } from "./_session_runner.mjs";
const HALT=(m)=>{console.log("\n*** HALT ***\n"+m);process.exit(1);};
const parseHHMM=(t)=>{const m=/^\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?/i.exec(t);let h=+m[1];const mi=m[2]?+m[2]:0;const ap=(m[3]||"").toUpperCase();if(ap==="PM"&&h<12)h+=12;if(ap==="AM"&&h===12)h=0;return `${String(h).padStart(2,"0")}:${String(mi).padStart(2,"0")}`;};

const pre=await sb.from("schedule_master").select("*",{count:"exact",head:true});
if (pre.count!==2134) HALT(`pre-count ${pre.count} != 2134. Aborting.`);

const dates=["2026-07-12","2026-07-14","2026-07-19","2026-07-21","2026-07-26","2026-07-28"];
const rows=dates.map(d=>({city:"Dallas",venue:"Bicentennial Park",detail:"Bicentennial Park",match_date:d,match_time:"7:00 PM - 8:00 PM",max_spots:18,mdapi_field_id:628}));
if (rows.length!==6) HALT("rows != 6");

// dedup guard (HALT if any of the 6 already exist)
const existing=await sb.from("schedule_master").select("match_date, match_time").eq("mdapi_field_id",628).gte("match_date","2026-07-01").lte("match_date","2026-07-31");
const exKeys=new Set((existing.data||[]).map(s=>`${s.match_date}|${parseHHMM(s.match_time)}`));
const collide=rows.filter(r=>exKeys.has(`${r.match_date}|${parseHHMM(r.match_time)}`));
if (collide.length) HALT(`dedup found ${collide.length} collisions. Aborting.\n`+JSON.stringify(collide.map(c=>c.match_date)));
console.log("dedup: 0 collisions among the 6, inserting.");

const ins=await sb.from("schedule_master").insert(rows).select("id, city, venue, detail, match_date, match_time, max_spots, mdapi_field_id");
if (ins.error) HALT("insert failed: "+ins.error.message);
if (ins.data.length!==6) HALT(`expected 6 rows, got ${ins.data.length}. Investigate before audit.`);
console.log("schedule_master insert OK: 6 rows.");

const audit=ins.data.map(r=>({row_id:r.id, action:"create", user_email:"rmancuso@playmatchday.com", old_values:null,
  new_values:{id:r.id,city:r.city,venue:r.venue,detail:r.detail,match_date:r.match_date,match_time:r.match_time,max_spots:r.max_spots,mdapi_field_id:r.mdapi_field_id}}));
const aud=await sb.from("schedule_master_audit").insert(audit).select("id");
if (aud.error) HALT(`audit insert failed: ${aud.error.message}. schedule_master rows ARE written; audit incomplete.`);
if (aud.data.length!==6) HALT(`expected 6 audit rows, got ${aud.data.length}`);
console.log("schedule_master_audit insert OK: 6 rows.");

// verification: all field-628 July rows (should now be 9: 3 pre-existing + 6 new)
const ver=await sb.from("schedule_master").select("match_date, match_time, max_spots").eq("mdapi_field_id",628).gte("match_date","2026-07-01").lte("match_date","2026-07-31").order("match_date");
console.log(`\n=== VERIFICATION — Bicentennial Park (field 628) July rows: ${ver.data.length} ===`);
ver.data.forEach(r=>console.log(`  ${r.match_date}  "${r.match_time}"  ${r.max_spots}sp`));
const post=await sb.from("schedule_master").select("*",{count:"exact",head:true});
const auditCount=await sb.from("schedule_master_audit").select("*",{count:"exact",head:true}).in("row_id", ins.data.map(r=>r.id));
console.log(`\n  schedule_master total: ${pre.count} -> ${post.count} (expect 2140)`);
console.log(`  audit 'create' rows for these ids: ${auditCount.count} (expect 6)`);
// confirm Jul 10 untouched
const jul10=ver.data.find(r=>r.match_date==="2026-07-10");
console.log(`  Jul 10 Friday row still present, untouched: ${jul10?`yes ("${jul10.match_time}")`:"MISSING!"}`);

const probs=[];
if (ver.data.length!==9) probs.push(`field-628 July rows ${ver.data.length} != 9`);
if (post.count!==2140) probs.push(`total ${post.count} != 2140`);
if (auditCount.count!==6) probs.push(`audit ${auditCount.count} != 6`);
if (!jul10) probs.push("Jul 10 row disappeared");
if (probs.length) HALT("Post-write mismatch:\n - "+probs.join("\n - "));
console.log("\nALL CHECKS PASSED.");
