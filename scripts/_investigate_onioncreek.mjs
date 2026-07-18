import { sb } from "./_session_runner.mjs";
async function pageAll(f){const o=[];let x=0;for(;;){const{data,error}=await f().range(x,x+999);if(error)throw error;if(!data?.length)break;o.push(...data);if(data.length<1000)break;x+=1000;}return o;}
const DOW={0:"Sun",1:"Mon",2:"Tue",3:"Wed",4:"Thu",5:"Fri",6:"Sat"};
const ld=(s)=>{const d=new Date(s);return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`;};
const lt=(s)=>{const d=new Date(s);let h=d.getUTCHours();const mi=d.getUTCMinutes();const ap=h>=12?"PM":"AM";const h12=h%12===0?12:h%12;return `${h12}:${String(mi).padStart(2,"0")} ${ap}`;};
const dw=(s)=>DOW[new Date(s.length>10?s:s+"T00:00:00Z").getUTCDay()];

// 1. fin_venues Onion Creek
console.log("=== (1) fin_venues Onion Creek ===");
const fv = await sb.from("fin_venues").select("id, venue_name, city, billing_type, per_match_rate, cost_per_match, max_spots, charge_on_cancel, is_active").ilike("venue_name","%onion creek%");
fv.data.forEach(v=>console.log("  "+JSON.stringify(v)));
const ids = fv.data.map(v=>v.id);

// 2. field mappings
console.log("\n=== (2) fin_venue_fields for Onion Creek venue(s) ===");
const vff = await sb.from("fin_venue_fields").select("fin_venue_id, mdapi_field_id, field_title_at_link").in("fin_venue_id", ids);
vff.data.sort((a,b)=>Number(a.mdapi_field_id)-Number(b.mdapi_field_id)).forEach(r=>console.log(`  field_id=${r.mdapi_field_id} -> venue #${r.fin_venue_id}  linked="${r.field_title_at_link}"`));
const fieldIds = vff.data.map(r=>Number(r.mdapi_field_id));
console.log("  => field_ids:", JSON.stringify(fieldIds));

// 3. mdapi July field usage
console.log("\n=== (3) mdapi_matches Onion Creek July (deleted_at NULL) ===");
const mm = await pageAll(()=>sb.from("mdapi_matches").select("field_id, field_title, start_date, is_cancelled, max_player_count")
  .or(`field_title.ilike.%onion creek%${fieldIds.length?`,field_id.in.(${fieldIds.join(",")})`:""}`)
  .gte("start_date","2026-07-01T00:00:00Z").lt("start_date","2026-08-01T00:00:00Z").is("deleted_at",null));
const grp=new Map();
for(const m of mm){const k=`${m.field_id}|${m.field_title}`;if(!grp.has(k))grp.set(k,{fid:m.field_id,t:m.field_title,n:0,dates:[]});const g=grp.get(k);g.n++;g.dates.push(ld(m.start_date));}
[...grp.values()].sort((a,b)=>(a.t||"").localeCompare(b.t||"")).forEach(g=>{const ds=g.dates.sort();console.log(`  field_id=${String(g.fid).padStart(5)} "${g.t}"  ${g.n} matches  ${ds[0]}..${ds[ds.length-1]}  mapped=${fieldIds.includes(Number(g.fid))?"Y":"** N **"}`);});

// 4. Tue/Thu concurrency - same or different field_id
console.log("\n=== (4) Tue/Thu concurrency (same date+time, which field_ids?) ===");
const byDT=new Map();
for(const m of mm){if(m.is_cancelled)continue;const w=dw(m.start_date);if(w!=="Tue"&&w!=="Thu")continue;const k=`${ld(m.start_date)}|${lt(m.start_date)}`;if(!byDT.has(k))byDT.set(k,[]);byDT.get(k).push({fid:m.field_id,t:m.field_title});}
[...byDT.entries()].sort().slice(0,12).forEach(([k,arr])=>{const fids=[...new Set(arr.map(a=>a.fid))];console.log(`  ${k} ${dw(k.split("|")[0])}: ${arr.length} matches, field_ids={${fids.join(",")}} ${fids.length>1?"<- DIFFERENT fields":arr.length>1?"<- SAME field_id x"+arr.length:""}`);});

// Part 2: existing schedule_master July
console.log("\n=== PART 2: schedule_master Onion Creek July ===");
const sm = await sb.from("schedule_master").select("match_date, match_time, venue, detail, max_spots, mdapi_field_id")
  .or(`venue.ilike.%onion creek%,detail.ilike.%onion creek%${fieldIds.length?`,mdapi_field_id.in.(${fieldIds.join(",")})`:""}`)
  .gte("match_date","2026-07-01").lte("match_date","2026-07-31").order("match_date");
console.log(`  ${sm.data.length} rows`);
sm.data.forEach(r=>console.log(`  ${r.match_date} ${dw(r.match_date)} "${r.match_time}" f=${r.mdapi_field_id} venue="${r.venue}" detail="${r.detail}" ${r.max_spots}sp`));

// Part 3: mdapi Jul 1-10
console.log("\n=== PART 3: mdapi Onion Creek Jul 1-10 (deleted_at NULL) ===");
const mm10 = mm.filter(m=>ld(m.start_date)>="2026-07-01"&&ld(m.start_date)<="2026-07-10").sort((a,b)=>a.start_date.localeCompare(b.start_date));
mm10.forEach(m=>console.log(`  ${ld(m.start_date)} ${dw(m.start_date)} ${lt(m.start_date).padEnd(8)} f=${m.field_id} "${m.field_title}" cap=${m.max_player_count} ${m.is_cancelled?"CANCELLED":"alive"}`));

// existing sm convention any month
console.log("\n=== existing schedule_master Onion Creek convention (any month) ===");
const smAll = await sb.from("schedule_master").select("venue, detail, mdapi_field_id, max_spots").or(`venue.ilike.%onion creek%${fieldIds.length?`,mdapi_field_id.in.(${fieldIds.join(",")})`:""}`).limit(500);
const combos=new Map(); smAll.data.forEach(r=>{const k=`venue="${r.venue}" detail="${r.detail}" f=${r.mdapi_field_id} ${r.max_spots}sp`;combos.set(k,(combos.get(k)||0)+1);});
[...combos.entries()].sort((a,b)=>b[1]-a[1]).slice(0,12).forEach(([k,n])=>console.log(`  ${String(n).padStart(3)}x  ${k}`));

const cnt=await sb.from("schedule_master").select("*",{count:"exact",head:true});
console.log("\nschedule_master current count:", cnt.count);
