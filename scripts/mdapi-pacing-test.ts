/* THE GUARDS ON HOW CLUBHOUSE READS THE PRODUCTION MATCHDAY API (2026-10-21).
 *
 * Production went down at 2:05 PM Central on 2026-10-21 (Heroku R15) under Clubhouse's bulk reads.
 * Every scheduled sync now goes through getPacedClient: one request a second, no retries, and the
 * first error stops the run. This suite pins that on COMPUTED behaviour, with a fake transport and a
 * fake Supabase, so nothing here talks to MatchDay or to the database:
 *   - the paced client: the gap, maxRetries 0, the stop after one failure, the 404 exception
 *   - a forced 503 stops the incremental location sync after ONE request, and writes no player
 *   - a forced 503 on the first roster stops the matches sync: the second roster is never asked for
 *   - the incremental filter is checked, not trusted (a totalItems the size of every player stops it)
 *   - which rosters the hourly matches run re-reads; reviews derived from rosters
 *   - the night pass's match-window quarters cover the window with no gap
 *   - Download players from our copy: an unconfirmed row goes out blank, a scrubbed one blank, and
 *     there is no "Verified by" column */
import { getPacedClient, MatchdayApiError, PacedClientStopped, type MatchdayApiClient } from "@/lib/matchdayApi";
import { runIncremental, INCREMENTAL_MAX } from "@/lib/playerAreaSync";
import { syncMdapiMatches, rostersToRefresh, reviewFromRoster, type StoredSignals } from "@/lib/mdapiMatchesSync";
import { windowSlice, MATCH_SLICES } from "@/lib/nightPass";
import { buildSignupRows, signupCsv, SIGNUP_COLUMNS, type MirrorUser } from "@/lib/signupExport";
import type { SupabaseClient } from "@supabase/supabase-js";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const is = (n: string, got: unknown, want: unknown) =>
  (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
const yes = (n: string, c: boolean, d = "") => (c ? ok(n) : bad(n, d));

/* A fake transport: answers from a script, records every call and the options it was given. */
type Call = { path: string; query?: Record<string, string | number>; opts?: { maxRetries?: number } };
function fakeBase(answer: (c: Call, i: number) => unknown): MatchdayApiClient & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async get<T>(path: string, query?: Record<string, string | number>, opts?: { maxRetries?: number }): Promise<T> {
      const c = { path, query, opts }; calls.push(c);
      const a = answer(c, calls.length - 1);
      if (a instanceof Error) throw a;
      return a as T;
    },
  };
}
const err503 = () => new MatchdayApiError(503, "Service Unavailable", "<html>Application Error</html>", "https://api/x");
const err404 = () => new MatchdayApiError(404, "Not Found", "{}", "https://api/x");

/* A fake clock for the pace: sleep advances it. */
function clock() {
  let t = 1_000_000; const slept: number[] = [];
  return { now: () => t, sleep: async (ms: number) => { slept.push(ms); t += ms; }, slept, tick: (ms: number) => { t += ms; } };
}

/* A fake Supabase: every chain method returns the chain; awaiting it answers from `reply`. Writes are
 * recorded per table, so a suite can say "no player was written". */
type Op = { table: string; op: string; payload?: unknown; filters: string[] };
function fakeDb(reply: (o: Op) => { data: unknown; error: null | { message: string } }) {
  const writes: Op[] = [];
  const db = {
    writes,
    from(table: string) {
      const o: Op = { table, op: "select", filters: [] };
      const chain: Record<string, unknown> = {};
      const self = new Proxy(chain, {
        get(_t, k: string) {
          if (k === "then") {
            return (res: (v: unknown) => void, rej: (e: unknown) => void) => {
              if (o.op !== "select") writes.push(o);
              try { res(reply(o)); } catch (e) { rej(e); }
            };
          }
          return (...args: unknown[]) => {
            if (["insert", "upsert", "update", "delete"].includes(k)) { o.op = k; o.payload = args[0]; }
            else if (k !== "select") o.filters.push(`${k}:${JSON.stringify(args[0])}`);
            return self;
          };
        },
      });
      return self;
    },
  };
  return db as unknown as SupabaseClient & { writes: Op[] };
}

