import { sb } from "./_session_runner.mjs";
const DOW={0:"Sun",1:"Mon",2:"Tue",3:"Wed",4:"Thu",5:"Fri",6:"Sat"};
// mdapi.start_date encodes local wall-clock as UTC-offset timestamptz -> read UTC parts
const localDate=(s)=>{const d=new Date(s);return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`;};
const localTime=(s)=>{const d=new Date(s);let h=d.getUTCHours();const mi=d.getUTCMinutes();const ap=h>=12?"PM":"AM";const h12=h%12===0?12:h%12;return `${h12}:${String(mi).padStart(2,"0")} ${ap}`;};
const dow=(s)=>DOW[new Date(s).getUTCDay()];

const { data, error } = await sb.from("mdapi_matches")
  .select("api_id, start_date, is_cancelled, max_player_count, deleted_at")
  .eq("field_id",1486)
  .gte("start_date","2026-07-01T00:00:00Z").lt("start_date","2026-08-01T00:00:00Z")
  .order("start_date");
if (error) { console.log("ERR", error.message); process.exit(1); }
console.log(`LBJ (field 1486) July 2026 matches: ${data.length} total\n`);
const alive=[], other=[];
for (const m of data){
  const line=`  ${localDate(m.start_date)} ${dow(m.start_date)}  ${localTime(m.start_date).padEnd(8)} cap=${String(m.max_player_count).padStart(2)}  ${m.is_cancelled?"CANCELLED":"alive"}${m.deleted_at?" [soft-deleted]":""}`;
  if (!m.is_cancelled && !m.deleted_at) alive.push(line); else other.push(line);
}
console.log(`ALIVE (${alive.length}):`); alive.forEach(l=>console.log(l));
if (other.length){ console.log(`\nCANCELLED / SOFT-DELETED (${other.length}):`); other.forEach(l=>console.log(l)); }

// weekday tally of alive
const tally={};
for (const m of data){ if(m.is_cancelled||m.deleted_at) continue; tally[dow(m.start_date)]=(tally[dow(m.start_date)]||0)+1; }
console.log("\nAlive weekday tally:", JSON.stringify(tally));
