import { sb } from "./_session_runner.mjs";
const HALT=(m)=>{console.log("\n*** HALT ***\n"+m);process.exit(1);};
const dw=(iso)=>new Date(iso+"T00:00:00Z").getUTCDay();
const parseHHMM=(t)=>{const m=/^\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?/i.exec(t);let h=+m[1];const mi=m[2]?+m[2]:0;const ap=(m[3]||"").toUpperCase();if(ap==="PM"&&h<12)h+=12;if(ap==="AM"&&h===12)h=0;return `${String(h).padStart(2,"0")}:${String(mi).padStart(2,"0")}`;};

const pre=await sb.from("schedule_master").select("*",{count:"exact",head:true});
if (pre.count!==2241) HALT(`pre-count ${pre.count} != 2241. Aborting.`);

// generate pattern, dedup vs existing field-1024 July
const T={7:"7:00 PM - 8:00 PM",8:"8:00 PM - 9:00 PM"};
const PAT={2:[7,8],3:[7,8],5:[7],6:[7],0:[7,8]};
const gen=[];
for(let d=1;d<=31;d++){const iso=`2026-07-${String(d).padStart(2,"0")}`;for(const hr of (PAT[dw(iso)]||[])){gen.push({city:"Austin",venue:"Hattrick",detail:"The Hattrick",match_date:iso,match_time:T[hr],max_spots:18,mdapi_field_id:1024});}}
if (gen.length!==35) HALT(`generated ${gen.length} != 35`);

const existing=await sb.from("schedule_master").select("match_date, match_time").eq("mdapi_field_id",1024).gte("match_date","2026-07-01").lte("match_date","2026-07-31");
const exKeys=new Set((existing.data||[]).map(s=>`${s.match_date}|${parseHHMM(s.match_time)}`));
const rows=gen.filter(r=>!exKeys.has(`${r.match_date}|${parseHHMM(r.match_time)}`));
console.log(`dedup: ${gen.length} generated, ${gen.length-rows.length} skipped (existing), ${rows.length} to insert`);
if (rows.length!==32) HALT(`to-insert ${rows.length} != 32 (existing field-1024 July rows changed?)`);

const ins=await sb.from("schedule_master").insert(rows).select("id, city, venue, detail, match_date, match_time, max_spots, mdapi_field_id");
if (ins.error) HALT("insert failed: "+ins.error.message);
if (ins.data.length!==32) HALT(`returned ${ins.data.length} != 32. Investigate before audit.`);
console.log("schedule_master insert OK: 32 rows.");

const audit=ins.data.map(r=>({row_id:r.id, action:"create", user_email:"rmancuso@playmatchday.com", old_values:null,
  new_values:{id:r.id,city:r.city,venue:r.venue,detail:r.detail,match_date:r.match_date,match_time:r.match_time,max_spots:r.max_spots,mdapi_field_id:r.mdapi_field_id}}));
const aud=await sb.from("schedule_master_audit").insert(audit).select("id");
if (aud.error) HALT(`audit insert failed: ${aud.error.message}. schedule_master rows ARE written; audit incomplete.`);
if (aud.data.length!==32) HALT(`audit ${aud.data.length} != 32`);
console.log("schedule_master_audit insert OK: 32 rows.");

// verification: total field-1024 July should be 35 (3 pre-existing + 32 new)
const ver=await sb.from("schedule_master").select("match_date, match_time, max_spots").eq("mdapi_field_id",1024).gte("match_date","2026-07-01").lte("match_date","2026-07-31");
const wk={}; ver.data.forEach(r=>{const w=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][dw(r.match_date)];wk[w]=(wk[w]||0)+1;});
const post=await sb.from("schedule_master").select("*",{count:"exact",head:true});
const auditCount=await sb.from("schedule_master_audit").select("*",{count:"exact",head:true}).in("row_id", ins.data.map(r=>r.id));
const allSpots18=ver.data.every(r=>r.max_spots===18);
console.log(`\n=== VERIFICATION ===`);
console.log(`  field-1024 July rows total: ${ver.data.length} (expect 35 = 3 existing + 32 new)`);
console.log(`  by weekday: ${JSON.stringify(wk)} (expect Tue8,Wed10,Fri5,Sat4,Sun8)`);
console.log(`  all 18 spots: ${allSpots18}`);
console.log(`  schedule_master total: ${pre.count} -> ${post.count} (expect 2273)`);
console.log(`  audit 'create' rows for these ids: ${auditCount.count} (expect 32)`);

const probs=[];
if (ins.data.length!==32) probs.push(`insert ${ins.data.length} != 32`);
if (ver.data.length!==35) probs.push(`field-1024 July ${ver.data.length} != 35`);
if (post.count!==2273) probs.push(`total ${post.count} != 2273`);
if (auditCount.count!==32) probs.push(`audit ${auditCount.count} != 32`);
if (!allSpots18) probs.push("not all 18 spots");
if (probs.length) HALT("Post-write mismatch:\n - "+probs.join("\n - "));
console.log("\nALL CHECKS PASSED.");
