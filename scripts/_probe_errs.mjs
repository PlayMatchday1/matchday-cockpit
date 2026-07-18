import { sb } from "./_session_runner.mjs";
const a = await sb.from("fin_venue_fields").select("mdapi_field_id, fin_venue_id");
console.log("fin_venue_fields:", a.error?("ERR "+a.error.message):`ok (${a.data.length} rows)`);
const b = await sb.from("fin_venues").select("id, city, venue_name, raw_venue_name");
console.log("fin_venues:", b.error?("ERR "+b.error.message):`ok (${b.data.length} rows)`);
const c = await sb.from("fin_venues").select("*").limit(1);
if(!c.error) console.log("fin_venues columns:", Object.keys(c.data[0]).join(", "));
