import { sb } from "./_session_runner.mjs";
const HALT=(m)=>{console.log("\n*** HALT ***\n"+m);process.exit(1);};
const dw=(iso)=>new Date(iso+"T00:00:00Z").getUTCDay();
const parseHHMM=(t)=>{const m=/^\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?/i.exec(t);let h=+m[1];const mi=m[2]?+m[2]:0;const ap=(m[3]||"").toUpperCase();if(ap==="PM"&&h<12)h+=12;if(ap==="AM"&&h===12)h=0;return `${String(h).padStart(2,"0")}:${String(mi).padStart(2,"0")}`;};

const pre=await sb.from("schedule_master").select("*",{count:"exact",head:true});
if (pre.count!==2165) HALT(`pre-count ${pre.count} != 2165. Aborting.`);

const T={7:"7:00 PM - 8:00 PM",8:"8:00 PM - 9:00 PM",9:"9:00 PM - 10:00 PM"};
const D4="Soccer Central - SC Field 4", D4A="Soccer Central - SC Field 4A", DP="Soccer Central - Premier Match";
const PAT={1:[[8,102,D4],[9,102,D4]],2:[[8,102,D4],[9,1354,DP]],3:[[8,102,D4],[9,102,D4]],4:[[8,102,D4],[9,1354,DP]],5:[[7,102,D4],[8,102,D4],[9,102,D4A]],6:[[7,102,D4],[8,102,D4]],0:[[7,102,D4A],[8,102,D4]]};
const rows=[];
for(let d=1;d<=31;d++){const iso=`2026-07-${String(d).padStart(2,"0")}`;for(const [hr,field,detail] of (PAT[dw(iso)]||[])){rows.push({city:"San Antonio",venue:"Soccer Central",detail,match_date:iso,match_time:T[hr],max_spots:36,mdapi_field_id:field});}}
if (rows.length!==67) HALT(`generated ${rows.length} rows != 67`);
const byDetail={}; rows.forEach(r=>byDetail[r.detail]=(byDetail[r.detail]||0)+1);
if (byDetail[D4]!==49||byDetail[D4A]!==9||byDetail[DP]!==9) HALT("breakdown mismatch: "+JSON.stringify(byDetail));

// detail-aware dedup guard
const existing=await sb.from("schedule_master").select("match_date, match_time, detail, mdapi_field_id").in("mdapi_field_id",[102,1354]).gte("match_date","2026-07-01").lte("match_date","2026-07-31");
const exKeys=new Set((existing.data||[]).map(s=>`${s.mdapi_field_id}|${s.match_date}|${parseHHMM(s.match_time)}|${s.detail}`));
const collide=rows.filter(r=>exKeys.has(`${r.mdapi_field_id}|${r.match_date}|${parseHHMM(r.match_time)}|${r.detail}`));
if (collide.length) HALT(`dedup found ${collide.length} collisions. Aborting.`);
console.log("dedup (field|date|HH:MM|detail): 0 collisions, inserting 67.");

const ins=await sb.from("schedule_master").insert(rows).select("id, city, venue, detail, match_date, match_time, max_spots, mdapi_field_id");
if (ins.error) HALT("insert failed: "+ins.error.message);
if (ins.data.length!==67) HALT(`returned count ${ins.data.length} != 67. Investigate before audit.`);
console.log("schedule_master insert OK: 67 rows.");

const audit=ins.data.map(r=>({row_id:r.id, action:"create", user_email:"rmancuso@playmatchday.com", old_values:null,
  new_values:{id:r.id,city:r.city,venue:r.venue,detail:r.detail,match_date:r.match_date,match_time:r.match_time,max_spots:r.max_spots,mdapi_field_id:r.mdapi_field_id}}));
// chunk audit insert (67 rows) in one call
const aud=await sb.from("schedule_master_audit").insert(audit).select("id");
if (aud.error) HALT(`audit insert failed: ${aud.error.message}. schedule_master rows ARE written; audit incomplete.`);
if (aud.data.length!==67) HALT(`audit count ${aud.data.length} != 67`);
console.log("schedule_master_audit insert OK: 67 rows.");

// verification
const ver=await sb.from("schedule_master").select("detail, mdapi_field_id").in("mdapi_field_id",[102,1354]).eq("venue","Soccer Central").gte("match_date","2026-07-01").lte("match_date","2026-07-31");
const vd={}; ver.data.forEach(r=>vd[r.detail]=(vd[r.detail]||0)+1);
const post=await sb.from("schedule_master").select("*",{count:"exact",head:true});
const auditCount=await sb.from("schedule_master_audit").select("*",{count:"exact",head:true}).in("row_id", ins.data.map(r=>r.id));
console.log(`\n=== VERIFICATION ===`);
console.log(`  July Soccer Central rows (fields 102/1354): ${ver.data.length} (expect 67)`);
console.log(`  by detail: ${JSON.stringify(vd)} (expect Field4=49, Field4A=9, Premier=9)`);
console.log(`  schedule_master total: ${pre.count} -> ${post.count} (expect 2232)`);
console.log(`  audit 'create' rows for these ids: ${auditCount.count} (expect 67)`);

const probs=[];
if (ver.data.length!==67) probs.push(`July SC rows ${ver.data.length} != 67`);
if (vd[D4]!==49||vd[D4A]!==9||vd[DP]!==9) probs.push("detail breakdown mismatch: "+JSON.stringify(vd));
if (post.count!==2232) probs.push(`total ${post.count} != 2232`);
if (auditCount.count!==67) probs.push(`audit ${auditCount.count} != 67`);
if (probs.length) HALT("Post-write mismatch:\n - "+probs.join("\n - "));
console.log("\nALL CHECKS PASSED.");
