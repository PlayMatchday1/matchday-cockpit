import { sb } from "./_session_runner.mjs";
const HALT=(m)=>{console.log("\n*** HALT ***\n"+m);process.exit(1);};
const parseHHMM=(t)=>{const m=/^\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?/i.exec(t);let h=+m[1];const mi=m[2]?+m[2]:0;const ap=(m[3]||"").toUpperCase();if(ap==="PM"&&h<12)h+=12;if(ap==="AM"&&h===12)h=0;return `${String(h).padStart(2,"0")}:${String(mi).padStart(2,"0")}`;};
const pick=(r)=>({id:r.id,city:r.city,venue:r.venue,detail:r.detail,match_date:r.match_date,match_time:r.match_time,max_spots:r.max_spots,mdapi_field_id:r.mdapi_field_id});

const pre=await sb.from("schedule_master").select("*",{count:"exact",head:true});
if (pre.count!==2297) HALT(`pre-count ${pre.count} != 2297. Aborting.`);
// PRUMC snapshot (field 958) - must be unchanged
const prumcPre=await sb.from("schedule_master").select("id, match_time").eq("mdapi_field_id",958).gte("match_date","2026-07-01").lte("match_date","2026-07-31");
const prumcPreIds=new Set(prumcPre.data.map(r=>r.id));
console.log(`PRUMC field-958 July rows before: ${prumcPre.data.length}`);

const rows=[
  // ATH Katy (4) - Houston, 40sp, 5:30 PM, field 892
  ...["2026-07-05","2026-07-12","2026-07-19","2026-07-26"].map(d=>({city:"Houston",venue:"ATH Katy",detail:"ATH Katy",match_date:d,match_time:"5:30 PM - 6:30 PM",max_spots:40,mdapi_field_id:892})),
  // PAC Global (9) - Houston, 18sp, 9 PM, field 1189, Tue/Thu
  ...["2026-07-02","2026-07-07","2026-07-09","2026-07-14","2026-07-16","2026-07-21","2026-07-23","2026-07-28","2026-07-30"].map(d=>({city:"Houston",venue:"PAC Global",detail:"PAC",match_date:d,match_time:"9:00 PM - 10:00 PM",max_spots:18,mdapi_field_id:1189})),
  // Lou Fusz Outdoor (9) - St. Louis, 18sp, 8:15 PM, field 664, Mon/Thu
  ...["2026-07-02","2026-07-06","2026-07-09","2026-07-13","2026-07-16","2026-07-20","2026-07-23","2026-07-27","2026-07-30"].map(d=>({city:"St. Louis",venue:"Lou Fusz Outdoor",detail:"Lou Fusz Outdoor (Field 10)",match_date:d,match_time:"8:15 PM - 9:15 PM",max_spots:18,mdapi_field_id:664})),
  // Centennial Commons (5) - St. Louis, 21sp, 7 PM, field 760, Fri
  ...["2026-07-03","2026-07-10","2026-07-17","2026-07-24","2026-07-31"].map(d=>({city:"St. Louis",venue:"Centennial Commons",detail:"Centennial Commons",match_date:d,match_time:"7:00 PM - 8:00 PM",max_spots:21,mdapi_field_id:760})),
];
if (rows.length!==27) HALT(`built ${rows.length} != 27`);

// dedup guard per field (detail-aware)
const fids=[892,1189,664,760];
const existing=await sb.from("schedule_master").select("match_date, match_time, detail, mdapi_field_id").in("mdapi_field_id",fids).gte("match_date","2026-07-01").lte("match_date","2026-07-31");
const exKeys=new Set((existing.data||[]).map(s=>`${s.mdapi_field_id}|${s.match_date}|${parseHHMM(s.match_time)}|${s.detail}`));
const collide=rows.filter(r=>exKeys.has(`${r.mdapi_field_id}|${r.match_date}|${parseHHMM(r.match_time)}|${r.detail}`));
if (collide.length) HALT(`dedup found ${collide.length} collisions.\n`+JSON.stringify(collide.map(c=>`${c.venue} ${c.match_date} ${c.match_time}`)));
console.log("dedup: 0 collisions, inserting 27.");

const ins=await sb.from("schedule_master").insert(rows).select("id, city, venue, detail, match_date, match_time, max_spots, mdapi_field_id");
if (ins.error) HALT("insert failed: "+ins.error.message);
if (ins.data.length!==27) HALT(`returned ${ins.data.length} != 27`);
console.log("insert OK: 27 rows.");
const audit=ins.data.map(r=>({row_id:r.id, action:"create", user_email:"rmancuso@playmatchday.com", old_values:null, new_values:pick(r)}));
const aud=await sb.from("schedule_master_audit").insert(audit).select("id");
if (aud.error||aud.data.length!==27) HALT(`audit failed/count: ${aud.error?.message} got ${aud.data?.length}`);
console.log("audit OK: 27 create rows.");

// verification by venue
const post=await sb.from("schedule_master").select("*",{count:"exact",head:true});
const byVenue={};
for (const [label,fid,exp] of [["ATH Katy Sun",892,null],["PAC Global",1189,9],["Lou Fusz",664,9],["Centennial",760,5]]){
  const c=await sb.from("schedule_master").select("match_date, match_time",{count:"exact"}).eq("mdapi_field_id",fid).gte("match_date","2026-07-01").lte("match_date","2026-07-31");
  byVenue[label]=c.count;
}
// ATH Katy Sunday specifically (of the 892 rows, how many are the new 5:30 Sundays)
const akSun=await sb.from("schedule_master").select("match_date",{count:"exact",head:true}).eq("mdapi_field_id",892).eq("match_time","5:30 PM - 6:30 PM").gte("match_date","2026-07-01").lte("match_date","2026-07-31");

// PRUMC untouched check
const prumcPost=await sb.from("schedule_master").select("id, match_time").eq("mdapi_field_id",958).gte("match_date","2026-07-01").lte("match_date","2026-07-31");
const prumcSame = prumcPost.data.length===prumcPre.data.length && prumcPost.data.every(r=>prumcPreIds.has(r.id) && r.match_time==="6:00 PM - 7:00 PM" || prumcPreIds.has(r.id));
const prumcUnchanged = prumcPost.data.length===prumcPre.data.length && prumcPost.data.every(r=>prumcPreIds.has(r.id));

console.log("\n=== VERIFICATION ===");
console.log("  July rows per field now:", JSON.stringify(byVenue));
console.log(`  ATH Katy new 5:30 PM Sunday rows: ${akSun.count} (expect 4)`);
console.log(`  schedule_master total: ${pre.count} -> ${post.count} (expect 2324)`);
console.log(`  PRUMC field-958 July rows: before ${prumcPre.data.length}, after ${prumcPost.data.length}, same IDs+untouched: ${prumcUnchanged}`);

const probs=[];
if (ins.data.length!==27) probs.push(`insert ${ins.data.length} != 27`);
if (post.count!==2324) probs.push(`post ${post.count} != 2324`);
if (akSun.count!==4) probs.push(`ATH Katy Sun ${akSun.count} != 4`);
if (byVenue["PAC Global"]!==9) probs.push(`PAC ${byVenue["PAC Global"]} != 9`);
if (byVenue["Lou Fusz"]!==9) probs.push(`Lou Fusz ${byVenue["Lou Fusz"]} != 9`);
if (byVenue["Centennial"]!==5) probs.push(`Centennial ${byVenue["Centennial"]} != 5`);
if (!prumcUnchanged) probs.push("PRUMC rows changed!");
if (probs.length) HALT("mismatch:\n - "+probs.join("\n - "));
console.log("\nALL CHECKS PASSED.");
