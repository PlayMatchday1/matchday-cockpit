import { createClient } from "@supabase/supabase-js";
process.loadEnvFile("/Users/ryanmancuso/Code/matchday-cockpit/.env.local");
const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth:{persistSession:false} });
const local=(s)=>new Date(String(s).replace(/([+-]\d\d:\d\d|Z)$/,""));
const M=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const EVENT=/\b(tourney|tournament|tournaments|tournamanet|combine|world\s*cup|cup|showcase|showdown|clinic|camp|invitational|special\s*events?)\b/i;
const page=async(mk)=>{let o=[],f=0;for(;;){const{data,error}=await mk().range(f,f+999);if(error)throw new Error(error.message);if(!data?.length)break;o.push(...data);if(data.length<1000)break;f+=1000;}return o;};
const $=(n)=>"$"+Math.round(n).toLocaleString();

// COMBINE_BY_NAME, venueGroups.ts:18-21
const PAIRS=[["Soccer Central","Soccer Central Tournament"],["ATH Katy","ATH Katy Sunday"]];
const venues=(await svc.from("fin_venues").select("*")).data??[];
const links=(await svc.from("fin_venue_fields").select("fin_venue_id,mdapi_field_id")).data??[];
const l=new Map(links.map(x=>[x.mdapi_field_id,x.fin_venue_id]));
const rows=(await page(()=>svc.from("mdapi_matches").select("field_id,field_title,start_date,is_cancelled,deleted_at").is("deleted_at",null)))
  .filter(r=>r.start_date && !EVENT.test(r.field_title??""));
const cnt={};
for(const r of rows){
  const vid=l.get(r.field_id); if(vid==null) continue;
  const v=venues.find(x=>x.id===vid); if(!v) continue;
  if(r.is_cancelled && !v.charge_on_cancel) continue;
  const d=local(r.start_date);
  cnt[`${vid}|${M[d.getMonth()]} ${d.getFullYear()}`]=(cnt[`${vid}|${M[d.getMonth()]} ${d.getFullYear()}`]??0)+1;
}
const ovs=(await svc.from("fin_venue_cost_overrides").select("*")).data??[];

console.log("── the Soccer Central Aug 2026 entry, from fin_change_log ──");
const sc=venues.find(v=>v.venue_name==="Soccer Central");
const scOv=ovs.filter(o=>o.venue_id===sc.id&&o.month==="Aug 2026");
for(const o of scOv) console.log(`   venue_id ${o.venue_id} (${sc.venue_name}, the PRIMARY leg) · $${o.override_amount} · reason=${JSON.stringify(o.reason)} · by ${o.created_by} on ${o.created_at}`);
const log=(await svc.from("fin_change_log").select("*").eq("table_name","fin_venue_cost_overrides")).data??[];
const scLog=log.filter(e=>[e.before_json,e.after_json].some(o=>o&&Number(o.venue_id)===sc.id));
console.log(`   change_log entries for venue ${sc.id}: ${scLog.length}`);
for(const e of scLog) console.log(`      ${e.changed_at} ${e.action} by ${e.changed_by} · ${e.before_json?.month??e.after_json?.month} · ${e.before_json?.override_amount??"—"} → ${e.after_json?.override_amount??"—"} · note=${JSON.stringify(e.note)}`);

console.log("\n── every combined venue with a month value on any leg ──");
for(const [pri,sec] of PAIRS){
  const P=venues.find(v=>v.venue_name===pri), S=venues.find(v=>v.venue_name===sec);
  if(!P||!S){console.log(`   ${pri}: leg missing`);continue;}
  const months=[...new Set(ovs.filter(o=>o.venue_id===P.id||o.venue_id===S.id).map(o=>o.month))];
  if(!months.length){console.log(`   ${pri}: no month value on either leg`);continue;}
  console.log(`\n   ${pri}  (primary id ${P.id} rate $${P.per_match_rate} · secondary "${sec}" id ${S.id} rate $${S.per_match_rate})`);
  console.log("     month      keyed on          amount   primary leg   secondary leg    ROW TOTAL");
  for(const m of months.sort()){
    const op=ovs.find(o=>o.venue_id===P.id&&o.month===m), os=ovs.find(o=>o.venue_id===S.id&&o.month===m);
    const np=cnt[`${P.id}|${m}`]??0, ns=cnt[`${S.id}|${m}`]??0;
    const cp=op?Number(op.override_amount):np*(P.per_match_rate??0);
    const cs=os?Number(os.override_amount):ns*(S.per_match_rate??0);
    const who=op&&os?"BOTH legs":op?"primary only":os?"secondary only":"neither";
    console.log(`     ${m.padEnd(10)} ${who.padEnd(16)} ${(op?$(op.override_amount):"—").padStart(7)} ${($(cp)+` (${np}m)`).padStart(13)} ${($(cs)+` (${ns}m)`).padStart(15)} ${$(cp+cs).padStart(12)}`);
  }
}
