import "server-only"; // no-op under --conditions=react-server
// Phase 15 — the Gameday Ops board model, asserted entirely OFFLINE with synthetic
// matches (so cross-timezone cases are exact). Plain assertions + MUTATION tests:
// each mutation must PASS for the real impl and FAIL for a broken one, or the
// assertion proves nothing.
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/gameday-model-test.ts
import {
  byKickoff, bandOf, minsUntil, capacity, openSpots, realCount, fakeCount, filledCount, clampFakes,
  nextRelease, acLevel, minsToDeadline, short, shortBy, fill, attention, inCities, passesFilter,
  localClock, localDate, CRIT_HOURS, WARN_HOURS, riskTier, CANCEL_SOON_MINUTES, matchGroup, GROUPS, type ApiMatch,
} from "../src/lib/gamedayModel";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const eq = (n: string, got: unknown, want: unknown) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
function mutation<T>(name: string, real: T, broken: T, assertion: (impl: T) => boolean) {
  let r = false, b = true;
  try { r = assertion(real); } catch { r = false; }
  try { b = assertion(broken); } catch { b = false; }
  (r && !b) ? ok(`${name}: real PASSES, broken FAILS (teeth)`) : bad(name, `real=${r} broken=${b}`);
}

const NOW = Date.parse("2026-08-08T20:00:00.000Z");
const H = 3600000;
function mk(o: Partial<ApiMatch> & { startDateUtc: string }): ApiMatch {
  return {
    id: 1, name: "M", startDate: "2026-08-08T15:00:00.000", isCancelled: false,
    autoCanceledMinutes: 75, minPlayerCount: 11, maxPlayerCount: 20,
    registrationPrice: 1200, fakeSpotLeft36h: 0, fakeSpotLeft24h: 0, fakeSpotLeft12h: 0,
    fakeSpotLeft6h: 0, fakeSpotLeft3h: 0, isAutoBump: false, category: "OPEN", type: "REGULAR",
    _count: { players: 6, fakePlayers: 0 }, manager: { firstName: "Sam", lastName: "W" },
    teams: [{ teamNumber: 1 }, { teamNumber: 2 }],
    field: { title: "PRUMC", city: { id: 1, name: "Austin", timeZone: { abbr: "CDT" } } },
    ...o,
  };
}

// ── real kickoff order across timezones ──────────────────────────────────────
// Atlanta 6:00 PM ET = 22:00 UTC kicks off BEFORE Austin 5:30 PM CT = 22:30 UTC,
// even though Austin's wall clock reads earlier.
const atl = mk({ id: 101, startDate: "2026-08-08T18:00:00.000", startDateUtc: "2026-08-08T22:00:00.000Z", field: { city: { name: "Atlanta", timeZone: { abbr: "EDT" } } } });
const aus = mk({ id: 102, startDate: "2026-08-08T17:30:00.000", startDateUtc: "2026-08-08T22:30:00.000Z", field: { city: { name: "Austin", timeZone: { abbr: "CDT" } } } });
eq("real kickoff order: Atlanta (later clock) sorts before Austin", [atl, aus].sort(byKickoff).map((m) => m.id), [101, 102]);
const wallMin = (m: ApiMatch) => { const t = /T(\d{2}):(\d{2})/.exec(m.startDate)!; return Number(t[1]) * 60 + Number(t[2]); };
mutation("order by REAL instant, not clock time", byKickoff, ((a: ApiMatch, b: ApiMatch) => wallMin(a) - wallMin(b)) as typeof byKickoff,
  (cmp) => [aus, atl].sort(cmp)[0].id === 101); // real puts Atlanta first; wall-clock puts Austin first

