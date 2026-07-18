import { sb } from "./_session_runner.mjs";
async function pageAll(f){const o=[];let x=0;for(;;){const{data,error}=await f().range(x,x+999);if(error)throw error;if(!data?.length)break;o.push(...data);if(data.length<1000)break;x+=1000;}return o;}
const DOW={0:"Sun",1:"Mon",2:"Tue",3:"Wed",4:"Thu",5:"Fri",6:"Sat"};
const dw=(iso)=>DOW[new Date(iso.length>10?iso:iso+"T00:00:00Z").getUTCDay()];

console.log("=== (1) fin_venues Soccer Central ===");
const fv = await sb.from("fin_venues").select("id, venue_name, city, billing_type, per_match_rate, cost_per_match, max_spots, charge_on_cancel, is_active").ilike("venue_name","%soccer central%");
fv.data.forEach(v=>console.log("  "+JSON.stringify(v)));

console.log("\n=== (2) fin_venue_fields mappings ===");
const ids = fv.data.map(v=>v.id);
const vff = await sb.from("fin_venue_fields").select("fin_venue_id, mdapi_field_id, field_title_at_link").in("fin_venue_id", ids);
const mappedIds = new Set(vff.data.map(r=>Number(r.mdapi_field_id)));
vff.data.sort((a,b)=>Number(a.mdapi_field_id)-Number(b.mdapi_field_id)).forEach(r=>{
  const v=fv.data.find(x=>x.id===r.fin_venue_id);
  console.log(`  field_id=${String(r.mdapi_field_id).padStart(5)} -> venue #${r.fin_venue_id} "${v?.venue_name}"  linked_title="${r.field_title_at_link}"`);
});

console.log("\n=== (3) mdapi_matches Soccer Central July (deleted_at NULL) ===");
const mm = await pageAll(()=>sb.from("mdapi_matches").select("field_id, field_title, start_date, is_cancelled, max_player_count")
  .ilike("field_title","%soccer central%").gte("start_date","2026-07-01T00:00:00Z").lt("start_date","2026-08-01T00:00:00Z").is("deleted_at",null));
const grp = new Map();
for (const m of mm){const k=`${m.field_id}|${m.field_title}`; if(!grp.has(k))grp.set(k,{field_id:m.field_id,title:m.field_title,total:0,alive:0,cxl:0,caps:new Set()});const g=grp.get(k);g.total++;if(m.is_cancelled)g.cxl++;else g.alive++;g.caps.add(m.max_player_count);}
for (const g of [...grp.values()].sort((a,b)=>(a.title||"").localeCompare(b.title||""))){
  const mapped = mappedIds.has(Number(g.field_id)) ? "YES" : "** NOT MAPPED **";
  console.log(`  field_id=${String(g.field_id).padStart(5)} "${g.title}"  total=${g.total} alive=${g.alive} cxl=${g.cxl} caps={${[...g.caps].join(",")}}  mapped=${mapped}`);
}

console.log("\n  --- the 3 target titles specifically ---");
for (const t of ["Soccer Central Field 4","Soccer Central Field 4A","Soccer Central Premier Field 4"]){
  const rows = mm.filter(m=>(m.field_title||"")===t);
  const fids=[...new Set(rows.map(m=>m.field_id))];
  console.log(`  "${t}": ${rows.length} July matches, field_id(s)=${JSON.stringify(fids)}${fids.length?" mapped="+fids.map(f=>mappedIds.has(Number(f))?"Y":"N").join(","):""}`);
}

console.log("\n=== (4) schedule_master Soccer Central July ===");
const sm = await sb.from("schedule_master").select("match_date, match_time, venue, detail, max_spots, mdapi_field_id")
  .or("venue.ilike.%soccer central%,detail.ilike.%soccer central%").gte("match_date","2026-07-01").lte("match_date","2026-07-31").order("match_date");
console.log(`  ${sm.data.length} rows`);
sm.data.forEach(r=>console.log(`  ${r.match_date} ${dw(r.match_date)} "${r.match_time}" venue="${r.venue}" detail="${r.detail}" ${r.max_spots}sp field=${r.mdapi_field_id}`));

console.log("\n=== existing schedule_master Soccer Central convention (any month) ===");
const smAll = await sb.from("schedule_master").select("venue, detail, mdapi_field_id").or("venue.ilike.%soccer central%,detail.ilike.%soccer central%").limit(500);
const combos = new Map(); smAll.data.forEach(r=>{const k=`venue="${r.venue}" detail="${r.detail}" field=${r.mdapi_field_id}`;combos.set(k,(combos.get(k)||0)+1);});
[...combos.entries()].sort((a,b)=>b[1]-a[1]).slice(0,15).forEach(([k,n])=>console.log(`  ${String(n).padStart(3)}x  ${k}`));
