import { sb } from "./_session_runner.mjs";
const DOW={0:"Sun",1:"Mon",2:"Tue",3:"Wed",4:"Thu",5:"Fri",6:"Sat"};
const dw=(iso)=>new Date(iso+"T00:00:00Z").getUTCDay();
const parseHHMM=(t)=>{const m=/^\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?/i.exec(t);if(!m)return"";let h=+m[1];const mi=m[2]?+m[2]:0;const ap=(m[3]||"").toUpperCase();if(ap==="PM"&&h<12)h+=12;if(ap==="AM"&&h===12)h=0;return `${String(h).padStart(2,"0")}:${String(mi).padStart(2,"0")}`;};

// 1. confirm venue + field mapping for 102 & 1354
const fv = await sb.from("fin_venues").select("id, venue_name, max_spots").in("id",[11,53]);
console.log("=== (1) fin_venues #11/#53 ===", JSON.stringify(fv.data));
const vff = await sb.from("fin_venue_fields").select("fin_venue_id, mdapi_field_id").in("mdapi_field_id",[102,1354]);
console.log("fields 102/1354 ->", JSON.stringify(vff.data), "(both should be fin_venue_id 11)");

// time strings + detail strings
const T={7:"7:00 PM - 8:00 PM",8:"8:00 PM - 9:00 PM",9:"9:00 PM - 10:00 PM"};
const D4="Soccer Central - SC Field 4", D4A="Soccer Central - SC Field 4A", DP="Soccer Central - Premier Match";
// weekly pattern by JS weekday
const PAT={
  1:[[8,102,D4],[9,102,D4]],                 // Mon
  2:[[8,102,D4],[9,1354,DP]],                // Tue
  3:[[8,102,D4],[9,102,D4]],                 // Wed
  4:[[8,102,D4],[9,1354,DP]],                // Thu
  5:[[7,102,D4],[8,102,D4],[9,102,D4A]],     // Fri
  6:[[7,102,D4],[8,102,D4]],                 // Sat
  0:[[7,102,D4A],[8,102,D4]],                // Sun
};
const perWeek=Object.values(PAT).reduce((s,a)=>s+a.length,0);
console.log(`\nweekly slots (listed) = ${perWeek}  (user stated 16)`);

// generate July rows
const rows=[];
for(let d=1;d<=31;d++){
  const iso=`2026-07-${String(d).padStart(2,"0")}`; const wd=dw(iso);
  for(const [hr,field,detail] of (PAT[wd]||[])){
    rows.push({city:"San Antonio",venue:"Soccer Central",detail,match_date:iso,match_time:T[hr],max_spots:36,mdapi_field_id:field});
  }
}
console.log(`\n=== generated rows: ${rows.length} ===`);
// breakdown
const byDetail={}; const byField={};
rows.forEach(r=>{byDetail[r.detail]=(byDetail[r.detail]||0)+1;byField[r.mdapi_field_id]=(byField[r.mdapi_field_id]||0)+1;});
console.log("by detail:", JSON.stringify(byDetail));
console.log("by field:", JSON.stringify(byField));
// weekday occurrence count
const wdCount={};for(let d=1;d<=31;d++){const wd=DOW[dw(`2026-07-${String(d).padStart(2,"0")}`)];wdCount[wd]=(wdCount[wd]||0)+1;}
console.log("July weekday counts:", JSON.stringify(wdCount));

// 2+3. dedup with detail-aware key against existing sm on fields 102/1354
const sm = await sb.from("schedule_master").select("match_date, match_time, detail, mdapi_field_id, venue")
  .in("mdapi_field_id",[102,1354]).gte("match_date","2026-07-01").lte("match_date","2026-07-31");
console.log(`\n=== (2) existing schedule_master July on fields 102/1354: ${sm.data.length} ===`);
sm.data.forEach(r=>console.log(`  ${r.match_date} "${r.match_time}" detail="${r.detail}" field=${r.mdapi_field_id}`));
const exKeys=new Set(sm.data.map(r=>`${r.mdapi_field_id}|${r.match_date}|${parseHHMM(r.match_time)}|${r.detail}`));
const collide=rows.filter(r=>exKeys.has(`${r.mdapi_field_id}|${r.match_date}|${parseHHMM(r.match_time)}|${r.detail}`));
console.log(`\n=== (3) dedup (key = field|date|HH:MM|detail): ${collide.length} conflicts ===`);
collide.forEach(c=>console.log(`  CONFLICT ${c.match_date} ${c.match_time} ${c.detail} field=${c.mdapi_field_id}`));

// self-dup check within generated set (same key twice)
const seen=new Set(); let selfdup=0;
for(const r of rows){const k=`${r.mdapi_field_id}|${r.match_date}|${parseHHMM(r.match_time)}|${r.detail}`;if(seen.has(k))selfdup++;seen.add(k);}
console.log("self-duplicates within generated set:", selfdup);

const cnt=await sb.from("schedule_master").select("*",{count:"exact",head:true});
console.log("\nschedule_master current count:", cnt.count);

// dump full row list for the proposal
console.log("\n=== FULL ROW LIST ===");
rows.forEach(r=>console.log(`  ${r.match_date} ${DOW[dw(r.match_date)]} ${r.match_time.padEnd(18)} f=${String(r.mdapi_field_id).padStart(4)} ${r.detail}`));
