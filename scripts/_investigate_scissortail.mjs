import { sb } from "./_session_runner.mjs";
async function pageAll(f){const o=[];let x=0;for(;;){const{data,error}=await f().range(x,x+999);if(error)throw error;if(!data?.length)break;o.push(...data);if(data.length<1000)break;x+=1000;}return o;}
const DOW={0:"Sun",1:"Mon",2:"Tue",3:"Wed",4:"Thu",5:"Fri",6:"Sat"};
const ld=(s)=>{const d=new Date(s);return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`;};
const lt=(s)=>{const d=new Date(s);let h=d.getUTCHours();const mi=d.getUTCMinutes();const ap=h>=12?"PM":"AM";const h12=h%12===0?12:h%12;return `${h12}:${String(mi).padStart(2,"0")} ${ap}`;};
const dw=(iso)=>DOW[new Date(iso.length>10?iso:iso+"T00:00:00Z").getUTCDay()];
const parseHHMM=(t)=>{const m=/^\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?/i.exec(t);if(!m)return"";let h=+m[1];const mi=m[2]?+m[2]:0;const ap=(m[3]||"").toUpperCase();if(ap==="PM"&&h<12)h+=12;if(ap==="AM"&&h===12)h=0;return `${String(h).padStart(2,"0")}:${String(mi).padStart(2,"0")}`;};

// 1. venue
const v=await sb.from("fin_venues").select("id, venue_name, city, billing_type, per_match_rate, cost_per_match, max_spots, charge_on_cancel, is_active").ilike("venue_name","%scissortail%");
if(!v.data.length){console.log("*** Scissortail NOT found in fin_venues ***");process.exit(0);}
console.log("fin_venues Scissortail:", JSON.stringify(v.data[0]));
const vid=v.data[0].id;
const cocFlag=v.data[0].charge_on_cancel;
const defSpots=(v.data[0].max_spots==null)?18:v.data[0].max_spots;

// 2. field mapping
const vff=await sb.from("fin_venue_fields").select("mdapi_field_id, field_title_at_link").eq("fin_venue_id",vid);
console.log("field mapping:", JSON.stringify(vff.data));
if(vff.data.length!==1) console.log(`*** NOTE: ${vff.data.length} field(s) mapped ***`);
const FID=Number(vff.data[0].mdapi_field_id);
console.log(`\n=> venue #${vid}, field_id=${FID}, billing=${v.data[0].billing_type}, charge_on_cancel=${cocFlag}, max_spots=${defSpots}\n`);

// 3. PART 1: Jul 1-8
console.log("========== PART 1: Jul 1-8 ==========");
const mm=await pageAll(()=>sb.from("mdapi_matches").select("start_date, is_cancelled, deleted_at, max_player_count")
  .eq("field_id",FID).gte("start_date","2026-07-01T00:00:00Z").lt("start_date","2026-07-09T00:00:00Z").is("deleted_at",null));
const mmRows=mm.map(m=>({date:ld(m.start_date),dow:dw(m.start_date),time:lt(m.start_date),hhmm:parseHHMM(lt(m.start_date)),cancelled:m.is_cancelled,cap:m.max_player_count})).sort((a,b)=>a.date.localeCompare(b.date)||a.hhmm.localeCompare(b.hhmm));
console.log(`\nmdapi (deleted_at NULL) Jul 1-8: ${mmRows.length}`);
mmRows.forEach(r=>console.log(`  ${r.date} ${r.dow} ${r.time.padEnd(8)} cap=${r.cap} ${r.cancelled?"CANCELLED":"alive"}`));
const mmKeys=new Set(mmRows.map(r=>`${r.date}|${r.hhmm}`));
const aliveRows=mmRows.filter(r=>!r.cancelled), cxlRows=mmRows.filter(r=>r.cancelled);

const sm1=await sb.from("schedule_master").select("match_date, match_time, max_spots").eq("mdapi_field_id",FID).gte("match_date","2026-07-01").lte("match_date","2026-07-08").order("match_date");
console.log(`\nschedule_master Jul 1-8: ${sm1.data.length}`);
sm1.data.forEach(r=>console.log(`  ${r.match_date} ${dw(r.match_date)} "${r.match_time}" ${r.max_spots}sp`));
const smKeys=new Set(sm1.data.map(r=>`${r.match_date}|${parseHHMM(r.match_time)}`));

console.log("\n--- GAPS: in mdapi, missing from schedule_master ---");
const gaps=mmRows.filter(r=>!smKeys.has(`${r.date}|${r.hhmm}`));
if(!gaps.length)console.log("  (none)"); else gaps.forEach(r=>console.log(`  ${r.date} ${r.dow} ${r.time} (${r.cancelled?"CANCELLED":"alive"})`));
console.log("\n--- DRIFT: in schedule_master, not in mdapi (deleted_at NULL) ---");
const drift=sm1.data.filter(r=>!mmKeys.has(`${r.match_date}|${parseHHMM(r.match_time)}`));
if(!drift.length)console.log("  (none)"); else drift.forEach(r=>console.log(`  ${r.match_date} ${dw(r.match_date)} "${r.match_time}"`));

console.log(`\n--- Cancelled handling (charge_on_cancel=${cocFlag}) ---`);
console.log(`  cancelled mdapi matches Jul 1-8: ${cxlRows.length}`);
cxlRows.forEach(r=>console.log(`    ${r.date} ${r.dow} ${r.time}`));
console.log(`  => ${cocFlag ? "charge_on_cancel=TRUE: cancelled matches ARE billed -> INCLUDE in schedule_master" : "charge_on_cancel=FALSE: cancelled not billed -> SKIP"}`);
console.log(`  Part 1 alive gaps to add: ${aliveRows.filter(r=>!smKeys.has(`${r.date}|${r.hhmm}`)).length}`);

// 4. PART 2
console.log("\n========== PART 2: future Tue/Thu/Sun 8 PM (Jul 9-31) ==========");
const expected=["2026-07-09","2026-07-12","2026-07-14","2026-07-16","2026-07-19","2026-07-21","2026-07-23","2026-07-26","2026-07-28","2026-07-30"];
const sm2=await sb.from("schedule_master").select("match_date, match_time").eq("mdapi_field_id",FID).gte("match_date","2026-07-09").lte("match_date","2026-07-31").order("match_date");
const sm2Keys=new Set(sm2.data.map(r=>`${r.match_date}|${parseHHMM(r.match_time)}`));
console.log(`existing schedule_master Jul 9-31 for field ${FID}: ${sm2.data.length}`);
sm2.data.forEach(r=>console.log(`  ${r.match_date} ${dw(r.match_date)} "${r.match_time}"`));
const toAdd=[]; let conflicts=0;
console.log("\nexpected 10 @ 8:00 PM — dedup:");
for (const d of expected){const dup=sm2Keys.has(`${d}|${parseHHMM("8:00 PM")}`);if(dup)conflicts++;else toAdd.push(d);console.log(`  ${d} ${dw(d)} 8:00 PM  ${dup?"** exists **":"MISSING -> add"}`);}
console.log("weekday spread:", JSON.stringify(expected.reduce((a,d)=>{a[dw(d)]=(a[dw(d)]||0)+1;return a;},{})));
console.log(`Part 2: ${toAdd.length} to add, ${conflicts} conflicts. toAdd=${JSON.stringify(toAdd)}`);

const cnt=await sb.from("schedule_master").select("*",{count:"exact",head:true});
console.log("\nschedule_master current count:", cnt.count, "(expect 2151)");