// ── PRODUCTION REGRESSION: match 17325 (ATH Katy) — the fake double-count bug ──
// Ground truth read off the roster editor: 3 real, 3 fake, 12 open of 18; min 12.
// The API list _count is {players: 6 (TOTAL, incl fake), fakePlayers: 3}. The bug used
// players (6) as "real", then open = cap-real-fake subtracted the fakes twice (=9).
{
  const m17325 = mk({ startDateUtc: "2026-08-09T14:30:00.000Z", _count: { players: 6, fakePlayers: 3 }, maxPlayerCount: 18, minPlayerCount: 12 });
  // Assert the REAL count DIRECTLY — not via real+fake+open===cap, which passes on the
  // broken values too (6+3+9 === 18). This is the assertion the old harness lacked.
  eq("17325: real is players MINUS fakes (3), not the occupied count (6)", realCount(m17325), 3);
  eq("17325: fake is 3", fakeCount(m17325), 3);
  eq("17325: open is 12 (cap - real - fake, no double subtraction)", openSpots(m17325), 12);
  eq("17325: real + fake + open === capacity (18) — necessary but NOT sufficient", realCount(m17325) + fakeCount(m17325) + (openSpots(m17325) ?? 0), 18);
  // the shortfall is on REAL players (Q3): 12 needed, 3 real => 9 short, not 6
  eq("17325: short by 9 real players (needs 12, has 3 real)", shortBy(m17325), 9);
  eq("17325: is short (under the minimum on real players)", short(m17325), true);
  // guard the exact regression: the occupied count and the real count must differ here
  ok(realCount(m17325) !== filledCount(m17325) ? "17325: real (3) != filled (6) — fakes are not counted as real" : bad("17325 real==filled"));
}

// ── real + fake + open == capacity, EXACTLY ──────────────────────────────────
// players 6 = TOTAL occupied (2 real + 4 fake); open = 20 - 2 - 4 = 14.
const packed = mk({ startDateUtc: "2026-08-08T22:00:00.000Z", _count: { players: 6, fakePlayers: 4 }, maxPlayerCount: 20 });
eq("open spots fill the remainder (20 - 2 real - 4 fake = 14)", openSpots(packed), 14);
eq("real is occupied minus fakes (6 - 4 = 2)", realCount(packed), 2);
ok(realCount(packed) + fakeCount(packed) + (openSpots(packed) ?? 0) === capacity(packed) ? "real + fake + open === capacity (equality)" : bad("equality"));
mutation("open spots is the remainder, so the sum is EXACTLY capacity", openSpots,
  ((m: ApiMatch) => Math.max(0, (capacity(m) ?? 0) - realCount(m))) as typeof openSpots, // BUG: forgets fake
  (fn) => { const o = fn(packed) ?? 0; return realCount(packed) + fakeCount(packed) + o === capacity(packed); });

// ── fakes clamped by available room ──────────────────────────────────────────
const tight = mk({ startDateUtc: "2026-08-08T22:00:00.000Z", _count: { players: 18, fakePlayers: 0 }, maxPlayerCount: 20 });
eq("a rung of 8 with 2 spots free clamps to 2 fakes", clampFakes(tight, 8), 2);
mutation("fakes are clamped by room, never exceed it", clampFakes,
  ((_m: ApiMatch, rung: number) => rung) as typeof clampFakes, // BUG: no clamp
  (fn) => fn(tight, 8) <= Math.max(0, (capacity(tight) ?? 0) - realCount(tight)));

// ── next release matches the ladder, and the tile can say the same thing ──────
const rel = mk({ startDateUtc: new Date(NOW + 5 * H).toISOString(), _count: { players: 10, fakePlayers: 6 }, maxPlayerCount: 20, fakeSpotLeft6h: 4, fakeSpotLeft3h: 2 });
eq("next release: at 5h out, the 3h mark drops 6→2 = +4 in 2h", nextRelease(rel, NOW), { mark: 3, inMin: 120, drop: 4 });

