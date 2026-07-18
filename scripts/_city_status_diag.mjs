import { sb } from "./_session_runner.mjs";
async function pageAll(f){const o=[];let x=0;for(;;){const{data,error}=await f().range(x,x+999);if(error)throw error;if(!data?.length)break;o.push(...data);if(data.length<1000)break;x+=1000;}return o;}
const now=new Date("2026-07-10T12:00:00Z");
const day=86400000;
// this monday
const d=new Date(now); const dow=(d.getUTCDay()+6)%7; const mon=new Date(d.getTime()-dow*day); mon.setUTCHours(0,0,0,0);
const recentEnd=mon.getTime();
const splitPoint=mon.getTime()-7*4*day;
const olderStart=mon.getTime()-7*8*day;
for (const cid of ["OKC","STL"]){
  const rows=await pageAll(()=>sb.from("mdapi_matches").select("start_date, is_cancelled, field_id").eq("city_identifier",cid).is("deleted_at",null).order("start_date"));
  const alive=rows.filter(r=>!r.is_cancelled && r.field_id!=null);
  const first=alive.length?alive[0].start_date:null;
  const firstDays=first?Math.round((now.getTime()-new Date(first).getTime())/day):null;
  let recent=new Set(), older=new Set();
  for(const r of alive){const t=new Date(r.start_date).getTime();if(t<olderStart||t>=recentEnd)continue;const k=`${t}|${r.field_id}`;if(t<splitPoint)older.add(k);else recent.add(k);}
  console.log(`${cid}: total alive matches=${alive.length}, FIRST match=${first?.slice(0,10)} (${firstDays} days ago), recent4wk=${recent.size}, prior4wk=${older.size} => current label: ${recent.size<8?"Just launched":"(trend)"}`);
}
