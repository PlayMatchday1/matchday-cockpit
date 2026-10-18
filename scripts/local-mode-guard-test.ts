import "server-only"; // no-op under --conditions=react-server
// LOCAL MODE — every guard behind MATCHDAY_LOCAL_API, asserted OFFLINE (src/lib/localMode.ts).
// fetch is replaced by a counter that never reaches a network, so "refused" means refused before
// any request, and every absence (zero fetches, zero inserts) sits beside the same call with the
// flag OFF reaching the counter: the positive control in the same run.
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/local-mode-guard-test.ts

import { NextRequest } from "next/server";
import { localModeOn, LocalModeRefusedError } from "../src/lib/localMode";
import {
  assertAllowedHost, apiGet, apiWrite, StageHostGuardError, StageConfigError, NotAuthorizedError,
} from "../src/lib/matchdayStageApi";
import { getMatchdayApiClient, fetchMatchDayJson, _resetCachedToken } from "../src/lib/matchdayApi";
import { recordWrite, supabaseLogStore, type LogStore } from "../src/lib/changeLog";
import { proxy } from "../src/proxy";
import { pathEnv } from "../src/lib/localMode";
// Route handlers that key PRODUCTION data by a match or field id (field covers wiring, 2026-10-18). Called directly.
import * as chatNotify from "../src/app/api/match-chats/[chatId]/notify/route";
import * as chatReply from "../src/app/api/match-chats/[chatId]/reply/route";
import * as chatRead from "../src/app/api/match-chats/[chatId]/route";
import * as venues from "../src/app/api/venues/route";
import * as slotIntent from "../src/app/api/veo/slot-intent/route";
import * as veoIntent from "../src/app/api/veo/intent/route";
import * as fieldsRoute from "../src/app/api/fields/route";
import * as fieldPhotos from "../src/app/api/fields/photos/route";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const eq = (n: string, got: unknown, want: unknown) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
const throws = (n: string, Cls: new (...a: never[]) => Error, fn: () => void) => {
  try { fn(); bad(n, "did NOT throw"); }
  catch (e) { e instanceof Cls ? ok(n) : bad(n, `threw ${(e as Error).name}: ${(e as Error).message.slice(0, 90)}`); }
};
const rejects = async (n: string, Cls: new (...a: never[]) => Error, fn: () => Promise<unknown>) => {
  try { await fn(); bad(n, "did NOT reject"); }
  catch (e) { e instanceof Cls ? ok(n) : bad(n, `rejected ${(e as Error).name}: ${(e as Error).message.slice(0, 90)}`); }
};
const noThrow = (n: string, fn: () => void) => { try { fn(); ok(n); } catch (e) { bad(n, `threw ${(e as Error).name}: ${(e as Error).message.slice(0, 90)}`); } };

// ── the world ───────────────────────────────────────────────────────────────────────────────
const env = process.env as Record<string, string | undefined>;
const KEYS = ["MATCHDAY_LOCAL_API", "NODE_ENV", "VERCEL", "MATCHDAY_LOCAL_API_EMAIL", "MATCHDAY_LOCAL_API_PASSWORD",
  "MATCHDAY_PROD_BASE_URL", "MATCHDAY_PROD_API_EMAIL", "MATCHDAY_PROD_API_PASSWORD",
  "MATCHDAY_API_EMAIL", "MATCHDAY_API_PASSWORD", "MATCHDAY_API_BASE_URL",
  "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
const saved = Object.fromEntries(KEYS.map((k) => [k, env[k]]));
function world(local: boolean) {
  for (const k of KEYS) delete env[k];
  // Fake credentials for every target, so a refusal can never be "the creds were missing".
  Object.assign(env, {
    MATCHDAY_LOCAL_API_EMAIL: "admin@example.com", MATCHDAY_LOCAL_API_PASSWORD: "x",
    MATCHDAY_PROD_BASE_URL: "https://playmatchday.herokuapp.com", MATCHDAY_PROD_API_EMAIL: "p@example.com", MATCHDAY_PROD_API_PASSWORD: "x",
    MATCHDAY_API_EMAIL: "r@example.com", MATCHDAY_API_PASSWORD: "x",
    NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:9", SUPABASE_SERVICE_ROLE_KEY: "x",
  });
  if (local) { env.MATCHDAY_LOCAL_API = "1"; env.NODE_ENV = "development"; }
  _resetCachedToken();
}

// Every fetch lands here. It answers like MatchDay would (a sign-in token, then JSON) and never
// touches a network.
const calls: string[] = [];
const JWT = `x.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64")}.y`;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input instanceof Request ? input.url : input);
  calls.push(url);
  const body = url.endsWith("/auth/signin") ? { accessToken: JWT } : { ok: true };
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const PROD = "https://playmatchday.herokuapp.com/admin/matches/1";
const STAGE = "https://matchday-stage.herokuapp.com/admin/matches/1";
const LOCAL = "http://localhost:3010/admin/match-manager/applications";
const ADMIN = { canEditMatches: false, isAdmin: true, email: "test@example.com" };

