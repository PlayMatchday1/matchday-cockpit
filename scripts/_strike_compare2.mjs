import { sb } from "./_session_runner.mjs";
async function pageAll(f){const o=[];let x=0;for(;;){const{data,error}=await f().range(x,x+999);if(error)throw error;if(!data?.length)break;o.push(...data);if(data.length<1000)break;x+=1000;}return o;}
const DOW={0:"Sun",1:"Mon",2:"Tue",3:"Wed",4:"Thu",5:"Fri",6:"Sat"};
const ld=(s)=>{const d=new Date(s);return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`;};
const lt=(s)=>{const d=new Date(s);let h=d.getUTCHours();const mi=d.getUTCMinutes();const ap=h>=12?"PM":"AM";const h12=h%12===0?12:h%12;return `${h12}:${String(mi).padStart(2,"0")} ${ap}`;};
const dw=(iso)=>DOW[new Date(iso+"T00:00:00Z").getUTCDay()];
const startOf=(t)=>t.split(" - ")[0].trim();
const FID=1387;

// mdapi alive by date
const mm=await pageAll(()=>sb.from("mdapi_matches").select("start_date, is_cancelled, deleted_at")
  .eq("field_id",FID).gte("start_date","2026-07-01T00:00:00Z").lt("start_date","2026-08-01T00:00:00Z").is("deleted_at",null));
const mdByDate=new Map();
mm.filter(m=>!m.is_cancelled).forEach(m=>{const d=ld(m.start_date);(mdByDate.get(d)||mdByDate.set(d,new Set()).get(d)).add(lt(m.start_date));});

// schedule_master by date
const sm=await sb.from("schedule_master").select("match_date, match_time, max_spots").eq("mdapi_field_id",FID)
  .gte("match_date","2026-07-01").lte("match_date","2026-07-31");
const smByDate=new Map();
sm.data.forEach(r=>{(smByDate.get(r.match_date)||smByDate.set(r.match_date,[]).get(r.match_date)).push(startOf(r.match_time));});

const expected=[
 ["2026-07-09","9:00 PM"],["2026-07-13","9:00 PM"],["2026-07-14","8:00 PM"],["2026-07-16","9:00 PM"],["2026-07-20","9:00 PM"],
 ["2026-07-21","8:00 PM"],["2026-07-23","9:00 PM"],["2026-07-27","8:00 PM"],["2026-07-28","8:00 PM"],["2026-07-30","8:00 PM"],
];
const cat={exact:[],smConflict:[],addable:[],blocked:[]};
console.log("date        dow  you     | schedule_master        | mdapi(alive)        => classification");
for (const [d,you] of expected){
  const smTimes=smByDate.get(d)||[];
  const mdTimes=[...(mdByDate.get(d)||[])];
  const smExact=smTimes.includes(you);
  const mdExact=mdTimes.includes(you);
  let cls;
  if (smExact) { cls="ALREADY (exact)"; cat.exact.push(d+" "+you); }
  else if (smTimes.length) { cls=`SM CONFLICT (sched=${smTimes.join(",")} vs you=${you}${mdExact?"; mdapi=you":mdTimes.length?"; mdapi="+mdTimes.join(","):"; mdapi=none"})`; cat.smConflict.push({d,you,sm:smTimes.join(","),md:mdExact?"you":(mdTimes.join(",")||"none")}); }
  else if (mdExact) { cls="SAFE TO ADD"; cat.addable.push(d+" "+you); }
  else { cls=`BLOCKED (not in mdapi${mdTimes.length?", mdapi has "+mdTimes.join(","):""})`; cat.blocked.push(d+" "+you); }
  console.log(`  ${d} ${dw(d)}  ${you.padEnd(7)}| ${(smTimes.join(",")||"-").padEnd(22)} | ${(mdTimes.join(",")||"-").padEnd(18)} => ${cls}`);
}
console.log("\n--- SUMMARY ---");
console.log(`ALREADY exact (${cat.exact.length}): ${cat.exact.join(" | ")}`);
console.log(`SAFE TO ADD (in mdapi, not in sched) (${cat.addable.length}): ${cat.addable.join(" | ")||"(none)"}`);
console.log(`SM TIME CONFLICT (date exists, diff time) (${cat.smConflict.length}):`); cat.smConflict.forEach(c=>console.log(`   ${c.d}: schedule_master=${c.sm}  |  you=${c.you}  |  mdapi=${c.md}`));
console.log(`BLOCKED not in mdapi & not in sched (${cat.blocked.length}): ${cat.blocked.join(" | ")||"(none)"}`);
