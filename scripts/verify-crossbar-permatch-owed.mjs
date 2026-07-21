// Mirrors periodOwed(per_match_minus_manager) + the monthly loop in
// partnerStats.ts against live Crossbar data. Confirms May/June 2026
// owed amounts. matchActive = !fake && !match_canceled (player-canceled
// rows still counted for DPP revenue, matching the flat model).
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = readFileSync("/Users/ryanmancuso/Code/matchday-cockpit/.env.local", "utf8");
const uq = (s) => s.trim().replace(/^["']|["']$/g, "");
const sb = createClient(uq(env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1]), uq(env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)[1]));
async function pageAll(b){const o=[];for(let f=0;;f+=1000){const{data,error}=await b().range(f,f+999);if(error)throw error;if(!data?.length)break;o.push(...data);if(data.length<1000)break;}return o;}
const FAKE=/@matchday\.com$/i;
const isFake=(p)=>p.user_is_fake_player===true||FAKE.test((p.user_email??"").toLowerCase());

const matches = await pageAll(()=>sb.from("mdapi_matches")
  .select("api_id,start_date,is_cancelled,max_player_count").ilike("field_title","%Crossbar Rowlett%"));
const mById=new Map(matches.map(m=>[m.api_id,m]));
const ids=matches.map(m=>m.api_id);
const players=[];
for(let i=0;i<ids.length;i+=200){
  players.push(...await pageAll(()=>sb.from("mdapi_match_players")
    .select("match_api_id,paid_status,promocode_id,amount,is_absent,canceled_at,user_is_fake_player,user_email")
    .in("match_api_id",ids.slice(i,i+200))));
}
// Build PartnerRegRow-equivalents (post mapJoinedRow drops: WAITING, fake, absent).
// derivePaymentType: PAID + no promo => DAILY PAID.
const rows=[];
for(const p of players){
  if(p.paid_status==="WAITING")continue;
  if(isFake(p))continue;
  if(p.is_absent===true)continue;
  const m=mById.get(p.match_api_id); if(!m)continue;
  rows.push({
    match_api_id:p.match_api_id,
    max_player_count:m.max_player_count,
    match_start:m.start_date,
    match_canceled:!!m.is_cancelled,
    payment_type:(p.paid_status==="PAID"&&p.promocode_id==null)?"DAILY PAID":(p.paid_status==="PAID"?"PROMOCODE":(p.paid_status==="FREE"?"MEMBER":null)),
    match_price_paid:(p.amount??0)/100,
    email:p.user_email,
  });
}
const matchActive=rows.filter(r=>!r.match_canceled); // fake already dropped above

const BASE=20, HIGH=30, THRESH=25;
function periodOwed(start,end){
  const byMatch=new Map();
  for(const r of matchActive){
    const ymd=r.match_start.slice(0,10);
    if(ymd<start||ymd>end)continue;
    const key=`id:${r.match_api_id}`;
    const g=byMatch.get(key)??{dpRev:0,capacity:null};
    if(r.payment_type==="DAILY PAID")g.dpRev+=Number(r.match_price_paid??0)||0;
    if(g.capacity==null&&r.max_player_count!=null)g.capacity=r.max_player_count;
    byMatch.set(key,g);
  }
  let qual=0,owed=0;
  const detail=[];
  for(const [k,g] of byMatch){
    qual+=g.dpRev;
    const mgr=(g.capacity!=null&&g.capacity>=THRESH)?HIGH:BASE;
    const share=Math.max(0,g.dpRev-mgr);
    owed+=share;
    detail.push(`${k} cap=${g.capacity} dpRev=$${g.dpRev.toFixed(2)} mgr=$${mgr} share=$${share.toFixed(2)}`);
  }
  return {qual,owed:Math.round(owed*100)/100,detail};
}
for(const [label,s,e] of [["May 2026","2026-05-01","2026-05-31"],["June 2026","2026-06-01","2026-06-30"]]){
  const r=periodOwed(s,e);
  console.log(`\n=== ${label} ===`);
  r.detail.forEach(d=>console.log("  "+d));
  console.log(`  qualifyingRevenue=$${r.qual.toFixed(2)}  OWED=$${r.owed.toFixed(2)}`);
}