async function main() {
  console.log("\n— the paced client —");
  {
    const c = clock();
    const base = fakeBase(() => ({ ok: true }));
    const pc = getPacedClient({ base, sleep: c.sleep, now: c.now });
    await pc.get("/a"); c.tick(200); await pc.get("/b"); await pc.get("/c");
    is("CONTROL: three requests reach the transport", base.calls.length, 3);
    is("…and are counted", pc.calls, 3);
    is("each request waits until a second after the previous one ended", c.slept, [800, 1000]);
    yes("every request asks for NO retries", base.calls.every((x) => x.opts?.maxRetries === 0), JSON.stringify(base.calls.map((x) => x.opts)));
  }
  {
    const c = clock();
    const base = fakeBase((_c, i) => (i === 0 ? err503() : { ok: true }));
    const pc = getPacedClient({ base, sleep: c.sleep, now: c.now });
    let first: unknown = null, second: unknown = null;
    try { await pc.get("/a"); } catch (e) { first = e; }
    try { await pc.get("/b"); } catch (e) { second = e; }
    yes("a 503 is thrown to the caller", first instanceof MatchdayApiError && first.status === 503);
    yes("the next get() is refused without a request", second instanceof PacedClientStopped, String(second));
    is("…so the transport saw ONE request", base.calls.length, 1);
    yes("…and the client says what stopped it", pc.stoppedBy instanceof MatchdayApiError);
  }
  {
    const c = clock();
    const base = fakeBase((_c, i) => (i === 0 ? err404() : { ok: true }));
    const pc = getPacedClient({ base, sleep: c.sleep, now: c.now, stopsOn: (e) => !(e instanceof MatchdayApiError && e.status === 404) });
    try { await pc.get("/gone"); } catch { /* expected */ }
    await pc.get("/next");
    is("with stopsOn, a 404 does not stop the client (the unlisted re-read)", base.calls.length, 2);
  }

  console.log("\n— the incremental location sync: a forced 503 —");
  const CITIES = [{ id: 1, name: "Austin", abbr: "AUS", lat: 30.27, lng: -97.74, radiusMiles: 100 }];
  const GEOMETRY = { cities: CITIES, markets: new Set([1]), geom: "test" };
  const runsReply = (o: Op) => {
    if (o.table === "player_area_sync_runs" && o.op === "insert") return { data: { id: 99 }, error: null };
    if (o.table === "player_area_sync_runs" && o.filters.some((f) => f.startsWith("is:"))) return { data: [], error: null };
    if (o.table === "player_area_sync_runs" && o.filters.some((f) => f.includes('"kind"'))) return { data: { cities: CITIES }, error: null };
    if (o.table === "player_area_sync_runs") return { data: { id: 48, started_at: "2026-10-21T17:10:05Z" }, error: null };
    return { data: [], error: null };
  };
  {
    const db = fakeDb(runsReply);
    const base = fakeBase(() => err503());
    const r = await runIncremental(db, "cron", { client: getPacedClient({ base, sleep: async () => {} }), geometry: GEOMETRY, now: new Date("2026-10-21T20:35:00Z") });
    is("the transport saw ONE request", base.calls.length, 1);
    yes("…and it was the incremental filter, 200 a page", base.calls[0]?.path === "/admin/players" && base.calls[0]?.query?.limit === 200 && "locationUpdatedSince" in (base.calls[0]?.query ?? {}), JSON.stringify(base.calls[0]));
    is("the since is the last good run's START minus one hour", base.calls[0]?.query?.locationUpdatedSince, "2026-10-21T16:10:05.000Z");
    yes("the run reports failure with the 503 in it", !r.ok && /503/.test(r.error ?? ""), JSON.stringify(r));
    is("no player row was written", db.writes.filter((w) => w.table === "player_area_seen").length, 0);
    const fin = db.writes.find((w) => w.table === "player_area_sync_runs" && w.op === "update");
    is("the run row is closed as failed, one request counted", fin ? [(fin.payload as { ok: boolean }).ok, (fin.payload as { api_calls: number }).api_calls] : null, [false, 1]);
  }
  {
    /* THE POSITIVE CONTROL for the "no player written" above: the same fake, a page that answers. */
    const db = fakeDb(runsReply);
    const page = { totalItems: 2, data: [
      { id: 7, email: "a@example.com", createdAt: "2026-01-01T00:00:00Z", areaSource: "zip", zipCode: "78701", currentLat: 30.27, currentLng: -97.74 },
      { id: 8, email: "b@example.com", createdAt: "2026-01-01T00:00:00Z", areaSource: "none" },
    ] };
    const base = fakeBase(() => page);
    const r = await runIncremental(db, "cron", { client: getPacedClient({ base, sleep: async () => {} }), geometry: GEOMETRY, now: new Date("2026-10-21T20:35:00Z") });
    yes("CONTROL: an answering page completes the run", r.ok, JSON.stringify(r));
    is("CONTROL: …in ONE request (2 players fit on a page of 200)", base.calls.length, 1);
    const ins = db.writes.find((w) => w.table === "player_area_seen" && w.op === "upsert");
    is("CONTROL: …and the player with an area IS written", ins ? (ins.payload as { player_id: number }[]).map((x) => x.player_id) : null, [7]);
  }
  {
    const db = fakeDb(runsReply);
    const base = fakeBase(() => ({ totalItems: 36277, data: [] }));
    const r = await runIncremental(db, "cron", { client: getPacedClient({ base, sleep: async () => {} }), geometry: GEOMETRY, now: new Date("2026-10-21T20:35:00Z") });
    yes(`a totalItems over ${INCREMENTAL_MAX} reads as an ignored filter and stops the run`, !r.ok && /filter looks ignored/.test(r.error ?? ""), JSON.stringify(r));
    is("…with nothing written", db.writes.filter((w) => w.table === "player_area_seen").length, 0);
  }

  console.log("\n— the matches sync: a forced 503 on the first roster —");
  {
    const db = fakeDb(() => ({ data: [], error: null }));
    const list = { totalItems: 2, data: [
      { id: 501, fieldId: 9, startDate: "2026-10-22T19:00:00.000Z", field: { title: "F", city: { abbr: "AUS", name: "Austin" } } },
      { id: 502, fieldId: 9, startDate: "2026-10-23T19:00:00.000Z", field: { title: "F", city: { abbr: "AUS", name: "Austin" } } },
    ] };
    const base = fakeBase((c) => (c.path === "/admin/matches" ? list : err503()));
    let thrown: unknown = null;
    try {
      await syncMdapiMatches(db, { fromDate: "2026-10-07", toDate: "2026-12-21", rosters: "all", mode: "full-1", client: getPacedClient({ base, sleep: async () => {} }) });
    } catch (e) { thrown = e; }
    is("the transport saw the list and ONE roster", base.calls.map((c) => c.path), ["/admin/matches", "/admin/matches/501/players"]);
    yes("…and the run fails, carrying its request count for the log", thrown instanceof Error && (thrown as { logPatch?: { api_calls?: number } }).logPatch?.api_calls === 2, String(thrown));
    is("no tombstone was written (an unread roster is not an empty one)", db.writes.filter((w) => w.op === "update").length, 0);
    is("CONTROL: the match rows it did read were written", db.writes.filter((w) => w.table === "mdapi_matches" && w.op === "upsert").length, 1);
  }

  console.log("\n— which rosters the hourly run re-reads —");
  {
    const now = new Date("2026-10-21T20:00:00Z");
    const row = (id: number, day: string, extra: Record<string, unknown> = {}) => ({
      api_id: id, start_date: `${day}T19:00:00.000Z`, player_count: 10, fake_player_count: 0, guest_count: 0, is_cancelled: false,
      end_date: `${day}T20:00:00.000Z`, max_player_count: 16, star_rating: 4.5, star_rating_count: 3, updated_at: "2026-10-01T00:00:00.000Z", ...extra,
    });
    const stored = (r: ReturnType<typeof row>, extra: Partial<StoredSignals> = {}): StoredSignals =>
      ({ ...r, start_date: r.start_date.replace(".000Z", "+00:00"), star_rating: "4.50", deleted_at: null, ...extra });
    const far = row(1, "2026-11-20"), farChanged = row(2, "2026-11-20", { player_count: 11 }), soon = row(3, "2026-10-23"),
      lately = row(4, "2026-10-19"), fresh = row(5, "2026-11-25"), revived = row(6, "2026-11-26"), reviewed = row(7, "2026-10-10", { star_rating_count: 4 });
    const st = new Map<number, StoredSignals>([
      [1, stored(far)], [2, stored(row(2, "2026-11-20"))], [3, stored(soon)], [4, stored(lately)],
      [6, stored(revived, { deleted_at: "2026-10-20T00:00:00Z" })], [7, stored(row(7, "2026-10-10"))],
    ]);
    const pick = rostersToRefresh([far, farChanged, soon, lately, fresh, revived, reviewed], st, now);
    is("recent (−2 to +3 days), new, revived and changed are picked; an unchanged far match is not", [...pick].sort(), [2, 3, 4, 5, 6, 7]);
    yes("CONTROL: the unchanged far match compares equal across the stored shapes (+00:00, \"4.50\")", !pick.has(1));
  }
  {
    const m = { manager_first_name: "Jo", manager_last_name: "M", start_date: "2026-10-19T19:00:00.000Z", field_title: "Scissortail Park", city_name: "Oklahoma City" };
    const rv = reviewFromRoster({ id: 340133, userId: 84344, user: { firstName: "A", lastName: "B", email: "a@x.com", phoneNumber: "+1" }, starRating: 5, tagsRating: [], comment: null, updatedAtRating: "2026-10-21T18:25:25.885Z" } as never, m, "now");
    is("a rated roster row becomes a review with the same id, and empty tags read as null", rv && [rv.api_id, rv.user_id, rv.star_rating, rv.tags_rating, rv.field_title], [340133, 84344, 5, null, "Scissortail Park"]);
    is("an unrated roster row is not a review", reviewFromRoster({ id: 1, starRating: null } as never, m, "now"), null);
  }

  console.log("\n— the night pass's match-window quarters —");
  {
    const win = { fromDate: "2026-10-07", toDate: "2026-12-20" };
    const q = Array.from({ length: MATCH_SLICES }, (_, i) => windowSlice(win, i + 1));
    is("the first quarter starts the window, the last ends it", [q[0].fromDate, q[MATCH_SLICES - 1].toDate], [win.fromDate, win.toDate]);
    yes("each quarter starts on the day the one before it ends (one day of overlap, no gap)", q.every((s, i) => i === 0 || s.fromDate === q[i - 1].toDate), JSON.stringify(q));
  }

  console.log("\n— Download players, from our copy —");
  {
    const acct = (id: number) => ({ account_id: id, completed_sign_up_at: "2026-10-15T18:00:00Z", declared_city_raw: "Austin" });
    const u = (id: number, synced: string, extra: Partial<MirrorUser> = {}): MirrorUser =>
      ({ id, email: `p${id}@example.com`, first_name: "Pat", last_name: "Lee", phone_number: "+15125550100", raw: { selfRatingValue: 3 }, synced_at: synced, ...extra });
    const since = "2026-10-22T08:00:00Z";
    const mirror = new Map([
      [1, u(1, "2026-10-22T08:03:00Z")],
      [2, u(2, "2026-10-19T09:01:00Z")],
      [3, u(3, "2026-10-22T08:03:00Z", { first_name: "Deleted", last_name: "Account", email: "del_" + "a".repeat(40) + "@playmatchday.com", phone_number: null })],
    ]);
    const rows = buildSignupRows([acct(1), acct(2), acct(3), acct(4)], mirror, since);
    const by = new Map(rows.map((r) => [r.id, r]));
    is("CONTROL: a row confirmed since the last full refresh keeps its contact", [by.get(1)?.email, by.get(1)?.phone, by.get(1)?.deleted], ["p1@example.com", "+15125550100", "no"]);
    is("a row the API has not confirmed since then goes out blank, Deleted unknown", [by.get(2)?.firstName, by.get(2)?.email, by.get(2)?.phone, by.get(2)?.deleted], ["", "", "", "unknown"]);
    is("a scrubbed account: blank contact, Deleted yes", [by.get(3)?.email, by.get(3)?.phone, by.get(3)?.deleted], ["", "", "yes"]);
    is("an account with no row in our copy: blank, Deleted unknown", [by.get(4)?.email, by.get(4)?.deleted], ["", "unknown"]);
    yes("there is no Verified by column", !(SIGNUP_COLUMNS as readonly string[]).includes("Verified by"));
    const header = signupCsv(rows).replace(/^﻿/, "").split("\r\n")[0].split(",");
    is("…and every line has as many cells as the header", signupCsv(rows).replace(/^﻿/, "").trim().split("\r\n").map((l) => l.split(",").length), Array(5).fill(header.length));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (pass === 0) { console.log("ZERO ASSERTIONS — that is a failure, not a pass"); process.exit(1); }
  process.exit(fail ? 1 : 0);
}
void main().catch((e) => { console.log(`  XX  the suite threw: ${e instanceof Error ? e.stack : String(e)}`); process.exit(1); });
