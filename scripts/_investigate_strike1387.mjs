import { sb } from "./_session_runner.mjs";
async function pageAll(f){const o=[];let x=0;for(;;){const{data,error}=await f().range(x,x+999);if(error)throw error;if(!data?.length)break;o.push(...data);if(data.length<1000)break;x+=1000;}return o;}
const DOW={0:"Sun",1:"Mon",2:"Tue",3:"Wed",4:"Thu",5:"Fri",6:"Sat"};
const ld=(s)=>{const d=new Date(s);return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`;};
const lt=(s)=>{const d=new Date(s);let h=d.getUTCHours();const mi=d.getUTCMinutes();const ap=h>=12?"PM":"AM";const h12=h%12===0?12:h%12;return `${h12}:${String(mi).padStart(2,"0")} ${ap}`;};
const dw=(iso)=>DOW[new Date(iso.length>10?iso:iso+"T00:00:00Z").getUTCDay()];
const parseHHMM=(t)=>{const m=/^\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?/i.exec(t);if(!m)return"";let h=+m[1];const mi=m[2]?+m[2]:0;const ap=(m[3]||"").toUpperCase();if(ap==="PM"&&h<12)h+=12;if(ap==="AM"&&h===12)h=0;return `${String(h).padStart(2,"0")}:${String(mi).padStart(2,"0")}`;};
const FID=1387;

// venue sanity
const v=await sb.from("fin_venues").select("id, venue_name, city, billing_type, per_match_rate, max_spots").eq("id",54);
console.log("venue #54:", JSON.stringify(v.data[0]));

// 3. mdapi alive July
const mm=await pageAll(()=>sb.from("mdapi_matches").select("start_date, is_cancelled, deleted_at, max_player_count")
  .eq("field_id",FID).gte("start_date","2026-07-01T00:00:00Z").lt("start_date","2026-08-01T00:00:00Z").is("deleted_at",null));
const mmRows=mm.map(m=>({date:ld(m.start_date),dow:dw(m.start_date),time:lt(m.start_date),hhmm:parseHHMM(lt(m.start_date)),cancelled:m.is_cancelled,cap:m.max_player_count}))
  .sort((a,b)=>a.date.localeCompare(b.date)||a.hhmm.localeCompare(b.hhmm));
console.log(`\n=== (3) mdapi_matches field ${FID} July (deleted_at NULL): ${mmRows.length} ===`);
mmRows.forEach(r=>console.log(`  ${r.date} ${r.dow} ${r.time.padEnd(8)} cap=${r.cap} ${r.cancelled?"CANCELLED":"alive"}`));
const mmSet=new Set(mmRows.filter(r=>!r.cancelled).map(r=>`${r.date}|${r.hhmm}`));
const mmByDate=new Map(); mmRows.filter(r=>!r.cancelled).forEach(r=>{(mmByDate.get(r.date)||mmByDate.set(r.date,[]).get(r.date)).push(r);});

// 4. schedule_master July
const sm=await sb.from("schedule_master").select("match_date, match_time, max_spots").eq("mdapi_field_id",FID)
  .gte("match_date","2026-07-01").lte("match_date","2026-07-31").order("match_date");
console.log(`\n=== (4) schedule_master field ${FID} July: ${sm.data.length} ===`);
sm.data.forEach(r=>console.log(`  ${r.match_date} ${dw(r.match_date)} ${r.match_time} ${r.max_spots}sp`));
if(!sm.data.length) console.log("  (none)");
const smSet=new Set(sm.data.map(r=>`${r.match_date}|${parseHHMM(r.match_time)}`));

// 5. compare
const expected=[
 ["2026-07-09","Thu","9:00 PM - 10:00 PM"],["2026-07-13","Mon","9:00 PM - 10:00 PM"],["2026-07-14","Tue","8:00 PM - 9:00 PM"],
 ["2026-07-16","Thu","9:00 PM - 10:00 PM"],["2026-07-20","Mon","9:00 PM - 10:00 PM"],["2026-07-21","Tue","8:00 PM - 9:00 PM"],
 ["2026-07-23","Thu","9:00 PM - 10:00 PM"],["2026-07-27","Mon","8:00 PM - 9:00 PM"],["2026-07-28","Tue","8:00 PM - 9:00 PM"],
 ["2026-07-30","Thu","8:00 PM - 9:00 PM"],
];
console.log(`\n=== (5) COMPARE expected(${expected.length}) ===`);
console.log("date        dow exp-time             sched?  mdapi-exact?  note");
const alreadySM=[], addable=[], blocked=[], mism=[];
for(const [d,wd,t] of expected){
  const hh=parseHHMM(t);
  const inSM=smSet.has(`${d}|${hh}`);
  const inMD=mmSet.has(`${d}|${hh}`);
  const mdDate=mmByDate.get(d);
  let note="";
  if(!inMD && mdDate){ note=`mdapi has ${d} at ${mdDate.map(r=>r.time).join(",")} (TIME MISMATCH)`; mism.push(`${d} ${wd}: you=${t.split(" - ")[0]} mdapi=${mdDate.map(r=>r.time).join(",")}`);}
  if(inSM) alreadySM.push(`${d} ${wd} ${t}`);
  else if(inMD) addable.push([d,wd,t]);
  else blocked.push(`${d} ${wd} ${t}${mdDate?" (date in mdapi, diff time)":" (not in mdapi)"}`);
  console.log(`  ${d} ${wd} ${t.padEnd(18)} ${String(inSM).padEnd(6)} ${String(inMD).padEnd(12)} ${note}`);
}
console.log(`\nALREADY in schedule_master (${alreadySM.length}):`); alreadySM.forEach(x=>console.log("  "+x));
console.log(`\nIN mdapi, NOT in schedule_master -> SAFE TO ADD (${addable.length}):`); addable.forEach(x=>console.log("  "+x.join(" ")));
console.log(`\nBLOCKED - not in mdapi (needs MatchDay update) (${blocked.length}):`); blocked.forEach(x=>console.log("  "+x));
console.log(`\nTIME MISMATCHES (${mism.length}):`); mism.forEach(x=>console.log("  "+x));
