import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = readFileSync("/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local","utf8");
const rd = (n)=>{const m=env.match(new RegExp(`^${n}=(.+)$`,"m"));return m?m[1].trim().replace(/^['"]|['"]$/g,""):null;};
export const sb = createClient(rd("NEXT_PUBLIC_SUPABASE_URL"), rd("SUPABASE_SERVICE_ROLE_KEY"), {auth:{persistSession:false}});
