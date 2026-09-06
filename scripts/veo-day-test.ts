import "server-only"; // no-op under --conditions=react-server
/* THE VEO DAY VIEW — the two arithmetic facts the page cannot show you are wrong.
 *
 * THE TALLY IS ALSO THE FILTER, so its five counts must partition the day EXACTLY. A match in the
 * total and in none of the five is a row nobody can reach by clicking; a match in two of them
 * makes the strip add to more than the day. Both look like numbers on screen. An earlier version
 * of this page had no slot for "held" and one camera match sat in the total and in no state above
 * it — which is the whole reason the equality is asserted rather than eyeballed.
 *
 * A FLAGGED POST IS COUNTED ONCE. `flagged` is a boolean on a POSTED row, not a sixth status, so
 * the obvious reading — posted rows are "posted", and flagged ones are also flagged — double-counts
 * and breaks the strip.
 *
 * THE TRACE MUST ADD TO THE SCORE ON THE ROW. It is read from score_parts and never recomputed;
 * the hand-written version of this trace was out by 32 points.
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/veo-day-test.ts
 */
import { readFileSync } from "node:fs";
import {
  FILM_STATES, attachedTo, buildDayRows, filmState, gapLabel, scoreTrace, tally, tallyAddsUp, traceSum,
  type VeoDayMatch, type VeoDayRecording, type VeoScoreParts,
} from "../src/lib/veoDay";
import { classifyVeo, scoreVeo, CODE_SCORE, DATE_SCORE, TIME_SCORE, FIELD_SCORE, type CodeTier, type DateForm, type TimeForm, type VeoCandidateRow } from "../src/lib/veo";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const is = (n: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const yes = (n: string, c: boolean, d = "") => (c ? ok(n) : bad(n, d));

const match = (apiId: number, over: Partial<VeoDayMatch> = {}): VeoDayMatch => ({
  apiId, name: `Match ${apiId}`, city: "Austin", cityCode: "ATX", venue: "Onion Creek",
  fieldId: 27, code: "OC", codeConfirmed: true, date: "2026-09-03", time: "8:00 PM",
  minutes: 1200, players: 14, capacity: 20, cancelled: false, ...over,
});
const rec = (over: Partial<VeoDayRecording> = {}): VeoDayRecording => ({
  id: `r${Math.random()}`, recordingId: "vabc", subject: "OC | Sep 3 | 8pm", videoUrl: "https://app.veo.co/matches/x/",
  receivedAt: "2026-09-04T05:00:00Z", status: "queued", queueReason: null, matchedApiId: null,
  candidateApiIds: [], score: null, scoreParts: null, flagged: false,
  parsedCode: "OC", parsedMatchDate: "2026-09-03", parsedTimeLabel: "8:00 PM",
  parsedTimeMinutes: 1200, postedByUserId: null, ...over,
});

console.log("— the five states, one per match, mutually exclusive —");
is("a posted recording on a clean read → posted",
  filmState(match(1), [rec({ status: "posted", matchedApiId: 1 })]), "posted");
is("a posted recording that was flagged → flagged, NOT posted",
  filmState(match(1), [rec({ status: "posted", matchedApiId: 1, flagged: true })]), "flagged");
/* THE SPLIT THAT MADE "posted went 16 to 15" UNREADABLE. A hand-assignment carries
 * posted_by_user_id, and counting it as a post makes the matcher look better than it is —
 * 7 of those 16 were people, so the automatic number was 9. */
is("a HAND-assigned recording → assigned, never posted",
  filmState(match(1), [rec({ status: "posted", matchedApiId: 1, postedByUserId: "u1" })]), "assigned");
is("…and a hand-assignment of a flagged row is still assigned, not flagged",
  filmState(match(1), [rec({ status: "posted", matchedApiId: 1, flagged: true, postedByUserId: "u1" })]), "assigned");
is("a queue-only code → held, even with a recording sitting against it",
  filmState(match(1, { codeConfirmed: false }), [rec({ candidateApiIds: [1], queueReason: "unconfirmed_code" })]), "held");
is("a queue-only code with nothing at all → still held (it is deliberate, not a gap)",
  filmState(match(1, { codeConfirmed: false }), []), "held");
is("a recording arrived and did not post → needs a look",
  filmState(match(1), [rec({ candidateApiIds: [1], queueReason: "multiple_matches" })]), "needs_look");
is("nothing arrived → no film yet", filmState(match(1), []), "no_film");
is("a dismissed recording is not an arrival — the match still reads no film",
  filmState(match(1), [rec({ status: "dismissed", candidateApiIds: [1] })]), "no_film");
is("a recording for a DIFFERENT match does not touch this one",
  filmState(match(1), [rec({ status: "posted", matchedApiId: 2 })]), "no_film");
// A post_failed row carries matched_api_id but status 'queued' — it did not post.
is("post_failed carries a match id and is still needs a look",
  filmState(match(1), [rec({ matchedApiId: 1, queueReason: "post_failed" })]), "needs_look");

console.log("\n— multiple_matches attaches to every candidate, and each match still has ONE state —");
const multi = rec({ candidateApiIds: [1, 2, 3], queueReason: "multiple_matches" });
is("the recording attaches to all three", [1, 2, 3].map((i) => attachedTo(i, [multi]).length), [1, 1, 1]);
is("and each of the three reads needs a look", [1, 2, 3].map((i) => filmState(match(i), [multi])), ["needs_look", "needs_look", "needs_look"]);

console.log("\n— THE IDENTITY: the five add to the total, over every combination —");
/* EXHAUSTIVE, not a sample. Five matches, each independently in one of the situations that
 * produce a state, is 6^5 = 7,776 days. If any ordering of the rules ever lets a match fall into
 * two states or none, one of these fails. */
const situations: [string, (id: number) => { m: VeoDayMatch; r: VeoDayRecording[] }][] = [
  ["posted", (id) => ({ m: match(id), r: [rec({ status: "posted", matchedApiId: id })] })],
  ["flagged", (id) => ({ m: match(id), r: [rec({ status: "posted", matchedApiId: id, flagged: true })] })],
  ["held", (id) => ({ m: match(id, { codeConfirmed: false }), r: [] })],
  ["held+rec", (id) => ({ m: match(id, { codeConfirmed: false }), r: [rec({ candidateApiIds: [id] })] })],
  ["assigned", (id) => ({ m: match(id), r: [rec({ status: "posted", matchedApiId: id, postedByUserId: "u1" })] })],
  ["needs_look", (id) => ({ m: match(id), r: [rec({ candidateApiIds: [id] })] })],
  ["no_film", (id) => ({ m: match(id), r: [] })],
];
let combos = 0, broke = 0, doubleCounted = 0;
const idx = [0, 0, 0, 0, 0];
const N = situations.length;
for (let n = 0; n < N ** 5; n++) {
  let q = n;
  for (let i = 0; i < 5; i++) { idx[i] = q % N; q = Math.floor(q / N); }
  const ms: VeoDayMatch[] = []; const rs: VeoDayRecording[] = [];
  for (let i = 0; i < 5; i++) { const s = situations[idx[i]][1](i + 1); ms.push(s.m); rs.push(...s.r); }
  const rows = buildDayRows(ms, rs);
  const t = tally(rows);
  combos++;
  if (!tallyAddsUp(t)) broke++;
  // Every row has exactly one state, and it is one of the five.
  if (rows.some((r) => !FILM_STATES.includes(r.state))) doubleCounted++;
}
is(`all ${combos} five-match combinations: the ${FILM_STATES.length} states add to the total`, broke, 0);
is(`…and every row carries exactly one of the ${FILM_STATES.length}`, doubleCounted, 0);
is("there are six states, and the strip renders all of them", FILM_STATES.length, 6);
// POSITIVE CONTROL: the identity is falsifiable. A tally that counts a flagged post under BOTH
// posted and flagged fails it — which is the mistake the assertion exists to catch.
{
  const rows = buildDayRows([match(1)], [rec({ status: "posted", matchedApiId: 1, flagged: true })]);
  const t = tally(rows);
  const wrong = { ...t, posted: t.posted + t.flagged };
  yes("control — double-counting a flagged post BREAKS the identity", tallyAddsUp(t) && !tallyAddsUp(wrong));
}

console.log("\n— which recording a row is about, when more than one attaches —");
/* The Pearland pair: both recordings shortlist both matches, so both attach to both rows. Taking
 * the first put the 9:15 recording under the 8:15 match, and the panel then marked the 9:15
 * candidate "exact" on a row headed 8:15 PM. */
{
  const m815 = match(18284, { minutes: 20 * 60 + 15, code: "ATHP" });
  const m915 = match(18344, { minutes: 21 * 60 + 15, code: "ATHP" });
  const r815 = rec({ id: "r815", subject: "ATHP| Sep 4 |8:15PM", candidateApiIds: [18344, 18284], parsedTimeMinutes: 20 * 60 + 15, queueReason: "multiple_matches" });
  const r915 = rec({ id: "r915", subject: "ATHP| Sep 4 |9:15PM", candidateApiIds: [18344, 18284], parsedTimeMinutes: 21 * 60 + 15, queueReason: "multiple_matches" });
  const rows = buildDayRows([m815, m915], [r915, r815]); // deliberately in the WRONG order
  is("the 8:15 row shows the 8:15 recording", rows[0].primary?.id, "r815");
  is("…and the 9:15 row shows the 9:15 one", rows[1].primary?.id, "r915");
  is("…and both rows still list both recordings", rows.map((r) => r.recordings.length), [2, 2]);
  // A POSTED recording always wins, whatever the times say.
  const posted = rec({ id: "rp", status: "posted", matchedApiId: 18284, parsedTimeMinutes: 21 * 60 + 15 });
  is("a posted recording is the row's primary regardless of time", buildDayRows([m815], [r815, posted])[0].primary?.id, "rp");
}

console.log("\n— the gap, written out so nobody has to subtract —");
/* "exact" against "60 min later" is the entire Pearland decision and it should take under a
 * second. Two clock times side by side would make an operator subtract them forty times a week. */
is("the exact hit says so", gapLabel(1215, 1215), "exact");
is("an hour later reads as an hour later", gapLabel(1275, 1215), "60 min later");
is("…and earlier reads as earlier, never as a negative number", gapLabel(1200, 1215), "15 min earlier");
is("no parsed time, no gap — never a wrong one", gapLabel(1215, null), null);

console.log("\n— the trace is read, and it adds to the number on the row —");
/* Generated from the matcher's OWN tables, so the trace cannot drift from the scoring it explains.
 * Every tier of every axis, which is 6 × 5 × 3 × 2 = 180 real scores. */
const tiers = Object.keys(CODE_SCORE) as CodeTier[];
const dates = Object.keys(DATE_SCORE) as DateForm[];
const times = Object.keys(TIME_SCORE) as TimeForm[];
let traced = 0, mismatched = 0;
for (const codeTier of tiers) for (const dateForm of dates) for (const timeForm of times) for (const fieldAgrees of [true, false]) {
  const parts = scoreVeo({ codeTier, dateForm, timeForm, fieldAgrees }) as unknown as VeoScoreParts;
  const lines = scoreTrace(parts);
  if (!lines) { mismatched++; continue; }
  traced++;
  if (traceSum(lines) !== parts.total) mismatched++;
}
is(`all ${traced} score shapes: the trace's four lines add to the score`, mismatched, 0);
is("the field line is worth the field score and nothing else",
  scoreTrace(scoreVeo({ codeTier: "exact", dateForm: "month", timeForm: "ampm", fieldAgrees: true }) as unknown as VeoScoreParts)!.find((l) => l.label === "Field")!.points,
  FIELD_SCORE);
is("a row with no score_parts has NO trace — an absence, not a row of zeroes", scoreTrace(null), null);
// CONTROL: traceSum really is capable of disagreeing, so the 180 passes above are not vacuous.
yes("control — a doctored line makes the sum disagree", (() => {
  const lines = scoreTrace(scoreVeo({ codeTier: "exact", dateForm: "month", timeForm: "ampm", fieldAgrees: true }) as unknown as VeoScoreParts)!;
  return traceSum([...lines.slice(1), { ...lines[0], points: lines[0].points + 32 }]) !== 100;
})());

console.log("\n— what a new inbound actually persists —");
/* THE ROW THE ROUTE WRITES, built here from the SAME expressions it uses. The route's shape is
 * asserted against its source below; this asserts the VALUES those expressions produce, which a
 * source regex cannot see. The two halves meet: the route writes decision.score, and decision.score
 * is this.
 *
 * NOT DRIVEN END TO END ON PURPOSE. The only way to watch the real insert land is to POST a
 * synthetic email at /api/veo/inbound, which writes a row into the production veo_recordings — a
 * suite must not do that to get a different world. */
{
  const scMatch: VeoCandidateRow = { api_id: 14613, field_id: 102, start_date: "2026-07-24T20:00:00+00:00", is_cancelled: false };
  const persistedFor = (subject: string, slug: string, rows: VeoCandidateRow[]) => {
    const d = classifyVeo({ subject, slug, loadCandidates: () => rows });
    return {
      match_score: d.score?.total ?? null,
      score_parts: d.score ?? null,
      flagged: d.action === "post" && d.flagged,
      action: d.action,
    };
  };
  const clean = persistedFor("SC | Jul 24 | 8:00PM is ready to watch!", "20260725-sc-jul-24-800pm-v1", [scMatch]);
  is("a clean post persists 100 and flagged: false", [clean.match_score, clean.flagged, clean.action], [100, false, "post"]);
  yes("…and its score_parts sum to match_score",
    (clean.score_parts as VeoScoreParts).code + (clean.score_parts as VeoScoreParts).date
      + (clean.score_parts as VeoScoreParts).time + (clean.score_parts as VeoScoreParts).field === clean.match_score);

  // SCISS resolves only by appearing inside the field label "Scissortail Park" — a real recording,
  // and the shape that makes a post flagged.
  const sciss: VeoCandidateRow = { api_id: 17926, field_id: 1090, start_date: "2026-08-20T20:00:00+00:00", is_cancelled: false };
  const flagged = persistedFor("SCISS | Aug 20 | 8pm is ready to watch!", "20260821-sciss-aug-20-8pm-v1", [sciss]);
  is("a flagged post persists its score and flagged: true", [flagged.match_score, flagged.flagged, flagged.action], [78, true, "post"]);
  yes("…and its score_parts sum to match_score",
    (flagged.score_parts as VeoScoreParts).code + (flagged.score_parts as VeoScoreParts).date
      + (flagged.score_parts as VeoScoreParts).time + (flagged.score_parts as VeoScoreParts).field === flagged.match_score);

  // A QUEUED ROW IS NEVER FLAGGED. It did not post, so there is nothing to flag.
  const queued = persistedFor("SC | Jul 24 | 8:00PM is ready to watch!", "20260725-sc-jul-24-800pm-v1", []);
  is("a queued row persists a score and flagged: false", [queued.flagged, queued.action], [false, "queue"]);
  yes("…and still carries a score for the review page to explain itself with", queued.match_score !== null);

  // An unparseable subject has nothing to score, and null must stay null — a 0 would read as a
  // confident zero on the page.
  const unparseable = persistedFor("Untitled recording is ready to watch!", "20260725-untitled-v1", []);
  is("an unparseable subject persists a NULL score, not a zero", [unparseable.match_score, unparseable.score_parts], [null, null]);
}

console.log("\n— the page and the route keep their contracts —");
const PAGE = readFileSync("src/components/VeoDayOps.tsx", "utf8");
const ROUTE = readFileSync("src/app/api/veo/day/route.ts", "utf8");
const noComments = (x: string) => x.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
const PAGE_C = noComments(PAGE), ROUTE_C = noComments(ROUTE);

// NO IFRAME. Measured: app.veo.co answers x-frame-options: DENY.
!/<iframe/i.test(PAGE_C) ? ok("the viewer attempts no iframe") : bad("an iframe is back in the viewer");
/data-testid="veo-open-in-veo"/.test(PAGE_C) ? ok("…and offers Open in Veo instead") : bad("no Open in Veo link");
// The score is shown only when it was a judgement call, and a null score shows nothing.
/score != null && score < 100 \? score : ""/.test(PAGE_C)
  ? ok("a score prints only below 100, and a null score prints nothing")
  : bad("the score condition changed — a null may now render as 0");
// The trace comes off the row.
/scoreTrace\(rec\?\.scoreParts \?\? null\)/.test(PAGE_C) && !/parseVeoSubject/.test(PAGE_C)
  ? ok("the trace is read from score_parts, with no re-parsing in the component")
  : bad("the page re-parses a subject to build its trace");
// The day defaults to yesterday.
/* The default survived a change: ?date= now overrides it, so the assertion is on the FALLBACK
 * rather than on the whole initialiser it used to be the whole of. */
/\?\s*q\s*:\s*shiftDate\(todayIso\(\), -1\)/.test(PAGE_C) && /searchParams\.get\("date"\)/.test(PAGE_C)
  ? ok("the day defaults to yesterday, with ?date= overriding it")
  : bad("the default day is not yesterday");
// No Date is constructed from a wall-clock start_date in the route.
!/new Date\(String\(r\.start_date\)\)|new Date\(r\.start_date/.test(ROUTE_C)
  ? ok("the route builds no Date from a wall-clock start_date")
  : bad("the route parses start_date through Date — the wall-clock trap");
// The city scope is the session's, never a parameter.
/auth\.confinedCity/.test(ROUTE_C) && !/searchParams\.get\("city"\)/.test(ROUTE_C)
  ? ok("the city boundary is the session's, and no city parameter is read")
  : bad("the route takes a city from the request");
// The selector is the code table, not the emoji.
/codeByField\.get\(fieldId\)/.test(ROUTE_C) && /hasCameraEmoji\(r\.name\)/.test(ROUTE_C)
  ? ok("rows are selected by the code table; the emoji only counts the gap")
  : bad("the row selector is not the code table");

/* PART 3: the orphan strip has an exit. POST /api/veo/[id] has existed and worked all along —
 * this page simply never called it, so a queued recording had nowhere to go. */
/method: "POST"[\s\S]{0,160}JSON\.stringify\(\{ apiId \}\)/.test(PAGE_C) && /`\/api\/veo\/\$\{recordingId\}`/.test(PAGE_C)
  ? ok("the page calls POST /api/veo/[id] with the chosen match")
  : bad("the page does not call the assign route");
/method: "DELETE"/.test(PAGE_C) ? ok("…and DELETE for a dismiss") : bad("no dismiss control");
// ONE ATTEMPT. There is no Idempotency-Key anywhere in this pipeline.
/if \(busy\) return false;/.test(PAGE_C) && !/Idempotency-Key/.test(PAGE_C) && !/\bretry\b/i.test(PAGE_C)
  ? ok("one attempt, never retried — the in-flight guard refuses a second click")
  : bad("the assign may retry");
// The confirm names BOTH sides before anything is written.
/data-testid="veo-confirm"/.test(PAGE_C) && /Post <b>\{rec\.subject/.test(PAGE_C) && /target\.name\}, \{target\.time\}/.test(PAGE_C)
  ? ok("the confirm names the recording AND the match before it writes")
  : bad("the confirm does not name both sides");
// The two groups are never merged: the shortlist is what the matcher already had.
/shortIds\.has\(c\.apiId\)/.test(PAGE_C) && /veo-shortlist/.test(PAGE_C) && /veo-rest/.test(PAGE_C)
  ? ok("the matcher's shortlist is a separate group, not sorted in with the day")
  : bad("the shortlist is merged into the full list");
/* AND IT IS REACHABLE FROM A ROW, not only from the orphan strip. Adding field 22 to ATHP turned
 * the Pearland recordings from orphans into rows attached to real matches — so the strip they used
 * to live in is empty and the row viewer is where an operator now stands. A panel only the orphan
 * strip can open would have been a control nobody could reach for the exact case it was built for. */
/data-testid="veo-send-to-chat"/.test(PAGE_C) && /data-testid="veo-different-match"/.test(PAGE_C)
  ? ok("a queued ROW offers Send to the chat and Different match, both live")
  : bad("the row viewer's assign controls are missing");
/disabled=\{busy \|\| !thisMatch\}/.test(PAGE_C)
  ? ok("…and Send to the chat is disabled only when there is no match to send to")
  : bad("Send to the chat is not gated on having a target");
// An uncoded candidate is offered and marked, not blocked.
/!c\.coded && <em data-testid="veo-cand-uncoded"/.test(PAGE_C) && !/disabled=\{!c\.coded/.test(PAGE_C)
  ? ok("a candidate on an uncoded field is marked and still assignable")
  : bad("an uncoded candidate is blocked rather than marked");

const INBOUND = noComments(readFileSync("src/app/api/veo/inbound/route.ts", "utf8"));
/match_score: decision\.score\?\.total \?\? null/.test(INBOUND) && /score_parts: decision\.score \?\? null/.test(INBOUND)
  ? ok("every inbound writes match_score and score_parts")
  : bad("the inbound route does not persist the score");
/flagged: decision\.action === "post" && decision\.flagged/.test(INBOUND)
  ? ok("flagged is true only for a POST that scored below clean")
  : bad("flagged is no longer tied to a post");
/queue_reason: "post_failed",\s*flagged: false/.test(INBOUND)
  ? ok("a post that FAILED is not left flagged — it sent nothing")
  : bad("post_failed can carry flagged: true");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