// ── auto-cancel colours by DEADLINE distance, both thresholds ─────────────────
const critShort = mk({ startDateUtc: new Date(NOW + 3.5 * H).toISOString(), autoCanceledMinutes: 60, _count: { players: 6, fakePlayers: 0 } }); // deadline in 2.5h
const warnShort = mk({ startDateUtc: new Date(NOW + 5.5 * H).toISOString(), autoCanceledMinutes: 30, _count: { players: 6, fakePlayers: 0 } }); // deadline in 5h
const farShort = mk({ startDateUtc: new Date(NOW + 12 * H).toISOString(), autoCanceledMinutes: 30, _count: { players: 6, fakePlayers: 0 } });
eq("auto-cancel crit inside 3h to the deadline", acLevel(critShort, NOW), "crit");
eq("auto-cancel warn between 3h and 6h", acLevel(warnShort, NOW), "warn");
eq("auto-cancel plain beyond 6h", acLevel(farShort, NOW), "");
const met = mk({ startDateUtc: new Date(NOW + 1 * H).toISOString(), autoCanceledMinutes: 30, _count: { players: 15, fakePlayers: 0 } });
eq("a match meeting its minimum is never coloured, however close", acLevel(met, NOW), "");
const finished = mk({ startDateUtc: new Date(NOW - 2 * H).toISOString(), _count: { players: 6, fakePlayers: 0 } });
eq("a finished match is never coloured", acLevel(finished, NOW), "");
const cxShort = mk({ startDateUtc: new Date(NOW + 3 * H).toISOString(), isCancelled: true, _count: { players: 6, fakePlayers: 0 } });
eq("a cancelled match is never coloured", acLevel(cxShort, NOW), "");

// MUTATION: colour by the DEADLINE, not by kickoff.
mutation("auto-cancel colours by the deadline, not kickoff", acLevel,
  ((m: ApiMatch, now: number) => { if (m.isCancelled || minsUntil(m, now) <= 0 || !short(m) || capacity(m) == null) return ""; const h = minsUntil(m, now) / 60; return h <= CRIT_HOURS ? "crit" : h <= WARN_HOURS ? "warn" : ""; }) as typeof acLevel,
  (fn) => fn(critShort, NOW) === "crit" && fn(warnShort, NOW) === "warn"); // by-kickoff: critShort(3.5h)→warn, warnShort(5.5h)→warn

// MUTATION: never colour a match meeting its minimum (the !short guard).
mutation("never colours a match meeting its minimum", acLevel,
  ((m: ApiMatch, now: number) => { if (m.isCancelled || minsUntil(m, now) <= 0 || capacity(m) == null) return ""; const h = minsToDeadline(m, now) / 60; return h <= CRIT_HOURS ? "crit" : h <= WARN_HOURS ? "warn" : ""; }) as typeof acLevel, // BUG: drops !short
  (fn) => fn(met, NOW) === "" && fn(critShort, NOW) === "crit");

// MUTATION: compute the deadline with the full instant, not clock time-of-day
// (the real-instant analogue of "forgot the day offset" — tomorrow coloured today).
const tomorrowFar = mk({ startDate: "2026-08-09T16:00:00.000", startDateUtc: "2026-08-09T21:00:00.000Z", autoCanceledMinutes: 75, _count: { players: 6, fakePlayers: 0 } }); // deadline ~23.75h out
const acTimeOfDay = ((m: ApiMatch, now: number) => {
  if (m.isCancelled || !short(m) || capacity(m) == null) return "";
  const d = new Date(now); const nowMod = d.getUTCHours() * 60 + d.getUTCMinutes();
  const t = /T(\d{2}):(\d{2})/.exec(m.startDateUtc)!; const koMod = Number(t[1]) * 60 + Number(t[2]);
  const h = ((koMod - (m.autoCanceledMinutes ?? 0)) - nowMod) / 60; // BUG: ignores the date
  return h <= CRIT_HOURS ? "crit" : h <= WARN_HOURS ? "warn" : "";
}) as typeof acLevel;
eq("tomorrow's far-from-deadline match is NOT coloured", acLevel(tomorrowFar, NOW), "");
mutation("auto-cancel uses the full instant, not clock time-of-day", acLevel, acTimeOfDay,
  (fn) => fn(tomorrowFar, NOW) === ""); // real: ""; broken (time-of-day): a colour

