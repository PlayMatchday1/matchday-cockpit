import { sb } from "./_session_runner.mjs";
async function pageAll(f){const o=[];let x=0;for(;;){const{data,error}=await f().range(x,x+999);if(error)throw error;if(!data?.length)break;o.push(...data);if(data.length<1000)break;x+=1000;}return o;}
const ld=(s)=>{const d=new Date(s);return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`;};

// 1. schedule_master El Paso Q3
const q3 = await sb.from("schedule_master").select("match_date, venue, mdapi_field_id, match_time").eq("city","El Paso").gte("match_date","2026-07-01").lte("match_date","2026-09-30").order("match_date");
console.log("=== (1) schedule_master El Paso Q3 (Jul-Sep 2026) ===");
console.log(`  count=${q3.data.length}, min=${q3.data[0]?.match_date}, max=${q3.data[q3.data.length-1]?.match_date}`);
const byVenue={}; q3.data.forEach(r=>{byVenue[r.venue]=(byVenue[r.venue]||0)+1;});
console.log("  by venue:", JSON.stringify(byVenue));

// El Paso schedule_master beyond Q3 (Q4) and all-time
const all = await sb.from("schedule_master").select("match_date").eq("city","El Paso").order("match_date");
console.log(`  El Paso schedule_master ALL rows: ${all.data.length} (${all.data[0]?.match_date} .. ${all.data[all.data.length-1]?.match_date})`);
const q4 = all.data.filter(r=>r.match_date>"2026-09-30");
console.log(`  El Paso schedule_master AFTER Q3 (Q4+): ${q4.length}`);

// 2. mdapi Galatzan Park Q3 (field 1222 from earlier map) - and by title
console.log("\n=== (2) mdapi_matches El Paso / Galatzan Q3 ===");
const mmTitle = await pageAll(()=>sb.from("mdapi_matches").select("field_id, field_title, city_identifier, start_date, is_cancelled, deleted_at")
  .eq("city_identifier","ELP").gte("start_date","2026-07-01T00:00:00Z").lt("start_date","2026-10-01T00:00:00Z"));
console.log(`  ELP city_identifier mdapi_matches Q3: ${mmTitle.length}`);
const aliveMM = mmTitle.filter(m=>!m.is_cancelled && !m.deleted_at);
console.log(`  alive (bookable): ${aliveMM.length}`);
aliveMM.slice(0,20).forEach(m=>console.log(`    ${ld(m.start_date)} field=${m.field_id} "${m.field_title}" ${m.is_cancelled?"cxl":"alive"}`));
// distinct ELP fields ever
const elpEver = await pageAll(()=>sb.from("mdapi_matches").select("field_id, field_title").eq("city_identifier","ELP"));
console.log("  distinct ELP fields (all time):", JSON.stringify([...new Map(elpEver.map(r=>[r.field_id+"|"+r.field_title,{id:r.field_id,t:r.field_title}])).values()]));

// 3. fin_venues El Paso
console.log("\n=== (3) fin_venues El Paso ===");
const fv = await sb.from("fin_venues").select("id, venue_name, city, billing_type, is_active").eq("city","El Paso");
fv.data.forEach(v=>console.log(`  id=${v.id} "${v.venue_name}" billing=${v.billing_type} is_active=${v.is_active}`));
if(!fv.data.length) console.log("  (none)");

// Historical El Paso data that must STAY
console.log("\n=== Historical El Paso (must stay) ===");
const rev = await sb.from("fin_revenue").select("month, net").eq("city","El Paso");
const revByMonth={}; (rev.data||[]).forEach(r=>{revByMonth[r.month]=(revByMonth[r.month]||0)+Number(r.net||0);});
console.log("  fin_revenue El Paso rows:", (rev.data||[]).length, "by month:", JSON.stringify(revByMonth));
const smHist = await sb.from("schedule_master").select("match_date").eq("city","El Paso").lt("match_date","2026-07-01");
console.log("  schedule_master El Paso pre-Q3 (historical):", smHist.data.length);

// is there a cities table?
console.log("\n=== cities table? ===");
const c = await sb.from("cities").select("*").limit(5);
console.log(c.error ? "  no 'cities' table: "+c.error.message : "  cities table exists: "+JSON.stringify(c.data));
