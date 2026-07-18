import { sb } from "./_session_runner.mjs";
// Galatzan = field 1222. Any alive mdapi matches ever (which would drive cost)?
const mm = await sb.from("mdapi_matches").select("start_date, is_cancelled, deleted_at").eq("field_id",1222).order("start_date");
const alive=(mm.data||[]).filter(m=>!m.is_cancelled && !m.deleted_at);
console.log(`Galatzan (1222) mdapi matches total=${mm.data.length}, alive=${alive.length}`);
if(alive.length){const ds=alive.map(m=>m.start_date.slice(0,10)); console.log(`  alive range: ${ds[0]} .. ${ds[ds.length-1]}`);}
// fin_venues #22 rate to gauge any cost
const v = await sb.from("fin_venues").select("per_match_rate, cost_per_match, billing_type").eq("id",22);
console.log("  #22 billing:", JSON.stringify(v.data[0]));