// ── the minimum, marked on the bar ───────────────────────────────────────────
const shortMatch = mk({ startDateUtc: new Date(NOW + 2 * H).toISOString(), minPlayerCount: 11, maxPlayerCount: 20, _count: { players: 8, fakePlayers: 0 } });
const f1 = fill(shortMatch)!;
eq("marker sits at minPlayers/capacity (11/20 = 55%)", Math.round(f1.minPct * 100) / 100, 55);
eq("hatched band width IS the shortfall ((11-8)/20 = 15%)", f1.gapPct, 15);
eq("short match: marker not hit", f1.hit, false);
const madeMatch = mk({ startDateUtc: new Date(NOW + 2 * H).toISOString(), minPlayerCount: 11, maxPlayerCount: 20, _count: { players: 14, fakePlayers: 0 } });
const f2 = fill(madeMatch)!;
eq("made-it: marker hit, no shortfall band", { hit: f2.hit, gap: f2.gapPct }, { hit: true, gap: 0 });

// ── risk tiers (Snapshot): three states from short() + minsToDeadline() ───────
{
  eq("CANCEL_SOON_MINUTES is 120 (named, not magic)", CANCEL_SOON_MINUTES, 120);
  // full-but-imminent: minimum MET and the deadline is inside 2h -> still GREEN, not red.
  const fullImminent = mk({ startDateUtc: new Date(NOW + 1 * H).toISOString(), autoCanceledMinutes: 0, _count: { players: 15, fakePlayers: 0 }, minPlayerCount: 11, maxPlayerCount: 20 });
  eq("full match near its deadline stays GREEN (red needs BOTH short and <=2h)", riskTier(fullImminent, NOW), "green");
  // short + cancel call within 2h -> red
  const redCase = mk({ startDateUtc: new Date(NOW + 2 * H).toISOString(), autoCanceledMinutes: 30, _count: { players: 6, fakePlayers: 0 }, minPlayerCount: 11, maxPlayerCount: 20 }); // deadline 90m
  eq("short + deadline within 2h -> red", riskTier(redCase, NOW), "red");
  // short but deadline > 2h away -> amber
  const amberCase = mk({ startDateUtc: new Date(NOW + 5 * H).toISOString(), autoCanceledMinutes: 30, _count: { players: 6, fakePlayers: 0 }, minPlayerCount: 11, maxPlayerCount: 20 }); // deadline 270m
  eq("short + deadline beyond 2h -> amber", riskTier(amberCase, NOW), "amber");
  // and the boundary is inclusive at 120
  const boundary = mk({ startDateUtc: new Date(NOW + 120 * 60000).toISOString(), autoCanceledMinutes: 0, _count: { players: 6, fakePlayers: 0 }, minPlayerCount: 11, maxPlayerCount: 20 }); // deadline exactly 120m
  eq("deadline exactly at 120m is red (<=)", riskTier(boundary, NOW), "red");
}

// ── bands, cancelled sinks with no countdown/releases ─────────────────────────
eq("band live (kicked off, within 90m)", bandOf(mk({ startDateUtc: new Date(NOW - 30 * 60000).toISOString() }), NOW), "live");
eq("band soon (next four hours)", bandOf(mk({ startDateUtc: new Date(NOW + 2 * H).toISOString() }), NOW), "soon");
eq("band later", bandOf(mk({ startDateUtc: new Date(NOW + 8 * H).toISOString() }), NOW), "later");
eq("band done (finished > 90m ago)", bandOf(mk({ startDateUtc: new Date(NOW - 2 * H).toISOString() }), NOW), "done");
const cx = mk({ startDateUtc: new Date(NOW + 2 * H).toISOString(), isCancelled: true });
eq("cancelled sinks to the cx band whatever its time", bandOf(cx, NOW), "cx");
eq("cancelled has no next release", nextRelease(cx, NOW), null);

