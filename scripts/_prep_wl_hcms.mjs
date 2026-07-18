import { sb } from "./_session_runner.mjs";
async function pageAll(f){const o=[];let x=0;for(;;){const{data,error}=await f().range(x,x+999);if(error)throw error;if(!data?.length)break;o.push(...data);if(data.length<1000)break;x+=1000;}return o;}
const DOW={0:"Sun",1:"Mon",2:"Tue",3:"Wed",4:"Thu",5:"Fri",6:"Sat"};
const dw=(iso)=>DOW[new Date(iso+"T00:00:00Z").getUTCDay()];
const parseHHMM=(t)=>{const m=/^\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?/i.exec(t);let h=+m[1];const mi=m[2]?+m[2]:0;const ap=(m[3]||"").toUpperCase();if(ap==="PM"&&h<12)h+=12;if(ap==="AM"&&h===12)h=0;return `${String(h).padStart(2,"0")}:${String(mi).padStart(2,"0")}`;};

// 1. distinct fields for Westlake + Hill Country in mdapi_matches
for (const [label, pat] of [["WESTLAKE","%westlake%"],["HILL COUNTRY","%hill country%"]]) {
  const data = await pageAll(()=>sb.from("mdapi_matches").select("field_id, field_title, city_identifier").ilike("field_title", pat));
  const uniq=[...new Map(data.map(r=>[r.field_id+"|"+r.field_title,r])).values()];
  console.log(`=== ${label}: ${uniq.length} distinct field(s), ${data.length} matches ===`);
  uniq.forEach(r=>console.log("  "+JSON.stringify(r)));
}

// 2. already registered?
const fv = await sb.from("fin_venues").select("id, venue_name").or("venue_name.ilike.%westlake%,venue_name.ilike.%hill country%");
console.log("\nexisting fin_venues (westlake/hill country):", JSON.stringify(fv.data));
const vff = await sb.from("fin_venue_fields").select("*").in("mdapi_field_id",[1,1453]);
console.log("existing fin_venue_fields for field 1 / 1453:", JSON.stringify(vff.data));

// 3. schedule_master dedup for fields 1 & 1453 in July
const sm = await sb.from("schedule_master").select("id, match_date, match_time, mdapi_field_id, venue")
  .in("mdapi_field_id",[1,1453]).gte("match_date","2026-07-01").lte("match_date","2026-07-31");
console.log(`\nexisting schedule_master rows on fields 1/1453 in July: ${sm.data.length}`);
sm.data.forEach(r=>console.log("  "+JSON.stringify(r)));

// 4. validate date lists
const westDates=["2026-07-04","2026-07-05","2026-07-06","2026-07-08","2026-07-09","2026-07-10","2026-07-11","2026-07-12","2026-07-13","2026-07-15","2026-07-16","2026-07-17","2026-07-18","2026-07-19","2026-07-20","2026-07-22","2026-07-23","2026-07-24","2026-07-25","2026-07-26","2026-07-27","2026-07-29","2026-07-30","2026-07-31"];
const hcmsDates=["2026-07-07","2026-07-14","2026-07-21","2026-07-28"];
console.log(`\n=== Westlake dates: ${westDates.length} (expect 24) ===`);
const westTue = westDates.filter(d=>dw(d)==="Tue");
console.log("  weekday spread:", JSON.stringify(westDates.reduce((a,d)=>{a[dw(d)]=(a[dw(d)]||0)+1;return a;},{})));
console.log("  any Tuesdays (should be NONE):", JSON.stringify(westTue));
// cross-check: is westDates exactly all non-Tue days Jul 4-31?
const allNonTue=[];for(let d=4;d<=31;d++){const iso=`2026-07-${String(d).padStart(2,"0")}`;if(dw(iso)!=="Tue")allNonTue.push(iso);}
const missing=allNonTue.filter(d=>!westDates.includes(d)); const extra=westDates.filter(d=>!allNonTue.includes(d));
console.log("  vs all non-Tue Jul4-31: missing", JSON.stringify(missing), "extra", JSON.stringify(extra));
console.log(`\n=== HCMS dates: ${hcmsDates.length} (expect 4) ===`);
console.log("  weekdays:", JSON.stringify(hcmsDates.map(d=>`${d} ${dw(d)}`)));
console.log("  all Tuesdays?", hcmsDates.every(d=>dw(d)==="Tue"));

// 5. current count
const cnt = await sb.from("schedule_master").select("*",{count:"exact",head:true});
console.log("\nschedule_master current count:", cnt.count, "(expect 2103)");
