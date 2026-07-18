import { sb } from "./_session_runner.mjs";
async function pageAll(f){const o=[];let x=0;for(;;){const{data,error}=await f().range(x,x+999);if(error)throw error;if(!data?.length)break;o.push(...data);if(data.length<1000)break;x+=1000;}return o;}

console.log("=== All Dallas fin_venues ===");
const fv = await sb.from("fin_venues").select("id, venue_name, city, billing_type, per_match_rate, is_active").eq("city","Dallas").order("venue_name");
fv.data.forEach(v=>console.log(`  id=${String(v.id).padStart(3)} "${v.venue_name}" billing=${v.billing_type} rate=${v.per_match_rate} active=${v.is_active}`));

console.log("\n=== All distinct DFW field titles in mdapi_matches ===");
const mm = await pageAll(()=>sb.from("mdapi_matches").select("field_id, field_title, city_identifier").eq("city_identifier","DFW"));
const uniq=[...new Map(mm.map(r=>[r.field_id+"|"+r.field_title,r])).values()].sort((a,b)=>(a.field_title||"").localeCompare(b.field_title||""));
uniq.forEach(r=>console.log(`  field_id=${String(r.field_id).padStart(5)}  "${r.field_title}"`));

console.log("\n=== Broad title search across ALL cities: striker/elm/stadium/star ===");
const any = await pageAll(()=>sb.from("mdapi_matches").select("field_id, field_title, city_identifier").or("field_title.ilike.%striker%,field_title.ilike.%elm%,field_title.ilike.%stadium%,field_title.ilike.%star%"));
[...new Map(any.map(r=>[r.field_id+"|"+r.field_title,r])).values()].forEach(r=>console.log(`  ${r.city_identifier} field_id=${r.field_id} "${r.field_title}"`));
if(!any.length) console.log("  (none)");
