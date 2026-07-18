import { sb } from "./_session_runner.mjs";
async function pageAll(f){const o=[];let x=0;for(;;){const{data,error}=await f().range(x,x+999);if(error)throw error;if(!data?.length)break;o.push(...data);if(data.length<1000)break;x+=1000;}return o;}
const DOW={0:"Sun",1:"Mon",2:"Tue",3:"Wed",4:"Thu",5:"Fri",6:"Sat"};
const ld=(s)=>{const d=new Date(s);return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`;};
const lt=(s)=>{const d=new Date(s);let h=d.getUTCHours();const mi=d.getUTCMinutes();const ap=h>=12?"PM":"AM";const h12=h%12===0?12:h%12;return `${h12}:${String(mi).padStart(2,"0")} ${ap}`;};
const dw=(s)=>DOW[new Date(s).getUTCDay()];

// fin_venues Hattrick(s) + their field mappings
const fv = await sb.from("fin_venues").select("id, venue_name, city, billing_type, per_match_rate, cost_per_match, max_spots, is_active").ilike("venue_name","%hattrick%");
console.log("=== fin_venues Hattrick ===");
for (const v of fv.data) {
  const f = await sb.from("fin_venue_fields").select("mdapi_field_id, field_title_at_link").eq("fin_venue_id", v.id);
  console.log(`  id=${v.id} "${v.venue_name}" ${v.city} rate=${v.per_match_rate} spots=${v.max_spots} active=${v.is_active} fields=${JSON.stringify(f.data)}`);
}

// existing schedule_master Hattrick July rows (dedup + existing times)
const fieldIds = [];
for (const v of fv.data){const f=await sb.from("fin_venue_fields").select("mdapi_field_id").eq("fin_venue_id",v.id); f.data.forEach(x=>fieldIds.push(Number(x.mdapi_field_id)));}
console.log("\nHattrick field_ids:", JSON.stringify(fieldIds));
const sm = await sb.from("schedule_master").select("match_date, match_time, venue, mdapi_field_id")
  .or(fieldIds.map(id=>`mdapi_field_id.eq.${id}`).join(",")+",venue.ilike.%hattrick%")
  .gte("match_date","2026-07-01").lte("match_date","2026-07-31").order("match_date");
console.log(`\nexisting schedule_master Hattrick July rows: ${sm.data.length}`);
sm.data.forEach(r=>console.log(`  ${r.match_date} ${dw(r.match_date)} ${r.match_time} field=${r.mdapi_field_id} venue="${r.venue}"`));

// mdapi Saturday times for Hattrick fields in July (to disambiguate 7:30 AM vs PM)
if (fieldIds.length){
  const mm = await pageAll(()=>sb.from("mdapi_matches").select("field_id, field_title, start_date, is_cancelled")
    .in("field_id", fieldIds).gte("start_date","2026-07-01T00:00:00Z").lt("start_date","2026-08-01T00:00:00Z"));
  const sat = mm.filter(m=>dw(m.start_date)==="Sat");
  console.log(`\nmdapi Hattrick July SATURDAY matches: ${sat.length}`);
  sat.sort((a,b)=>a.start_date.localeCompare(b.start_date)).forEach(m=>console.log(`  ${ld(m.start_date)} ${lt(m.start_date)} field=${m.field_id} "${m.field_title}" ${m.is_cancelled?"CANCELLED":"alive"}`));
  const allTimes=[...new Set(mm.map(m=>lt(m.start_date)))];
  console.log("\nall distinct Hattrick July match times (any day):", JSON.stringify(allTimes));
}

// July Saturdays from the 11th
console.log("\nJuly 2026 Saturdays from the 11th: 2026-07-11, 2026-07-18, 2026-07-25");
const cnt = await sb.from("schedule_master").select("*",{count:"exact",head:true});
console.log("schedule_master current count:", cnt.count, "(expect 2131)");