async function main() {
  try {
    console.log("the flag — on only with MATCHDAY_LOCAL_API=1 AND NODE_ENV=development AND no VERCEL:");
    eq("on: flag + development", localModeOn({ MATCHDAY_LOCAL_API: "1", NODE_ENV: "development" }), true);
    eq("off: flag under production (next build / next start)", localModeOn({ MATCHDAY_LOCAL_API: "1", NODE_ENV: "production" }), false);
    eq("off: flag with NODE_ENV unset (node scripts, tests)", localModeOn({ MATCHDAY_LOCAL_API: "1" }), false);
    eq("off: flag on Vercel even in development", localModeOn({ MATCHDAY_LOCAL_API: "1", NODE_ENV: "development", VERCEL: "1" }), false);
    eq("off: flag set to 'true' rather than '1'", localModeOn({ MATCHDAY_LOCAL_API: "true", NODE_ENV: "development" }), false);
    eq("off: development without the flag", localModeOn({ NODE_ENV: "development" }), false);

    // ── 1. WRITE CLIENT ────────────────────────────────────────────────────────────────────
    console.log("write client, flag ON — production and staging refused, only localhost:3010 by parsed host:");
    world(true);
    throws("production host refused as production", StageHostGuardError, () => assertAllowedHost("production", PROD));
    throws("staging host refused as staging", StageHostGuardError, () => assertAllowedHost("staging", STAGE));
    throws("production host refused even when labelled local", StageHostGuardError, () => assertAllowedHost("local", PROD));
    noThrow("localhost:3010 accepted as local", () => assertAllowedHost("local", LOCAL));
    throws("spoof localhost:3010.evil.com refused", StageHostGuardError, () => assertAllowedHost("local", "http://localhost:3010.evil.com/x"));
    throws("another port (localhost:3001, the Clubhouse itself) refused", StageHostGuardError, () => assertAllowedHost("local", "http://localhost:3001/x"));
    throws("127.0.0.1:3010 refused (exact host, not 'means the same')", StageHostGuardError, () => assertAllowedHost("local", "http://127.0.0.1:3010/x"));
    calls.length = 0;
    await rejects("apiGet(production) refused", StageHostGuardError, () => apiGet("production", "/admin/matches/1"));
    await rejects("apiWrite(production) refused", StageHostGuardError, () => apiWrite("production", "PUT", "/admin/matches/1", { name: "x" }, { canEditMatches: true }));
    eq("…and neither sent a single request", calls.length, 0);
    await apiGet("local", "/admin/match-manager/applications");
    eq("apiGet(local) signs in and reads at localhost:3010 only", calls, ["http://localhost:3010/auth/signin", "http://localhost:3010/admin/match-manager/applications"]);
    calls.length = 0;
    await rejects("apiWrite(local) still needs its authority (admin)", NotAuthorizedError, () => apiWrite("local", "POST", "/admin/match-manager/applications/1/accept", undefined, { canEditMatches: true }, "admin"));
    eq("…and the refused write sent nothing", calls.length, 0);
    await apiWrite("local", "POST", "/admin/match-manager/applications/1/accept", undefined, ADMIN, "admin");
    eq("apiWrite(local) as an admin reaches localhost:3010", calls, ["http://localhost:3010/admin/match-manager/applications/1/accept"]);

    console.log("write client, flag OFF — exactly main: the two Heroku hosts, and no local target:");
    world(false);
    noThrow("production host accepted as production", () => assertAllowedHost("production", PROD));
    noThrow("staging host accepted as staging", () => assertAllowedHost("staging", STAGE));
    throws("local refused", StageHostGuardError, () => assertAllowedHost("local", LOCAL));
    calls.length = 0;
    await rejects("apiGet(local) refused before any request", StageConfigError, () => apiGet("local", "/admin/match-manager/applications"));
    eq("…zero requests", calls.length, 0);
    await apiGet("production", "/admin/matches/1");
    eq("apiGet(production) reaches the production host (the control for every zero above)", calls, ["https://playmatchday.herokuapp.com/auth/signin", "https://playmatchday.herokuapp.com/admin/matches/1"]);

    // ── 2. READ CLIENT (every mdapi sync reads through it) ─────────────────────────────────
    console.log("read / sync client, flag ON — refused before any fetch:");
    world(true);
    calls.length = 0;
    throws("getMatchdayApiClient() refused", LocalModeRefusedError, () => getMatchdayApiClient());
    await rejects("fetchMatchDayJson() refused", LocalModeRefusedError, () => fetchMatchDayJson("https://playmatchday.herokuapp.com/admin/players"));
    eq("…zero requests", calls.length, 0);
    console.log("read / sync client, flag OFF — reaches production as on main:");
    world(false);
    calls.length = 0;
    await getMatchdayApiClient().get("/admin/players", { page: 1 });
    eq("client.get signs in and reads production", calls, ["https://playmatchday.herokuapp.com/auth/signin", "https://playmatchday.herokuapp.com/admin/players?page=1"]);

    // ── 3. SYNC TRIGGERS (proxy) ────────────────────────────────────────────────────────────
    const req = (p: string) => new NextRequest(new URL(p, "http://localhost:3001"));
    const passesThrough = (r: Response) => r.headers.get("x-middleware-next") === "1";
    console.log("sync triggers, flag ON — /api/sync/* answers 503 and the route never runs:");
    world(true);
    for (const p of ["/api/sync/cron", "/api/sync/matches", "/api/sync/users-full", "/api/sync/player-areas/continue", "/api/sync/manager-pay-recompute"]) {
      const r = proxy(req(p));
      eq(`${p} → 503, not passed to the route`, [r.status, passesThrough(r)], [503, false]);
    }
    eq("a page is untouched (/match-ops/manager-pay passes through)", passesThrough(proxy(req("/match-ops/manager-pay"))), true);
    eq("a lookalike is not a sync path (/api/syncs passes through)", passesThrough(proxy(req("/api/syncs"))), true);
    console.log("sync triggers, flag OFF — passed straight to the route, as on main:");
    world(false);
    for (const p of ["/api/sync/cron", "/api/sync/matches"]) eq(`${p} passes through`, passesThrough(proxy(req(p))), true);

    // ── 4. CHANGE LOG ───────────────────────────────────────────────────────────────────────
    const inserts: unknown[] = [];
    const spyStore: LogStore = { insert: async (row) => { inserts.push(row); }, list: async () => [], resolve: async () => {} };
    let wrote = 0;
    const ctx = { env: "local", source: "test", actorName: "t", saveId: "s1", matchId: null, method: "POST", path: "/x", body: { status: "ACCEPTED" }, keys: ["status"], label: (k: string) => k };
    let state = "IN_REVIEW";
    const io = { readResource: async () => ({ status: state }), write: async () => { wrote++; state = "ACCEPTED"; }, now: () => "2026-10-12T00:00:00Z" };
    console.log("change_log, flag ON — the write runs and is classified, nothing is stored:");
    world(true);
    const on = await recordWrite(ctx, io, spyStore);
    eq("the write ran once", wrote, 1);
    eq("its outcome is still real (landed, from the read-back)", on.outcome, "landed");
    eq("zero inserts", inserts.length, 0);
    eq("reported as skipped for local mode, not as a logging hole", [on.logged, on.skippedLocal], [false, true]);
    calls.length = 0;
    await supabaseLogStore().insert({ saveId: "s", at: "", actorName: "t", source: "t", env: "local", matchId: null, method: "POST", endpoint: "/x", body: {}, outcome: "LANDED", changes: [] });
    await supabaseLogStore().resolve("s", "yes", "t", "");
    eq("the Supabase store sends nothing for insert or resolve", calls.length, 0);
    console.log("change_log, flag OFF — one insert, as on main (the control for the zero above):");
    world(false);
    state = "IN_REVIEW";
    const off = await recordWrite({ ...ctx, saveId: "s2" }, io, spyStore);
    eq("one insert", inserts.length, 1);
    eq("logged, not skipped", [off.logged, off.skippedLocal], [true, undefined]);
    console.log("the /api/matchday/{env}/ path env — \"local\" exists only while local mode is on:");
    world(true);
    eq("on: local accepted", pathEnv("local"), "local");
    eq("on: production and staging keep their names (the write client refuses them)", [pathEnv("production"), pathEnv("staging")], ["production", "staging"]);
    eq("on: anything else unknown", pathEnv("prod"), null);
    world(false);
    eq("off: local is an unknown environment, as on main", pathEnv("local"), null);

    /* THE ROUTES THAT WOULD MIX SEED IDS WITH PRODUCTION DATA. A seed match id is a real production match's chat id;
     * "notify" for it would text real players. Flag ON: 503, and ZERO requests of any kind (Supabase included: its
     * client uses fetch). Flag OFF, the same calls get past the refusal (401: no session): the positive control. */
    type H = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
    const routeCalls: [string, H, string, Record<string, string>][] = [
      ["chat notify POST (texts a match's players)", chatNotify.POST as unknown as H, "POST", { chatId: "104" }],
      ["chat notify GET", chatNotify.GET as unknown as H, "GET", { chatId: "104" }],
      ["chat reply POST", chatReply.POST as unknown as H, "POST", { chatId: "104" }],
      ["chat read GET", chatRead.GET as unknown as H, "GET", { chatId: "104" }],
      ["venues POST", venues.POST as unknown as H, "POST", {}],
      ["venues PATCH", venues.PATCH as unknown as H, "PATCH", {}],
      ["venues PUT", venues.PUT as unknown as H, "PUT", {}],
      ["venues GET", venues.GET as unknown as H, "GET", {}],
      ["camera slot rule POST", slotIntent.POST as unknown as H, "POST", {}],
      ["camera flag POST", veoIntent.POST as unknown as H, "POST", {}],
      ["field DELETE", fieldsRoute.DELETE as unknown as H, "DELETE", {}],
      ["gallery photo POST", fieldPhotos.POST as unknown as H, "POST", {}],
    ];
    const hit = async (h: H, method: string, params: Record<string, string>) => h(
      new Request("http://localhost:3012/api/x?id=1&fieldId=1", { method, ...(method === "GET" ? {} : { body: JSON.stringify({ user_ids: [1, 2], message_body: "hi" }), headers: { "content-type": "application/json" } }) }),
      { params: Promise.resolve(params) });
    console.log("production-keyed routes, flag ON — 503 and no request at all:");
    for (const [name, h, method, params] of routeCalls) {
      world(true); calls.length = 0;
      const r = await hit(h, method, params);
      eq(`${name}: 503, ${calls.length} requests`, [r.status, calls.length], [503, 0]);
    }
    console.log("production-keyed routes, flag OFF — past the refusal, as on main (the control for the 503s above):");
    for (const [name, h, method, params] of routeCalls) {
      world(false);
      const r = await hit(h, method, params);
      r.status !== 503 ? ok(`${name}: ${r.status}, not the local-mode refusal`) : bad(`${name}: still 503 with the flag off`);
    }
  } finally {
    for (const k of KEYS) { if (saved[k] === undefined) delete env[k]; else env[k] = saved[k]; }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
