// ONE REAL TEXT, to a single named user id, through the real route. GO=1 sends.
import { createClient } from "@supabase/supabase-js";
process.loadEnvFile(".env.local");
const MATCH = process.env.MATCH ?? "19036";
const UID = Number(process.env.USERID ?? 78);
const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
const link = await svc.auth.admin.generateLink({ type: "magiclink", email: "rmancuso@playmatchday.com" });
const vv = await anon.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token });
const H = { Authorization: `Bearer ${vv.data.session.access_token}`, "Content-Type": "application/json" };
const url = `http://localhost:3000/api/match-chats/${MATCH}/notify`;

const preview = await (await fetch(url, { headers: H, cache: "no-store" })).json();
console.log(`whole-match preview for ${MATCH}: ${preview.recipient_count} recipients, ${preview.total_registered} registered`);
console.log(`the one being texted: ${JSON.stringify((preview.recipients ?? []).find((r) => r.user_id === UID))}`);

const body = process.env.BODY ?? "MatchDay ops test from Clubhouse: subset send is live. Reply STOP is not needed, this is a one-off.";
if (process.env.GO !== "1") { console.log(`\nSTOPPED. Would POST user_ids=[${UID}] with body: ${JSON.stringify(body)}`); process.exit(0); }
const res = await fetch(url, { method: "POST", headers: H, body: JSON.stringify({ template_used: "free_form", message_body: body, user_ids: [UID] }) });
const j = await res.json();
console.log(`\nHTTP ${res.status}:`, JSON.stringify(j, null, 1));
