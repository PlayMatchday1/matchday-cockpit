import { sb } from "./_session_runner.mjs";
const { data, error } = await sb.from("schedule_master_audit").select("*").order("created_at",{ascending:false}).limit(1);
if(error) console.log("ERR", error.message); else console.log("schedule_master_audit latest row (columns):\n", JSON.stringify(data[0], null, 2));
