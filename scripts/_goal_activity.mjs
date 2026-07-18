import { sb } from "./_session_runner.mjs";
const g = await sb.from("goals").select("id, title, status, progress, last_progress_change_at, updated_at, created_at").ilike("title","%140 Matches%");
const g2 = await sb.from("goals").select("id, title, status, progress, last_progress_change_at, updated_at, created_at").ilike("title","%Close Seed%");
for (const r of [...(g.data||[]),...(g2.data||[])]) {
  console.log(`\n"${r.title}" status=${r.status} progress=${r.progress}`);
  console.log(`  last_progress_change_at=${r.last_progress_change_at}`);
  console.log(`  updated_at=${r.updated_at}  created_at=${r.created_at}`);
  const c = await sb.from("goal_comments").select("created_at").eq("goal_id", r.id).order("created_at",{ascending:false}).limit(1);
  console.log(`  latest comment: ${c.data?.[0]?.created_at ?? "(none)"}  total comments: ${c.error?("ERR "+c.error.message):(await sb.from("goal_comments").select("id",{count:"exact",head:true}).eq("goal_id",r.id)).count}`);
}
