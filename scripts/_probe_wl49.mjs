import { sb } from "./_session_runner.mjs";
const v = await sb.from("fin_venues").select("*").eq("id",49);
console.log("fin_venues id=49:\n", JSON.stringify(v.data[0],null,2));
// any fin_venue_fields already pointing at 49?
const f = await sb.from("fin_venue_fields").select("*").eq("fin_venue_id",49);
console.log("fin_venue_fields -> 49:", JSON.stringify(f.data));
// any schedule_master rows referencing venue name Westlake (any field)?
const sm = await sb.from("schedule_master").select("id, match_date, venue, mdapi_field_id").ilike("venue","%westlake%").limit(10);
console.log("schedule_master venue ilike westlake:", sm.data.length, JSON.stringify(sm.data));
// any fin_revenue / fin_member_spots referencing venue 49 or 'Westlake'? (is it actually in use)
const rev = await sb.from("fin_revenue").select("id").ilike("venue","%westlake%").limit(3);
console.log("fin_revenue venue ilike westlake:", (rev.data||[]).length);
