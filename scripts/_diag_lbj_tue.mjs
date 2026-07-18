import { sb } from "./_session_runner.mjs";
async function pageAll(f){const o=[];let x=0;for(;;){const{data,error}=await f().range(x,x+999);if(error)throw error;if(!data?.length)break;o.push(...data);if(data.length<1000)break;x+=1000;}return o;}
const DOW={0:"Sun",1:"Mon",2:"Tue",3:"Wed",4:"Thu",5:"Fri",6:"Sat"};
const ld=(s)=>{const d=new Date(s);return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`;};
const lt=(s)=>{const d=new Date(s);let h=d.getUTCHours();const mi=d.getUTCMinutes();const ap=h>=12?"PM":"AM";const h12=h%12===0?12:h%12;return `${h12}:${String(mi).padStart(2,"0")} ${ap}`;};
const dw=(s)=>DOW[new Date(s).getUTCDay()];

// 1. Re-confirm all LBJ/Early College fields (any new field_id?)
console.log("=== (1) distinct fields matching LBJ/Early College/Johnson (post-sync) ===");
const lbj = await pageAll(()=>sb.from("mdapi_matches").select("field_id, field_title, city_identifier")
  .or("field_title.ilike.%LBJ%,field_title.ilike.%Early College%,field_title.ilike.%Johnson%"));
const uniq=[...new Map(lbj.map(r=>[r.field_id+"|"+r.field_title,r])).values()];
uniq.forEach(r=>console.log("  "+JSON.stringify(r)));

// 2. ALL July ATX matches on a Tuesday (any field) - where did Tue slots land?
console.log("\n=== (2) ALL July 2026 ATX matches on TUESDAY (any field) ===");
const atx = await pageAll(()=>sb.from("mdapi_matches").select("field_id, field_title, start_date, is_cancelled, max_player_count, deleted_at")
  .eq("city_identifier","ATX").gte("start_date","2026-07-01T00:00:00Z").lt("start_date","2026-08-01T00:00:00Z"));
const tue = atx.filter(m=>dw(m.start_date)==="Tue").sort((a,b)=>a.start_date.localeCompare(b.start_date));
console.log(`${tue.length} Tuesday ATX matches`);
tue.forEach(m=>console.log(`  ${ld(m.start_date)} ${lt(m.start_date).padEnd(8)} field=${m.field_id} "${m.field_title}" cap=${m.max_player_count} ${m.is_cancelled?"CANCELLED":"alive"}${m.deleted_at?" [del]":""}`));

// 3. LBJ full July date span (min/max) to show coverage
const lbjJul = atx.filter(m=>m.field_id===1486);
const dates=lbjJul.map(m=>ld(m.start_date)).sort();
console.log(`\n=== (3) LBJ field 1486 July coverage: ${lbjJul.length} matches, ${dates[0]} .. ${dates[dates.length-1]} ===`);
