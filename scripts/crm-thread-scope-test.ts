/* PLAYER CHATS: EVERY ROUTE THAT NAMES A THREAD ASKS crmScope FIRST, EVERY COUNT COUNTS ONLY SCOPE.
 *
 * Ryan, 2026-10-30. The listing scoped a confined account by assignee; thread read, send,
 * send-media, send-template, resolve, mark-read and context did not, so a known id opened another
 * city's conversation. The live proof (a Warsaw session against an in-scope and an out-of-scope
 * thread) ran once at the push; this is the floor that keeps the wiring from being dropped. It is
 * a static read: it proves the guard is called before the route's first write, not what it decides.
 */
import { readFileSync } from "node:fs";

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
]) yes(`${p} resolves crmScopedAssignees`, src(p).includes("crmScopedAssignees(auth)"));
const metrics = src("src/app/api/crm/metrics/route.ts");
yes("metrics: the unscoped all-time cache is never served to a confined caller", /if \(!scoped && period === "all" && allTimeCache/.test(metrics));
yes("metrics: …and never filled by one", /if \(period === "all" && !scoped\)/.test(metrics));

console.log("\nPRESENCE CONTROL: the guard itself refuses by default");
const lib = src("src/lib/crmScope.ts");
yes("an unassigned or out-of-scope thread is a 403", /if \(!who \|\| !scope\.ids!\.includes\(who\)\) return \{ ok: false, status: 403/.test(lib));
yes("a malformed id is a 403 for a confined caller", /if \(!UUID_RX\.test\(threadId\)\) return \{ ok: false, status: 403/.test(lib));
yes("unconfined callers pass with no query", /if \(!auth\.confinedCity\) return \{ ok: true \};/.test(lib));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
