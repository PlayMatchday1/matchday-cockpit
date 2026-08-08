import "server-only"; // no-op under --conditions=react-server
// PHASE 13 - FIRST production roster change, reversible: find an upcoming match
// with an OPEN slot, add a fake, read back (present), remove via user-matches, read
// back (gone). STOPS if add doesn't persist or remove fails.
import { apiGet, apiWrite } from "../src/lib/matchdayStageApi";
try { process.loadEnvFile(".env.local"); } catch {}
const line=(s="")=>console.log(s);
type Row={id:number;userId:number;team:number;playerNumber:number};
const roster=async(M:number):Promise<Row[]>=>{const r=await apiGet<any>("production",`/admin/matches/${M}/players`);return Array.isArray(r)?r:(r.data??[]);};
async function main(){
  const listRes=await apiGet<any>("production","/admin/matches",{page:1,limit:60,sortColumn:"startDate",sortDirection:"asc"});
  const rows=Array.isArray(listRes)?listRes:(listRes.data??[]);
  let pick:any=null;
  for(const m of rows){ const cap=Number(m.maxPlayerCount)||0; const teams=(m.teams??[]).length; const cnt=Number(m._count?.players ?? m.playerCount ?? NaN);
    if(cap>0 && teams>0 && Number.isFinite(cnt) && cnt<cap){ pick=m; break; } }
  if(!pick){ // fall back: fetch /players to get true counts for the first few
    for(const m of rows.slice(0,20)){ const cap=Number(m.maxPlayerCount)||0; const teams=(m.teams??[]); if(cap<=0||!teams.length)continue; const r=await roster(m.id); if(r.length<cap){ pick={...m, teams}; break; } } }
  if(!pick){ line("no upcoming match with an open slot found in the scan."); process.exit(3); }
  const M=pick.id; const m=await apiGet<any>("production",`/admin/matches/${M}`);
  const cap=Number(m.maxPlayerCount)||0; const teamNums=(m.teams??[]).map((t:any)=>t.teamNumber).sort();
  const before=await roster(M);
  line(`picked match ${M} "${m.name}" startDate ${m.startDate}: ${before.length}/${cap} players, teams [${teamNums}]`);
  if(before.length>=cap){ line("chosen match is full after re-check; abort."); process.exit(3); }
  const team=teamNums[0]??1; const taken=new Set(before.filter(r=>r.team===team).map(r=>r.playerNumber));
  let num=1; while(taken.has(num)) num++;
  line(`\nREQUEST 1: POST /admin/matches/${M}/fake-players {"team":${team},"playerNumber":${num}}`);
  const added=await apiWrite<Row>("production","POST",`/admin/matches/${M}/fake-players`,{team,playerNumber:num});
  const mid=await roster(M); const row=mid.find(r=>r.id===added.id);
  line(`  -> userMatchId ${added.id}, playerId ${added.userId}; present in read-back: ${!!row}; roster ${before.length} -> ${mid.length}`);
  if(!row){ line("*** add did not persist — STOP, not removing. Investigate."); process.exit(4); }
  line(`\nREQUEST 2: DELETE /admin/matches/user-matches/${added.id}`);
  await apiWrite("production","DELETE",`/admin/matches/user-matches/${added.id}`);
  const after=await roster(M); const gone=!after.find(r=>r.id===added.id);
  line(`  -> gone in read-back: ${gone}; roster ${mid.length} -> ${after.length}`);
  line(`\n${gone && after.length===before.length ? `RESTORED — match ${M} roster back to exactly as found (${after.length} players).` : "*** NOT restored — investigate."}`);
}
main().catch(e=>{console.error("FAILED:",e instanceof Error?e.message.replace(/Body:.*/s,"Body:[omitted]"):e);process.exit(1);});
