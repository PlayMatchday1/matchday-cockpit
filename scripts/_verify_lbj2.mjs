import { sb } from "./_session_runner.mjs";

async function pageAll(factory){const out=[];let f=0;for(;;){const{data,error}=await factory().range(f,f+999);if(error)throw error;if(!data?.length)break;out.push(...data);if(data.length<1000)break;f+=1000;}return out;}

// 1. mdapi_matches: any field matching LBJ / Early College / Johnson
console.log("=== (1) mdapi_matches field_title ILIKE LBJ/Early College/Johnson (distinct field) ===");
{
  const data = await pageAll(()=>sb.from("mdapi_matches")
    .select("field_id, field_title, city_identifier")
    .or("field_title.ilike.%LBJ%,field_title.ilike.%Early College%,field_title.ilike.%Johnson%"));
  const uniq=[...new Map(data.map(r=>[r.field_id+"|"+r.field_title,r])).values()];
  console.log(`${uniq.length} distinct field(s) across ${data.length} matches`);
  uniq.forEach(r=>console.log("  "+JSON.stringify(r)));
}

// 2. fin_venue_fields joined (does any mapped field title contain these?)
console.log("\n=== (2) fin_venues LBJ/Early College/Johnson (re-confirm) ===");
{
  const { data } = await sb.from("fin_venues").select("id, city, venue_name")
    .or("venue_name.ilike.%LBJ%,venue_name.ilike.%Early College%,venue_name.ilike.%Johnson%");
  console.log(`${data.length} rows`); data.forEach(r=>console.log("  "+JSON.stringify(r)));
}

// 3. Distinct city_identifiers (so we know Austin's code), then all Austin-area fields
console.log("\n=== (3a) distinct city_identifier values in mdapi_matches ===");
{
  const data = await pageAll(()=>sb.from("mdapi_matches").select("city_identifier"));
  const c={}; data.forEach(r=>{c[r.city_identifier]=(c[r.city_identifier]||0)+1;});
  console.log(JSON.stringify(c));
}
console.log("\n=== (3b) all distinct fields for Austin-area city_identifiers ===");
{
  const data = await pageAll(()=>sb.from("mdapi_matches")
    .select("field_id, field_title, city_identifier")
    .in("city_identifier",["ATX","AUS","austin","Austin"]));
  const uniq=[...new Map(data.map(r=>[r.field_id+"|"+r.field_title,r])).values()]
    .sort((a,b)=>(a.field_title||"").localeCompare(b.field_title||""));
  console.log(`${uniq.length} distinct field(s)`);
  uniq.forEach(r=>console.log(`  field_id=${String(r.field_id).padStart(5)}  ${(r.city_identifier||"").padEnd(6)} ${r.field_title}`));
}
