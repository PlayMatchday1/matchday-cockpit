import { sb } from "./_session_runner.mjs";
async function pageAll(f){const o=[];let x=0;for(;;){const{data,error}=await f().range(x,x+999);if(error)throw error;if(!data?.length)break;o.push(...data);if(data.length<1000)break;x+=1000;}return o;}
const DOW={0:"Sun",1:"Mon",2:"Tue",3:"Wed",4:"Thu",5:"Fri",6:"Sat"};
const ld=(s)=>{const d=new Date(s);return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`;};
const lt=(s)=>{const d=new Date(s);let h=d.getUTCHours();const mi=d.getUTCMinutes();const ap=h>=12?"PM":"AM";const h12=h%12===0?12:h%12;return `${h12}:${String(mi).padStart(2,"0")} ${ap}`;};
const dw=(s)=>DOW[new Date(s).getUTCDay()];

// existing schedule_master convention for field 1156 (any month)
const sm = await sb.from("schedule_master").select("venue, detail, max_spots, mdapi_field_id").eq("mdapi_field_id",1156).limit(500);
console.log(`existing schedule_master rows for field 1156 (any month): ${sm.data.length}`);
const combos=new Map(); sm.data.forEach(r=>{const k=`venue="${r.venue}" detail="${r.detail}" spots=${r.max_spots}`;combos.set(k,(combos.get(k)||0)+1);});
[...combos.entries()].sort((a,b)=>b[1]-a[1]).forEach(([k,n])=>console.log(`  ${n}x  ${k}`));
if(!sm.data.length) console.log("  (no existing rows -> use venue='KISC (Katy Intl)', detail=field_title)");

// full-month mdapi off-pattern check
console.log("\nFull-month mdapi field 1156 July - off-pattern flag:");
const mm = await pageAll(()=>sb.from("mdapi_matches").select("start_date, is_cancelled, max_player_count").eq("field_id",1156).gte("start_date","2026-07-01T00:00:00Z").lt("start_date","2026-08-01T00:00:00Z").is("deleted_at",null));
mm.map(m=>({d:ld(m.start_date),w:dw(m.start_date),t:lt(m.start_date),cxl:m.is_cancelled,cap:m.max_player_count})).sort((a,b)=>a.d.localeCompare(b.d)).forEach(r=>{
  const fits=(r.w==="Tue"||r.w==="Fri")&&r.t==="8:00 PM";
  console.log(`  ${r.d} ${r.w} ${r.t.padEnd(8)} cap=${r.cap} ${r.cxl?"CANCELLED":"alive"} ${fits?"on-pattern":"<-- OFF-PATTERN"}`);
});
