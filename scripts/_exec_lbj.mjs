import { sb } from "./_session_runner.mjs";
const HALT=(m)=>{console.log("\n*** HALT ***\n"+m);process.exit(1);};
const parseHHMM=(t)=>{const m=/^\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?/i.exec(t);let h=+m[1];const mi=m[2]?+m[2]:0;const ap=(m[3]||"").toUpperCase();if(ap==="PM"&&h<12)h+=12;if(ap==="AM"&&h===12)h=0;return `${String(h).padStart(2,"0")}:${String(mi).padStart(2,"0")}`;};

// ===== PHASE 1: venue registration =====
console.log("===== PHASE 1: VENUE REGISTRATION =====");
const pre1 = await sb.from("fin_venues").select("id").ilike("venue_name","%LBJ%");
if (pre1.error) HALT("pre-check fin_venues failed: "+pre1.error.message);
if (pre1.data.length) HALT("LBJ already exists in fin_venues: "+JSON.stringify(pre1.data));
const preMap = await sb.from("fin_venue_fields").select("fin_venue_id").eq("mdapi_field_id",1486);
if (preMap.data.length) HALT("field 1486 already mapped: "+JSON.stringify(preMap.data));

const w1 = await sb.from("fin_venues").insert({
  city:"Austin", venue_name:"LBJ Early College High School", billing_type:"per_match",
  per_match_rate:80, cost_per_match:80, max_spots:18, is_active:true, charge_on_cancel:true,
}).select("id, city, venue_name, billing_type, per_match_rate, cost_per_match, max_spots, is_active, charge_on_cancel");
if (w1.error) HALT("(Write 1) fin_venues insert failed: "+w1.error.message);
if (w1.data.length!==1) HALT(`(Write 1) expected 1 row, got ${w1.data.length}`);
const venueId = w1.data[0].id;
console.log("Write 1 OK — fin_venues row:", JSON.stringify(w1.data[0]));
if (typeof venueId!=="number") HALT("new venue id not numeric: "+JSON.stringify(venueId));

const w2 = await sb.from("fin_venue_fields").insert({
  fin_venue_id:venueId, mdapi_field_id:1486, field_title_at_link:"LBJ Early College High School",
}).select("fin_venue_id, mdapi_field_id, field_title_at_link");
if (w2.error) HALT(`(Write 2) fin_venue_fields insert failed: ${w2.error.message}. NOTE: fin_venues row ${venueId} IS written.`);
if (w2.data.length!==1) HALT(`(Write 2) expected 1 row, got ${w2.data.length}`);
console.log("Write 2 OK — fin_venue_fields row:", JSON.stringify(w2.data[0]));

// Phase 1 verification (join)
const ver1 = await sb.from("fin_venues")
  .select("id, city, venue_name, billing_type, per_match_rate, cost_per_match, max_spots, is_active, charge_on_cancel, fin_venue_fields(mdapi_field_id, field_title_at_link)")
  .eq("id", venueId);
if (ver1.error) HALT("Phase 1 verification failed: "+ver1.error.message);
console.log("\nPHASE 1 VERIFICATION:\n"+JSON.stringify(ver1.data[0],null,2));
const v=ver1.data[0];
const clean1 = v && v.venue_name==="LBJ Early College High School" && v.city==="Austin" && v.billing_type==="per_match"
  && Number(v.per_match_rate)===80 && Number(v.cost_per_match)===80 && Number(v.max_spots)===18 && v.is_active===true
  && Array.isArray(v.fin_venue_fields) && v.fin_venue_fields.some(f=>Number(f.mdapi_field_id)===1486);
if (!clean1) HALT("Phase 1 verification did not match expected values. Not proceeding to Phase 2.");
console.log("\nPHASE 1 CLEAN. Proceeding to Phase 2.\n");

// ===== PHASE 2: schedule_master + audit =====
console.log("===== PHASE 2: SCHEDULE_MASTER (18 rows) =====");
const preCount = await sb.from("schedule_master").select("*",{count:"exact",head:true});
if (preCount.count!==2085) HALT(`pre-count ${preCount.count} != 2085. Aborting.`);

