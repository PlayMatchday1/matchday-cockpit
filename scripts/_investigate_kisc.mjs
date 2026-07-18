import { sb } from "./_session_runner.mjs";
async function pageAll(f){const o=[];let x=0;for(;;){const{data,error}=await f().range(x,x+999);if(error)throw error;if(!data?.length)break;o.push(...data);if(data.length<1000)break;x+=1000;}return o;}
const DOW={0:"Sun",1:"Mon",2:"Tue",3:"Wed",4:"Thu",5:"Fri",6:"Sat"};
const ld=(s)=>{const d=new Date(s);return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`;};
const lt=(s)=>{const d=new Date(s);let h=d.getUTCHours();const mi=d.getUTCMinutes();const ap=h>=12?"PM":"AM";const h12=h%12===0?12:h%12;return `${h12}:${String(mi).padStart(2,"0")} ${ap}`;};
const dw=(iso)=>DOW[new Date(iso.length>10?iso:iso+"T00:00:00Z").getUTCDay()];
const parseHHMM=(t)=>{const m=/^\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?/i.exec(t);if(!m)return"";let h=+m[1];const mi=m[2]?+m[2]:0;const ap=(m[3]||"").toUpperCase();if(ap==="PM"&&h<12)h+=12;if(ap==="AM"&&h===12)h=0;return `${String(h).padStart(2,"0")}:${String(mi).padStart(2,"0")}`;};

// 1. venue
console.log("=== (1) fin_venues KISC/Katy/International ===");
const fv = await sb.from("fin_venues").select("id, venue_name, city, billing_type, per_match_rate, cost_per_match, max_spots, charge_on_cancel, is_active")
  .or("venue_name.ilike.%katy%,venue_name.ilike.%kisc%,venue_name.ilike.%international%");
fv.data.forEach(v=>console.log("  "+JSON.stringify(v)));
// pick the KISC one (Houston, "KISC")
const kisc = fv.data.find(v=>/kisc|katy int/i.test(v.venue_name)) || fv.data[0];
console.log("  => using venue:", JSON.stringify({id:kisc.id, name:kisc.venue_name, city:kisc.city, max_spots:kisc.max_spots, charge_on_cancel:kisc.charge_on_cancel, billing:kisc.billing_type}));
const defSpots = kisc.max_spots==null?18:kisc.max_spots;

// 2. field mapping
console.log("\n=== (2) fin_venue_fields for venue #"+kisc.id+" ===");
const vff = await sb.from("fin_venue_fields").select("mdapi_field_id, field_title_at_link").eq("fin_venue_id", kisc.id);
vff.data.forEach(r=>console.log("  "+JSON.stringify(r)));
const FID = vff.data.length===1?Number(vff.data[0].mdapi_field_id):null;
console.log("  => field_id =", FID, "| max_spots to use =", defSpots);
if(vff.data.length!==1) console.log("  *** NOTE:",vff.data.length,"field mappings ***");

// 3. existing schedule_master July for this field
console.log("\n=== (3) schedule_master July for field "+FID+" ===");
const sm = await sb.from("schedule_master").select("match_date, match_time, venue, detail, max_spots").eq("mdapi_field_id",FID).gte("match_date","2026-07-01").lte("match_date","2026-07-31").order("match_date");
console.log(`  ${sm.data.length} rows`);
sm.data.forEach(r=>console.log(`  ${r.match_date} ${dw(r.match_date)} "${r.match_time}" ${r.max_spots}sp venue="${r.venue}"`));
const smKeys = new Set(sm.data.map(r=>`${r.match_date}|${parseHHMM(r.match_time)}`));

// 4. mdapi_matches KISC July 1-8 (flag anything off-pattern)
console.log("\n=== (4) mdapi_matches field "+FID+" Jul 1-8 (deleted_at NULL) ===");
const mm = await pageAll(()=>sb.from("mdapi_matches").select("start_date, is_cancelled, max_player_count").eq("field_id",FID)
  .gte("start_date","2026-07-01T00:00:00Z").lt("start_date","2026-07-09T00:00:00Z").is("deleted_at",null));
const mmRows = mm.map(m=>({date:ld(m.start_date),dow:dw(m.start_date),time:lt(m.start_date),hhmm:parseHHMM(lt(m.start_date)),cxl:m.is_cancelled,cap:m.max_player_count})).sort((a,b)=>a.date.localeCompare(b.date)||a.hhmm.localeCompare(b.hhmm));
console.log(`  ${mmRows.length} matches`);
mmRows.forEach(r=>{
  const fitsPattern = (r.dow==="Tue"||r.dow==="Fri") && r.hhmm==="20:00";
  console.log(`  ${r.date} ${r.dow} ${r.time.padEnd(8)} cap=${r.cap} ${r.cxl?"CANCELLED":"alive"} ${fitsPattern?"":"<-- OFF-PATTERN (not Tue/Fri 8PM)"}`);
});

// also full-month mdapi for context
const mmJul = await pageAll(()=>sb.from("mdapi_matches").select("start_date, is_cancelled").eq("field_id",FID).gte("start_date","2026-07-01T00:00:00Z").lt("start_date","2026-08-01T00:00:00Z").is("deleted_at",null));
console.log(`  (context) total KISC mdapi July matches: ${mmJul.length}, alive: ${mmJul.filter(m=>!m.is_cancelled).length}, range ${mmJul.length?ld(mmJul.map(m=>m.start_date).sort()[0]):"-"}..${mmJul.length?ld(mmJul.map(m=>m.start_date).sort()[mmJul.length-1]):"-"}`);

// 5. dedup expected list
const expected=["2026-07-03","2026-07-07","2026-07-10","2026-07-14","2026-07-17","2026-07-21","2026-07-24","2026-07-28","2026-07-31"];
console.log("\n=== expected 9 dates @ 8PM — validation + dedup ===");
let conflicts=0;const toAdd=[];
for(const d of expected){const dup=smKeys.has(`${d}|${parseHHMM("8:00 PM")}`);if(dup)conflicts++;else toAdd.push(d);console.log(`  ${d} ${dw(d)} 8:00 PM  ${dup?"** exists **":"MISSING -> add"}`);}
console.log("weekday spread:", JSON.stringify(expected.reduce((a,d)=>{a[dw(d)]=(a[dw(d)]||0)+1;return a;},{})),"(expect Fri5,Tue4)");
console.log(`to add: ${toAdd.length}, conflicts: ${conflicts}`);

const cnt=await sb.from("schedule_master").select("*",{count:"exact",head:true});
console.log("\nschedule_master current count:", cnt.count);
