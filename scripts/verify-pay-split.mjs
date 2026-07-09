import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = readFileSync("/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local","utf8");
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)[1].trim();
const sb = createClient(url,key);
const wkStart="2026-05-04", wkEnd="2026-05-10", THRESH=25;
const inCT=(iso)=>new Intl.DateTimeFormat("en-CA",{timeZone:"America/Chicago",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(iso));
let matches=[];
for(let f=0;;f+=1000){const{data}=await sb.from("mdapi_matches").select("api_id,city_identifier,field_title,start_date,is_cancelled,manager_email,manager_first_name,manager_last_name,second_manager_id,max_player_count,raw").gte("start_date","2026-05-03T00:00:00Z").lt("start_date","2026-05-12T00:00:00Z").order("api_id").range(f,f+999);if(!data?.length)break;matches.push(...data);if(data.length<1000)break;}
const inWeek=matches.filter(m=>!m.is_cancelled&&m.start_date&&inCT(m.start_date)>=wkStart&&inCT(m.start_date)<=wkEnd);
const secIds=[...new Set(inWeek.map(m=>m.second_manager_id).filter(Boolean))];
const secById=new Map();
if(secIds.length){const{data}=await sb.from("mdapi_users").select("id,email,first_name,last_name").in("id",secIds);for(const r of data??[])secById.set(r.id,r);}
const pay=(mx,co)=>co?20:(mx>=THRESH?30:20);
const acc=new Map();
const add=(em,nm,role,m,co)=>{if(!em)return;const k=em.toLowerCase();if(!acc.has(k))acc.set(k,{name:nm,city:m.city_identifier,matches:[]});acc.get(k).matches.push({pay:pay(m.max_player_count,co)});};
for(const m of inWeek){const co=!!m.second_manager_id||!!m.raw?.secondManager;if(m.manager_email){const nm=[m.manager_first_name,m.manager_last_name].filter(Boolean).join(" ")||m.manager_email;add(m.manager_email,nm,"primary",m,co);}if(m.second_manager_id){const u=secById.get(m.second_manager_id);if(u?.email){const nm=[u.first_name,u.last_name].filter(Boolean).join(" ")||u.email;add(u.email,nm,"secondary",m,co);}}}
const rows=[...acc.values()].map(r=>{const c20=r.matches.filter(x=>x.pay===20).length;const c30=r.matches.filter(x=>x.pay===30).length;return{name:r.name,city:r.city,c20,c30,base:c20*20+c30*30};});
rows.sort((a,b)=>(a.city??"").localeCompare(b.city??"")||b.base-a.base);
console.log("\nManager · $20 matches · $30 matches · Base (reconciled)");
console.log("-".repeat(70));
for(const r of rows){console.log(`${(r.city??"—").padEnd(5)}  ${r.name.padEnd(28)}  ${String(r.c20).padStart(2)} × $20  ${String(r.c30).padStart(2)} × $30  $${String(r.base).padStart(4)}`);}
const t20=rows.reduce((s,r)=>s+r.c20,0),t30=rows.reduce((s,r)=>s+r.c30,0),tb=rows.reduce((s,r)=>s+r.base,0);
console.log("-".repeat(70));
console.log(`NETWORK                            ${t20} × $20  ${t30} × $30  $${tb}`);
console.log(`Reconcile: ${t20}*20 + ${t30}*30 = ${t20*20+t30*30} (matches base $${tb}: ${t20*20+t30*30===tb?"OK":"MISMATCH"})`);