const spec=[
 ["2026-07-04","9:30 AM - 10:30 AM"],["2026-07-06","7:30 PM - 8:30 PM"],
 ["2026-07-10","7:30 PM - 8:30 PM"],["2026-07-11","9:30 AM - 10:30 AM"],["2026-07-12","7:30 PM - 8:30 PM"],["2026-07-13","7:30 PM - 8:30 PM"],["2026-07-14","7:30 PM - 8:30 PM"],
 ["2026-07-17","7:30 PM - 8:30 PM"],["2026-07-18","9:30 AM - 10:30 AM"],["2026-07-19","7:30 PM - 8:30 PM"],["2026-07-20","7:30 PM - 8:30 PM"],["2026-07-21","7:30 PM - 8:30 PM"],
 ["2026-07-24","7:30 PM - 8:30 PM"],["2026-07-25","9:30 AM - 10:30 AM"],["2026-07-26","7:30 PM - 8:30 PM"],["2026-07-27","7:30 PM - 8:30 PM"],["2026-07-28","7:30 PM - 8:30 PM"],
 ["2026-07-31","7:30 PM - 8:30 PM"],
];
if (spec.length!==18) HALT("spec length "+spec.length+" != 18");

// dedup vs existing schedule_master (field 1486 or LBJ name)
const existing = await sb.from("schedule_master").select("match_date, match_time, mdapi_field_id, venue")
  .or("mdapi_field_id.eq.1486,venue.ilike.%LBJ%").gte("match_date","2026-07-01").lte("match_date","2026-07-31");
const existKeys = new Set((existing.data||[]).map(s=>`${s.match_date}|${parseHHMM(s.match_time)}`));
const toInsert = spec.filter(([d,t])=>!existKeys.has(`${d}|${parseHHMM(t)}`));
console.log(`dedup: ${spec.length} specified, ${spec.length-toInsert.length} already exist, ${toInsert.length} to insert`);
if (toInsert.length!==18) console.log("NOTE: some rows already existed and will be skipped.");

const rows = toInsert.map(([d,t])=>({city:"Austin",venue:"LBJ Early College High School",detail:"LBJ Early College High School",match_date:d,match_time:t,max_spots:18,mdapi_field_id:1486}));
const ins = await sb.from("schedule_master").insert(rows).select("id, city, venue, detail, match_date, match_time, max_spots, mdapi_field_id");
if (ins.error) HALT("(Phase 2 Write 1) schedule_master insert failed: "+ins.error.message);
if (ins.data.length!==rows.length) HALT(`expected ${rows.length} rows back, got ${ins.data.length}. Investigate before audit.`);
console.log(`schedule_master insert OK: ${ins.data.length} rows.`);

const audit = ins.data.map(r=>({row_id:r.id, action:"create", user_email:"rmancuso@playmatchday.com", old_values:null,
  new_values:{id:r.id,city:r.city,venue:r.venue,detail:r.detail,match_date:r.match_date,match_time:r.match_time,max_spots:r.max_spots,mdapi_field_id:r.mdapi_field_id}}));
const aud = await sb.from("schedule_master_audit").insert(audit).select("id");
if (aud.error) HALT(`(Phase 2 Write 2) audit insert failed: ${aud.error.message}. schedule_master rows ARE written; audit incomplete.`);
if (aud.data.length!==rows.length) HALT(`expected ${rows.length} audit rows, got ${aud.data.length}.`);
console.log(`schedule_master_audit insert OK: ${aud.data.length} rows.`);

// Phase 2 verification
const ver2 = await sb.from("schedule_master").select("match_date, match_time, max_spots")
  .eq("mdapi_field_id",1486).gte("match_date","2026-07-01").lte("match_date","2026-07-31").order("match_date");
console.log(`\nPHASE 2 VERIFICATION — LBJ July rows (${ver2.data.length}):`);
ver2.data.forEach(r=>console.log(`  ${r.match_date}  ${r.match_time}  ${r.max_spots}sp`));
const postCount = await sb.from("schedule_master").select("*",{count:"exact",head:true});
const auditCount = await sb.from("schedule_master_audit").select("*",{count:"exact",head:true}).in("row_id", ins.data.map(r=>r.id));
console.log(`\n  schedule_master total: ${preCount.count} -> ${postCount.count} (expected ${preCount.count+rows.length})`);
console.log(`  audit 'create' rows for these ids: ${auditCount.count}`);

const probs=[];
if (ver2.data.length!==18) probs.push(`verification ${ver2.data.length} != 18`);
if (postCount.count!==preCount.count+rows.length) probs.push(`post-count ${postCount.count} != ${preCount.count+rows.length}`);
if (auditCount.count!==rows.length) probs.push(`audit count ${auditCount.count} != ${rows.length}`);
if (probs.length) HALT("Post-write mismatch:\n - "+probs.join("\n - "));
console.log("\nALL CHECKS PASSED (Phase 1 + Phase 2). New LBJ venue id = "+venueId);
