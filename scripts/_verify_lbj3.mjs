import { sb } from "./_session_runner.mjs";
// Is field_id 1486 mapped in fin_venue_fields?
const vf = await sb.from("fin_venue_fields").select("mdapi_field_id, fin_venue_id").eq("mdapi_field_id",1486);
console.log("fin_venue_fields for field 1486:", vf.error?("ERR "+vf.error.message):JSON.stringify(vf.data));
// Any existing schedule_master rows for LBJ (by field id or name)?
const sm = await sb.from("schedule_master").select("id, city, venue, detail, match_date, match_time, mdapi_field_id")
  .or("mdapi_field_id.eq.1486,venue.ilike.%LBJ%,detail.ilike.%LBJ%,detail.ilike.%Early College%").order("match_date");
console.log("existing schedule_master LBJ rows:", sm.error?("ERR "+sm.error.message):`${sm.data.length}`);
(sm.data||[]).forEach(r=>console.log("  "+JSON.stringify(r)));
// The 11 mdapi matches for LBJ — dates/status, for context
const mm = await sb.from("mdapi_matches").select("start_date, is_cancelled, max_player_count").eq("field_id",1486).order("start_date");
console.log("\nmdapi_matches at LBJ (field 1486):", mm.error?("ERR "+mm.error.message):`${mm.data.length}`);
(mm.data||[]).forEach(r=>console.log(`  ${r.start_date}  cancelled=${r.is_cancelled}  cap=${r.max_player_count}`));
