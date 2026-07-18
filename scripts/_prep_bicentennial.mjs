import { sb } from "./_session_runner.mjs";
const DOW={0:"Sun",1:"Mon",2:"Tue",3:"Wed",4:"Thu",5:"Fri",6:"Sat"};
const dw=(iso)=>DOW[new Date(iso+"T00:00:00Z").getUTCDay()];
const parseHHMM=(t)=>{const m=/^\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?/i.exec(t);if(!m)return"";let h=+m[1];const mi=m[2]?+m[2]:0;const ap=(m[3]||"").toUpperCase();if(ap==="PM"&&h<12)h+=12;if(ap==="AM"&&h===12)h=0;return `${String(h).padStart(2,"0")}:${String(mi).padStart(2,"0")}`;};

// 1. venue #13 + field mapping
const v = await sb.from("fin_venues").select("id, venue_name, city, billing_type, per_match_rate, cost_per_match, max_spots, charge_on_cancel, is_active").eq("id",13);
console.log("fin_venues #13:", JSON.stringify(v.data[0]));
const vff = await sb.from("fin_venue_fields").select("mdapi_field_id, field_title_at_link").eq("fin_venue_id",13);
console.log("fin_venue_fields -> #13:", JSON.stringify(vff.data));
const fieldIds = vff.data.map(r=>Number(r.mdapi_field_id));
if (fieldIds.length!==1) console.log(`*** NOTE: ${fieldIds.length} field(s) mapped ***`);
const FID = fieldIds[0];
const defSpots = (v.data[0].max_spots==null) ? 18 : v.data[0].max_spots;
console.log(`\n=> field_id=${FID}, max_spots to use = ${defSpots} (${v.data[0].max_spots==null?"NULL -> default 18":"from #13"})`);

// 2. dedup: existing schedule_master rows for this field in July
const expected = ["2026-07-05","2026-07-07","2026-07-12","2026-07-14","2026-07-19","2026-07-21","2026-07-26","2026-07-28"];
const sm = await sb.from("schedule_master").select("match_date, match_time, max_spots, mdapi_field_id, venue")
  .eq("mdapi_field_id",FID).gte("match_date","2026-07-01").lte("match_date","2026-07-31").order("match_date");
console.log(`\nexisting schedule_master rows for field ${FID} in July: ${sm.data.length}`);
sm.data.forEach(r=>console.log(`  ${r.match_date} ${dw(r.match_date)} "${r.match_time}" ${r.max_spots}sp venue="${r.venue}"`));
const exKeys = new Set(sm.data.map(r=>`${r.match_date}|${parseHHMM(r.match_time)}`));

// validate weekdays + dedup on the 8 expected
console.log("\n=== expected 8 dates validation + dedup ===");
let conflicts=0;
for (const d of expected){
  const key=`${d}|${parseHHMM("7:00 PM")}`;
  const dup=exKeys.has(key);
  if (dup) conflicts++;
  console.log(`  ${d} ${dw(d)} 7:00 PM  ${dup?"** CONFLICT (already exists) **":"clear"}`);
}
console.log("\nweekday spread:", JSON.stringify(expected.reduce((a,d)=>{a[dw(d)]=(a[dw(d)]||0)+1;return a;},{})), "(expect Sun 4, Tue 4)");
console.log("dedup conflicts:", conflicts, conflicts>0?"-> HALT":"-> clear to insert");

const cnt = await sb.from("schedule_master").select("*",{count:"exact",head:true});
console.log("\nschedule_master current count:", cnt.count, "(expect 2134)");