// ── the city filter drives the stats, not just the grid ───────────────────────
const list = [atl, aus, mk({ id: 103, startDateUtc: "2026-08-08T23:00:00.000Z", field: { city: { name: "Dallas" } } })];
eq("city filter selects by city name", list.filter((m) => inCities(m, new Set(["Atlanta"]))).map((m) => m.id), [101]);
eq("empty city set means every city", list.filter((m) => inCities(m, new Set())).length, 3);
eq("attention filter is derived, not a flag", passesFilter(critShort, NOW, "att"), true);

// ── display helpers ──────────────────────────────────────────────────────────
eq("local clock reads the wall string, no timezone maths", localClock(atl), "6:00 PM");
eq("local date is the wall calendar date", localDate(atl), "2026-08-08");
ok(attention(critShort, NOW) === true ? "attention true for a short, near-deadline match" : bad("attention"));

// ── the three groups (Phase 18) — ONE function both views share ──────────────
const H2 = 3600000;
const mkG = (o: Partial<ApiMatch>): ApiMatch => ({ id: 1, name: "M", startDate: "2026-08-08T18:00:00.000", startDateUtc: new Date(NOW + 3 * H2).toISOString(), minPlayerCount: 11, maxPlayerCount: 20, autoCanceledMinutes: 60, _count: { players: 4, fakePlayers: 0 }, teams: [{ teamNumber: 1 }], field: { title: "F", city: { name: "Austin", timeZone: { abbr: "CDT" } } }, ...o } as ApiMatch);
const futureM = mkG({ startDateUtc: new Date(NOW + 3 * H2).toISOString() });
const liveM = mkG({ startDateUtc: new Date(NOW - 20 * 60000).toISOString() }); // kicked off 20m ago
const finishedM = mkG({ startDateUtc: new Date(NOW - 5 * H2).toISOString() }); // 5h past
const cxFuture = mkG({ isCancelled: true, startDateUtc: new Date(NOW + 3 * H2).toISOString() });
const cxPast = mkG({ isCancelled: true, startDateUtc: new Date(NOW - 5 * H2).toISOString() });

eq("future match -> todo", matchGroup(futureM, NOW), "todo");
eq("in-play match (kicked off <90m) -> todo, not finished", matchGroup(liveM, NOW), "todo");
eq("well-past match -> finished", matchGroup(finishedM, NOW), "finished");
eq("cancelled future -> cancelled (outcome beats time)", matchGroup(cxFuture, NOW), "cancelled");
eq("cancelled past -> cancelled (never 'finished')", matchGroup(cxPast, NOW), "cancelled");
eq("GROUPS order is todo, cancelled, finished", GROUPS.map((g) => g.k), ["todo", "cancelled", "finished"]);

// riskTier must NOT apply to cancelled/finished — it is green (inert) for both, so a
// cancelled/finished row can never carry an amber/red risk rail.
eq("riskTier inert (green) for cancelled", riskTier(cxFuture, NOW), "green");
eq("riskTier inert (green) for finished", riskTier(finishedM, NOW), "green");
// A short cancelled match must still be green (the bug: it used to look risky/short).
eq("short + cancelled is still green (no phantom risk)", riskTier(mkG({ isCancelled: true, _count: { players: 1, fakePlayers: 0 } }), NOW), "green");

// attention counts ONLY still-to-come — never cancelled, never finished.
ok(attention(cxFuture, NOW) === false ? "attention false for a cancelled match" : bad("attention cancelled"));
ok(attention(finishedM, NOW) === false ? "attention false for a finished match" : bad("attention finished"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
