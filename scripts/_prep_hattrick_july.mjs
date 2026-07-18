import { sb } from "./_session_runner.mjs";
async function pageAll(f){const o=[];let x=0;for(;;){const{data,error}=await f().range(x,x+999);if(error)throw error;if(!data?.length)break;o.push(...data);if(data.length<1000)break;x+=1000;}return o;}
const DOW={0:"Sun",1:"Mon",2:"Tue",3:"Wed",4:"Thu",5:"Fri",6:"Sat"};
const ld=(s)=>{const d=new Date(s);return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`;};
const lt=(s)=>{const d=new Date(s);let h=d.getUTCHours();const mi=d.getUTCMinutes();const ap=h>=12?"PM":"AM";const h12=h%12===0?12:h%12;return `${h12}:${String(mi).padStart(2,"0")} ${ap}`;};
const dw=(iso)=>new Date(iso+"T00:00:00Z").getUTCDay();
const dwn=(iso)=>DOW[dw(iso)];
const parseHHMM=(t)=>{const m=/^\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?/i.exec(t);if(!m)return"";let h=+m[1];const mi=m[2]?+m[2]:0;const ap=(m[3]||"").toUpperCase();if(ap==="PM"&&h<12)h+=12;if(ap==="AM"&&h===12)h=0;return `${String(h).padStart(2,"0")}:${String(mi).padStart(2,"0")}`;};

// 1. existing schedule_master field 1024 July
console.log("=== (1) existing schedule_master field 1024 July ===");
const sm = await sb.from("schedule_master").select("match_date, match_time, venue, detail, max_spots").eq("mdapi_field_id",1024).gte("match_date","2026-07-01").lte("match_date","2026-07-31").order("match_date");
console.log(`  ${sm.data.length} rows:`);
sm.data.forEach(r=>console.log(`  ${r.match_date} ${dwn(r.match_date)} "${r.match_time}" ${r.max_spots}sp venue="${r.venue}" detail="${r.detail}"`));
const smKeys=new Set(sm.data.map(r=>`${r.match_date}|${parseHHMM(r.match_time)}`));

// generate pattern
const T={7:"7:00 PM - 8:00 PM",8:"8:00 PM - 9:00 PM"};
const PAT={2:[7,8],3:[7,8],5:[7],6:[7],0:[7,8]}; // Tue,Wed,Fri,Sat,Sun
const gen=[];
for(let d=1;d<=31;d++){const iso=`2026-07-${String(d).padStart(2,"0")}`;for(const hr of (PAT[dw(iso)]||[])){gen.push({city:"Austin",venue:"Hattrick",detail:"The Hattrick",match_date:iso,match_time:T[hr],max_spots:18,mdapi_field_id:1024});}}
console.log(`\n=== generated pattern slots: ${gen.length} (expect 35) ===`);
const wk={};gen.forEach(r=>{wk[dwn(r.match_date)]=(wk[dwn(r.match_date)]||0)+1;});
console.log("  by weekday:", JSON.stringify(wk));

// 2. dedup
const dup=gen.filter(r=>smKeys.has(`${r.match_date}|${parseHHMM(r.match_time)}`));
const toAdd=gen.filter(r=>!smKeys.has(`${r.match_date}|${parseHHMM(r.match_time)}`));
console.log(`\n=== (2) dedup (field|date|HH:MM): ${dup.length} already exist -> SKIP, ${toAdd.length} to add ===`);
dup.forEach(r=>console.log(`  SKIP (exists): ${r.match_date} ${dwn(r.match_date)} ${r.match_time}`));

// 3. mdapi field 1024 July - this week context
console.log("\n=== (3) mdapi field 1024 July (deleted_at NULL) ===");
const mm = await pageAll(()=>sb.from("mdapi_matches").select("start_date, field_title, is_cancelled, max_player_count").eq("field_id",1024).gte("start_date","2026-07-01T00:00:00Z").lt("start_date","2026-08-01T00:00:00Z").is("deleted_at",null));
console.log(`  ${mm.data?.length ?? mm.length} matches`);
const rows=mm.map(m=>({d:ld(m.start_date),w:DOW[new Date(m.start_date).getUTCDay()],t:lt(m.start_date),ft:m.field_title,cxl:m.is_cancelled,cap:m.max_player_count})).sort((a,b)=>a.d.localeCompare(b.d)||a.t.localeCompare(b.t));
rows.forEach(r=>console.log(`  ${r.d} ${r.w} ${r.t.padEnd(8)} cap=${r.cap} ${r.cxl?"CANCELLED":"alive"} "${r.ft}"`));
// this week (Jul 6-12, today Jul 10)
const thisWk=rows.filter(r=>r.d>="2026-07-06"&&r.d<="2026-07-12");
console.log(`\n  this week (Jul 6-12): ${thisWk.length} mdapi matches ${thisWk.length?"(present ✓)":"(NONE - flag)"}`);

const cnt=await sb.from("schedule_master").select("*",{count:"exact",head:true});
console.log("\nschedule_master current count:", cnt.count, "(expect 2241)");
console.log(`\n=== SUMMARY: generate ${gen.length}, skip ${dup.length} existing, ADD ${toAdd.length}. Post-count would be ${cnt.count}+${toAdd.length}=${cnt.count+toAdd.length} ===`);
