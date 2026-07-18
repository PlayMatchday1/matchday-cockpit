import { sb } from "./_session_runner.mjs";
const HALT = (msg)=>{console.log("\n*** HALT ***\n"+msg); process.exit(1);};

// ---- pre-count (guard baseline) ----
const pre = await sb.from("schedule_master").select("*",{count:"exact",head:true});
if (pre.error) HALT("pre-count failed: "+pre.error.message);
console.log("pre-count schedule_master:", pre.count);
if (pre.count !== 2063) HALT(`pre-count is ${pre.count}, expected 2063. Something changed since baseline. Not writing.`);

// ---- (a) baseline fin_sync_log insert ----
const base = await sb.from("fin_sync_log").insert({
  source:"mdapi-matches", triggered_by:"manual",
  started_at:new Date().toISOString(), completed_at:new Date().toISOString(),
  rows_imported:0,
  error_message:"ADVISORY: baseline snapshot before manual bulk-entry; schedule_master row count = 2063",
}).select("id, source, started_at, error_message");
if (base.error) HALT("(a) baseline fin_sync_log insert failed: "+base.error.message);
console.log("\n(a) BASELINE LOG WRITTEN:", JSON.stringify(base.data[0]));

// ---- (b) Write 1: 22 PRUMC rows ----
const dates = [
 ["2026-07-02","7:00 PM - 8:00 PM"],["2026-07-03","7:00 PM - 8:00 PM"],["2026-07-05","6:00 PM - 7:00 PM"],
 ["2026-07-06","7:00 PM - 8:00 PM"],["2026-07-07","7:00 PM - 8:00 PM"],["2026-07-09","7:00 PM - 8:00 PM"],
 ["2026-07-10","7:00 PM - 8:00 PM"],["2026-07-12","6:00 PM - 7:00 PM"],["2026-07-13","7:00 PM - 8:00 PM"],
 ["2026-07-14","7:00 PM - 8:00 PM"],["2026-07-16","7:00 PM - 8:00 PM"],["2026-07-17","7:00 PM - 8:00 PM"],
 ["2026-07-19","6:00 PM - 7:00 PM"],["2026-07-20","7:00 PM - 8:00 PM"],["2026-07-21","7:00 PM - 8:00 PM"],
 ["2026-07-23","7:00 PM - 8:00 PM"],["2026-07-24","7:00 PM - 8:00 PM"],["2026-07-26","6:00 PM - 7:00 PM"],
 ["2026-07-27","7:00 PM - 8:00 PM"],["2026-07-28","7:00 PM - 8:00 PM"],["2026-07-30","7:00 PM - 8:00 PM"],
 ["2026-07-31","7:00 PM - 8:00 PM"],
];
if (dates.length !== 22) HALT("date list length "+dates.length+" != 22");
const rows = dates.map(([d,t])=>({city:"Atlanta",venue:"PRUMC",detail:"PRUMC",match_date:d,match_time:t,max_spots:18,mdapi_field_id:958}));
const ins = await sb.from("schedule_master").insert(rows).select("id, city, venue, detail, match_date, match_time, max_spots, mdapi_field_id");
if (ins.error) HALT("(b) schedule_master insert failed: "+ins.error.message);
if ((ins.data?.length ?? 0) !== 22) HALT(`(b) expected 22 rows back, got ${ins.data?.length}. schedule_master rows may be partially written — investigate before audit.`);
console.log(`\n(b) WRITE 1 OK: inserted ${ins.data.length} schedule_master rows.`);

// ---- (c) Write 2: 22 audit rows using returned ids ----
const audit = ins.data.map(r=>({
  row_id:r.id, action:"create", user_email:"rmancuso@playmatchday.com", old_values:null,
  new_values:{id:r.id,city:r.city,venue:r.venue,detail:r.detail,match_date:r.match_date,match_time:r.match_time,max_spots:r.max_spots,mdapi_field_id:r.mdapi_field_id},
}));
const aud = await sb.from("schedule_master_audit").insert(audit).select("id");
if (aud.error) HALT(`(c) audit insert failed: ${aud.error.message}. NOTE: 22 schedule_master rows ARE written; audit is incomplete.`);
if ((aud.data?.length ?? 0) !== 22) HALT(`(c) expected 22 audit rows, got ${aud.data?.length}. schedule_master rows written; audit incomplete.`);
console.log(`(c) WRITE 2 OK: inserted ${aud.data.length} schedule_master_audit rows.`);

// ---- (d) verification ----
const ver = await sb.from("schedule_master")
  .select("match_date, match_time, max_spots")
  .eq("mdapi_field_id",958).gte("match_date","2026-07-01").lte("match_date","2026-07-31")
  .order("match_date");
if (ver.error) HALT("(d) verification select failed: "+ver.error.message);
console.log(`\n(d) VERIFICATION — PRUMC July 2026 rows (${ver.data.length}):`);
for (const r of ver.data) console.log(`  ${r.match_date}  ${r.match_time}  ${r.max_spots}sp`);

const post = await sb.from("schedule_master").select("*",{count:"exact",head:true});
const auditCount = await sb.from("schedule_master_audit").select("*",{count:"exact",head:true}).in("row_id", ins.data.map(r=>r.id));
console.log(`\n  schedule_master total: ${pre.count} -> ${post.count} (expected 2085)`);
console.log(`  audit 'create' rows for these 22 ids: ${auditCount.count}`);

const problems=[];
if (ver.data.length !== 22) problems.push(`verification returned ${ver.data.length}, expected 22`);
if (post.count !== 2085) problems.push(`post-count ${post.count}, expected 2085`);
if (auditCount.count !== 22) problems.push(`audit count ${auditCount.count}, expected 22`);
if (problems.length) HALT("Post-write checks mismatch:\n - "+problems.join("\n - "));
console.log("\nALL CHECKS PASSED.");
