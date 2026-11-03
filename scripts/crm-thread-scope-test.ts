/* PLAYER CHATS: EVERY ROUTE THAT NAMES A THREAD ASKS crmScope FIRST, EVERY COUNT COUNTS ONLY SCOPE.
 *
 * Ryan, 2026-10-30. The listing scoped a confined account by assignee; thread read, send,
 * send-media, send-template, resolve, mark-read and context did not, so a known id opened another
 * city's conversation. The live proof (a Warsaw session against an in-scope and an out-of-scope
 * thread) ran once at the push; this is the floor that keeps the wiring from being dropped. It is
 * a static read: it proves the guard is called before the route's first write, not what it decides.
 */
import { readFileSync } from "node:fs";
import { assertThreadInScope, threadInScope, scopeThreads } from "../src/lib/crmScope";

let pass = 0, fail = 0;
const ok = (m: string) => { pass++; console.log(`  ok  ${m}`); };
const bad = (m: string, d = "") => { fail++; console.log(`  XX  ${m} ${d}`); };
const yes = (m: string, c: boolean, d = "") => (c ? ok(m) : bad(m, d));
const src = (p: string) => readFileSync(p, "utf8");
const FIRST_WRITE = /\.(insert|update|upsert|delete)\(|messages\.send\(|sendWhatsApp\w*\(|storage\s*\.from\(/;

console.log("\nroutes that name a thread call assertThreadInScope before any write or send");
const THREAD_ROUTES = [
  "src/app/api/crm/threads/[id]/route.ts",
  "src/app/api/crm/threads/[id]/context/route.ts",
  "src/app/api/crm/threads/[id]/mark-read/route.ts",
  "src/app/api/crm/threads/[id]/status/route.ts",
  "src/app/api/crm/send/route.ts",
  "src/app/api/crm/send-media/route.ts",
  "src/app/api/crm/send-template/route.ts",
  // Added 2026-11-02: the draft, its actions and the thread controls asked nothing before.
  "src/app/api/crm/threads/[id]/ai-draft/route.ts",
  "src/app/api/crm/threads/[id]/ai-draft/discard/route.ts",
  "src/app/api/crm/threads/[id]/ai-draft/action/route.ts",
  "src/app/api/crm/threads/[id]/assign/route.ts",
  "src/app/api/crm/threads/[id]/follow-up/route.ts",
  "src/app/api/crm/threads/[id]/no-reply/route.ts",
  "src/app/api/crm/threads/[id]/link/route.ts",
  "src/app/api/crm/threads/[id]/city/route.ts",
];
for (const p of THREAD_ROUTES) {
  const s = src(p);
  const guard = s.indexOf("assertThreadInScope(auth, threadId)");
  yes(`${p} calls the guard`, guard > 0);
  const w = s.slice(s.indexOf("export async function")).search(FIRST_WRITE);
  const write = w < 0 ? -1 : s.indexOf("export async function") + w;
  yes(`…before its first write or send`, guard > 0 && (write < 0 || guard < write), `guard ${guard} write ${write}`);
}
const send = src("src/app/api/crm/send/route.ts");
yes("send: scope is decided before the send permission, so a refusal names the city first",
  send.indexOf("assertThreadInScope(auth, threadId)") < send.indexOf("if (!auth.canSendMessages)"));

console.log("\nevery send path requires can_send_messages before it sends");
for (const p of ["src/app/api/crm/send/route.ts", "src/app/api/crm/send-media/route.ts", "src/app/api/crm/send-template/route.ts", "src/app/api/match-chats/[chatId]/reply/route.ts"]) {
  const s = src(p);
  const gate = s.indexOf("if (!auth.canSendMessages)");
  const send = s.slice(s.indexOf("export async function POST")).search(/messages\.send\(|sendWhatsApp\w*\(|\.collection\("Chats"\)/);
  const at = send < 0 ? -1 : s.indexOf("export async function POST") + send;
  yes(`${p} refuses without can_send_messages`, gate > 0 && /reason: "no_send_permission"/.test(s.slice(gate, gate + 300)));
  yes(`…before it sends`, gate > 0 && at > gate, `gate ${gate} send ${at}`);
}

console.log("\ncounts count only the caller's scope");
for (const p of [
  "src/app/api/crm/threads/route.ts",
  "src/app/api/crm/threads/awaiting-count/route.ts",
  "src/app/api/crm/threads/unread-count/route.ts",
  "src/app/api/crm/metrics/route.ts",
]) yes(`${p} resolves the caller's city (crmScopeCity)`, src(p).includes("crmScopeCity(auth)") && !src(p).includes("assigned_to_user_id\", scope"));
yes("bulk status checks every id it was handed", /for \(const id of ids\) \{\s*const scope = await assertThreadInScope\(auth, id\)/.test(src("src/app/api/crm/threads/bulk-status/route.ts")));
const metrics = src("src/app/api/crm/metrics/route.ts");
yes("metrics: the unscoped all-time cache is never served to a confined caller", /if \(!scoped && period === "all" && allTimeCache/.test(metrics));
yes("metrics: …and never filled by one", /if \(period === "all" && !scoped\)/.test(metrics));

console.log("\nTHE GUARD, RUN: a thread's own city decides (crm_threads.city_code, 0250)");
async function main() {
  const T_ATX = "11111111-1111-4111-8111-111111111111", T_WAW = "22222222-2222-4222-8222-222222222222", T_NONE = "33333333-3333-4333-8333-333333333333";
  const cities: Record<string, string | null> = { [T_ATX]: "ATX", [T_WAW]: "WAW", [T_NONE]: null };
  let reads = 0;
  const supabase = { from: () => ({ select: () => ({ eq: (_c: string, id: string) => ({ maybeSingle: async () => { reads++; return { data: id in cities ? { city_code: cities[id] } : null, error: null }; } }) }) }) } as never;
  const waw = { confinedCity: "WAW", supabase };
  const r1 = await assertThreadInScope(waw, T_ATX);
  yes("A WARSAW ACCOUNT IS REFUSED AN AUSTIN THREAD AT THE API (403)", !r1.ok && r1.status === 403);
  yes("POSITIVE CONTROL: the same account opens a Warsaw thread", (await assertThreadInScope(waw, T_WAW)).ok);
  const r3 = await assertThreadInScope(waw, T_NONE);
  yes("a thread with no city yet is refused to a confined account", !r3.ok && r3.status === 403);
  const r4 = await assertThreadInScope(waw, "44444444-4444-4444-8444-444444444444");
  yes("a thread that doesn't exist: the same 403, so ids can't be probed", !r4.ok && r4.status === 403);
  yes("a malformed id is a 403", !(await assertThreadInScope(waw, "not-a-uuid")).ok);
  const before = reads;
  yes("an unconfined caller passes, with no query", (await assertThreadInScope({ confinedCity: null, supabase }, T_ATX)).ok && reads === before);
  yes("threadInScope: same city only", threadInScope("WAW", "WAW") && !threadInScope("WAW", "ATX") && !threadInScope("WAW", null) && threadInScope(null, null));
  const calls: string[] = [];
  const q = { eq(col: string, val: string) { calls.push(`${col}=${val}`); return q; } };
  scopeThreads(q, "WAW"); scopeThreads(q, null);
  yes("lists and counts filter on city_code for a confined caller, and not at all otherwise", JSON.stringify(calls) === JSON.stringify(["city_code=WAW"]));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail || pass === 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
