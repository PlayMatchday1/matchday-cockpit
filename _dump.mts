import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
const svc=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!,process.env.SUPABASE_SERVICE_ROLE_KEY!,{auth:{persistSession:false}});
async function all<T>(t:string,cols:string,order:string):Promise<T[]>{const out:T[]=[];let f=0;const p=1000;for(;;){const {data,error}=await svc.from(t).select(cols).order(order).range(f,f+p-1);if(error)throw new Error(error.message);out.push(...(data as T[]??[]));if(!data||data.length<p)break;f+=p;if(f%20000===0)process.stdout.write(`\r${t}: ${f}`);}return out;}
console.log("dumping matches...");
const matches=await all("mdapi_matches","api_id, start_date, city_identifier, field_id, field_title, is_cancelled, deleted_at","api_id");
console.log(`\nmatches=${matches.length}; dumping players...`);
const players=await all("mdapi_match_players","user_id, match_api_id, paid_status, canceled_at, user_is_fake_player, deleted_at","api_id");
console.log(`\nplayers=${players.length}; writing file...`);
const dir=process.env.CLAUDE_JOB_DIR ? process.env.CLAUDE_JOB_DIR+"/tmp" : "/tmp";
writeFileSync(dir+"/retention_dump.json",JSON.stringify({matches,players}));
console.log("DUMP DONE -> "+dir+"/retention_dump.json");
