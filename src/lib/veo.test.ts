// Run: `npm test` (or `node --test src/lib/veo.test.ts`)
// Native TS type stripping (Node 22.6+). Pure logic only — no DB/Firestore.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyVeo,
  extractRecordingRef,
  isFinalReadyEmail,
  parseVeoSubject,
  processingDateFromSlug,
  resolveMatchDate,
  resolveMatchDates,
  resolveVeoCodeScored,
  scoreVeo,
  bandFor,
  selectVeoMatches,
  VEO_FIELD_CODES,
  validateVeoCodeInput,
  veoMessageText,
  type VeoCandidateRow,
} from "./veo.ts";
import { authenticateAdmin } from "./adminAuth.ts";

// A confirmed-venue subject (SC = Soccer Central, the one confirmed code) and
// the shareable URL Veo produces for it. The URL's leading date (20260725) is
// the PROCESSING date, one day after the Jul 24 match.
const SUBJECT = "SC | Jul 24 | 8:00PM is ready to watch!";
const URL = "https://app.veo.co/matches/20260725-sc-jul-24-800pm-v8d5b42e/";
const SLUG = "20260725-sc-jul-24-800pm-v8d5b42e";

// One SC match on Jul 24 at 8:00 PM local (start_date is venue-local wall
// clock at UTC offset, so the UTC parts read as the local date/time).
// field_id 102 is Soccer Central Complex — the field SC maps to.
const scMatch: VeoCandidateRow = {
  api_id: 14613,
  field_id: 102,
  start_date: "2026-07-24T20:00:00+00:00",
  is_cancelled: false,
};

// ----------------------------- message copy -----------------------------

test("veoMessageText: the copy line posted before the bare URL", () => {
  // Posted as its OWN message, ahead of the URL-only message, so the players'
  // app keeps the URL clickable. This is the one place to edit the wording.
  assert.equal(veoMessageText(), "🎥 Your match film is ready to watch!");
});

// ----------------------------- email gate -----------------------------

test("isFinalReadyEmail: accepts the final 'ready to watch' email", () => {
  assert.equal(isFinalReadyEmail(SUBJECT), true);
});

test("isFinalReadyEmail: ignores the 'is processing' preview email", () => {
  assert.equal(
    isFinalReadyEmail("SC | Jul 24 | 8:00PM is processing - early access available!"),
    false,
  );
});

// --------------------------- link parsing ---------------------------

test("extractRecordingRef: pulls slug + trailing recording id", () => {
  const ref = extractRecordingRef(URL);
  assert.deepEqual(ref, { slug: SLUG, recordingId: "v8d5b42e" });
});

test("extractRecordingRef: idempotency key is stable across duplicate emails", () => {
  // Same recording, two deliveries → same key, so the DB unique index dedups.
  const a = extractRecordingRef(URL);
  const b = extractRecordingRef("https://app.veo.co/matches/20260725-sc-jul-24-800pm-v8d5b42e/?utm=x");
  assert.equal(a?.recordingId, "v8d5b42e");
  assert.equal(b?.recordingId, "v8d5b42e");
});

test("extractRecordingRef: rejects non-Veo / malformed urls", () => {
  assert.equal(extractRecordingRef("https://example.com/x"), null);
  assert.equal(extractRecordingRef(""), null);
  assert.equal(extractRecordingRef(null), null);
});

test("processingDateFromSlug: reads the leading YYYYMMDD", () => {
  assert.deepEqual(processingDateFromSlug(SLUG), { year: 2026, month: 7, day: 25 });
});

// -------------------------- subject parsing --------------------------

test("parseVeoSubject: parses 'CODE | Mon DD | H:MMPM'", () => {
  const r = parseVeoSubject(SUBJECT);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.code, "SC");
    assert.equal(r.value.month, 7);
    assert.equal(r.value.day, 24);
    assert.equal(r.value.ampmKnown, true);
    assert.equal(r.value.timeOptions.length, 1);
    assert.equal(r.value.timeOptions[0].minutes, 20 * 60); // 8:00 PM
    assert.equal(r.value.timeOptions[0].label, "8:00 PM");
  }
});

test("parseVeoSubject: handles '8PM', lowercase am/pm, noon/midnight, and 24h", () => {
  const t0 = (s: string) => (parseVeoSubject(s) as any).value.timeOptions[0].minutes;
  assert.equal(t0("SC | Jul 24 | 8PM"), 20 * 60);
  assert.equal(t0("SC | Jul 24 | 8:30 pm"), 20 * 60 + 30);
  assert.equal(t0("SC | Jul 24 | 12:00PM"), 12 * 60);
  assert.equal(t0("SC | Jul 24 | 12:00AM"), 0);
  assert.equal(t0("SC | Jul 24 | 20:00"), 20 * 60); // unambiguous 24-hour
});

test("parseVeoSubject: delimiter-agnostic — pipes, dashes, and spaces parse identically", () => {
  const pipe = parseVeoSubject("ATH P | Jul 24 | 9:15");
  const dash = parseVeoSubject("ATH P - Jul 24 - 9:15");
  const space = parseVeoSubject("ATH P Jul 24 9:15pm");
  for (const r of [pipe, dash, space]) {
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.value.code, "ATH P"); // leftover leading text, internal space kept
      assert.equal(r.value.month, 7);
      assert.equal(r.value.day, 24);
    }
  }
  // Bare "9:15" is ambiguous (two options); the explicit "9:15pm" is not.
  assert.equal((pipe as any).value.ampmKnown, false);
  assert.equal((dash as any).value.ampmKnown, false);
  assert.equal((space as any).value.ampmKnown, true);
  assert.equal((space as any).value.timeOptions[0].minutes, 21 * 60 + 15);
});

test("parseVeoSubject: bare 12-hour time yields both meridiems (PM first)", () => {
  const r = parseVeoSubject("SC | Jul 24 | 8:00");
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.ampmKnown, false);
    assert.deepEqual(r.value.timeOptions.map((t) => t.minutes), [20 * 60, 8 * 60]);
  }
});

test("parseVeoSubject: queues when no date or no time (never fuzzy-guess)", () => {
  assert.equal(parseVeoSubject("Untitled recording is ready to watch!").ok, false); // no date/time
  assert.equal(parseVeoSubject("SC | Jul 24").ok, false); // no time
  assert.equal(parseVeoSubject("SC | JXl 24 | 8PM").ok, false); // bad month → no date
  assert.equal(parseVeoSubject("Match Jul 20, 2026 WESTLAKE MONDAY 20tg").ok, false); // no clean time
  assert.equal(parseVeoSubject("PRUMC-TUESDAY GAME JULY,21 2026").ok, false); // no clean time
});

// ------------------------ match-date resolution ------------------------

test("resolveMatchDate: title date wins, year from processing date", () => {
  // Jul 24 title, processed Jul 25 → 2026-07-24 (NOT the URL's 25th).
  assert.equal(
    resolveMatchDate({ month: 7, day: 24 }, { year: 2026, month: 7, day: 25 }),
    "2026-07-24",
  );
});

test("resolveMatchDate: Dec→Jan boundary rolls the year back", () => {
  // Match Dec 31 2025, processed Jan 1 2026.
  assert.equal(
    resolveMatchDate({ month: 12, day: 31 }, { year: 2026, month: 1, day: 1 }),
    "2025-12-31",
  );
});

test("resolveMatchDate: no processing date → null (queue, don't guess)", () => {
  assert.equal(resolveMatchDate({ month: 7, day: 24 }, null), null);
});

test("resolveMatchDates: boundary → prior year only; normal → [slugYear, slugYear-1]", () => {
  // Late-Dec match processed in January: slug-year date is in the future, so
  // only the prior year is possible.
  assert.deepEqual(
    resolveMatchDates({ month: 12, day: 31 }, { year: 2027, month: 1, day: 1 }),
    ["2026-12-31"],
  );
  // Normal: slug year primary, prior year kept as an empirical fallback.
  assert.deepEqual(
    resolveMatchDates({ month: 7, day: 24 }, { year: 2026, month: 7, day: 25 }),
    ["2026-07-24", "2025-07-24"],
  );
  assert.deepEqual(resolveMatchDates({ month: 7, day: 24 }, null), []);
});

// --------------------------- match selection ---------------------------

test("selectVeoMatches: title date used, URL leading date ignored", () => {
  // The match's local start is Jul 24; the URL slug says 20260725. Matching
  // uses the title/local date, so this still matches.
  const target = { matchDate: "2026-07-24", timeMinutes: 20 * 60 };
  const hits = selectVeoMatches(target, [scMatch]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].api_id, 14613);
});

test("selectVeoMatches: excludes cancelled and out-of-window matches", () => {
  const target = { matchDate: "2026-07-24", timeMinutes: 20 * 60 };
  const cancelled: VeoCandidateRow = { ...scMatch, is_cancelled: true };
  const wrongDay: VeoCandidateRow = { api_id: 2, field_id: 102, start_date: "2026-07-25T20:00:00+00:00", is_cancelled: false };
  const tooFar: VeoCandidateRow = { api_id: 3, field_id: 102, start_date: "2026-07-24T22:00:00+00:00", is_cancelled: false };
  assert.equal(selectVeoMatches(target, [cancelled]).length, 0);
  assert.equal(selectVeoMatches(target, [wrongDay]).length, 0);
  assert.equal(selectVeoMatches(target, [tooFar]).length, 0); // 120 min > 90 window
});

// ------------------- end-to-end classification (the spec) -------------------

test("classifyVeo: correctly-named subject → posts to the one match", () => {
  const d = classifyVeo({ subject: SUBJECT, slug: SLUG, loadCandidates: () => [scMatch] });
  assert.equal(d.action, "post");
  if (d.action === "post") {
    assert.equal(d.apiId, 14613);
    assert.equal(d.matchDate, "2026-07-24");
  }
});

test("classifyVeo: mis-named / untitled subject → queued, NOT posted", () => {
  const d = classifyVeo({
    subject: "Untitled recording is ready to watch!",
    slug: SLUG,
    loadCandidates: () => [scMatch],
  });
  assert.equal(d.action, "queue");
  if (d.action === "queue") assert.equal(d.reason, "unparseable_subject");
});

test("classifyVeo: two matches inside the window → queued (never auto-pick)", () => {
  const twin: VeoCandidateRow = { api_id: 99, field_id: 102, start_date: "2026-07-24T20:30:00+00:00", is_cancelled: false };
  const d = classifyVeo({ subject: SUBJECT, slug: SLUG, loadCandidates: () => [scMatch, twin] });
  assert.equal(d.action, "queue");
  if (d.action === "queue") {
    assert.equal(d.reason, "multiple_matches");
    assert.deepEqual(d.candidateApiIds.sort(), [99, 14613].sort());
  }
});

test("classifyVeo: field-agreement cross-check — single match on a different field of the same venue → queued field_mismatch", () => {
  // The one SC-venue match at 8 PM is on field 1123 (Soccer Central World Cup
  // Tournament), which SC does NOT cover (SC = [102, 199], the regular
  // Field 3/4/4A fields). Never post to the wrong field — queue it.
  const wrongField: VeoCandidateRow = { api_id: 700, field_id: 1123, start_date: "2026-07-24T20:00:00+00:00", is_cancelled: false };
  const d = classifyVeo({ subject: SUBJECT, slug: SLUG, loadCandidates: () => [wrongField] });
  assert.equal(d.action, "queue");
  if (d.action === "queue") {
    assert.equal(d.reason, "field_mismatch");
    assert.deepEqual(d.candidateApiIds, [700]);
  }
});

test("classifyVeo: no scheduled match in window → queued no_match", () => {
  const d = classifyVeo({ subject: SUBJECT, slug: SLUG, loadCandidates: () => [] });
  assert.equal(d.action, "queue");
  if (d.action === "queue") assert.equal(d.reason, "no_match");
});

test("classifyVeo: title date days before email arrival still matches the historical match (no recency window)", () => {
  // Recordings are manager-driven and can arrive days late. A "SC | Jul 20"
  // email that lands Jul 28 must still look up and match the Jul 20 match.
  // classifyVeo takes only subject + slug + candidate rows — there is NO
  // receivedAt / now() input, and loadVenueCandidates bounds by the TITLE's
  // date, not email arrival. The only tolerance is ±window around the title
  // start time on that specific historical date.
  const RECEIVED_AT = "2026-07-28T09:00:00Z"; // 8 days after the match — irrelevant to matching
  void RECEIVED_AT;
  const historicalMatch: VeoCandidateRow = {
    api_id: 30001,
    field_id: 102,
    start_date: "2026-07-20T20:00:00+00:00", // Jul 20, 8:00 PM local
    is_cancelled: false,
  };
  const d = classifyVeo({
    subject: "SC | Jul 20 | 8:00PM is ready to watch!",
    slug: "20260721-sc-jul-20-800pm-vhist777", // processing date = Jul 21 (match + 1 day)
    loadCandidates: (finVenueId, matchDate) => {
      // The lookup asks for the TITLE's date, never "recent" or arrival-based.
      assert.equal(matchDate, "2026-07-20");
      assert.equal(finVenueId, 11);
      return [historicalMatch];
    },
  });
  assert.equal(d.action, "post");
  if (d.action === "post") {
    assert.equal(d.apiId, 30001);
    assert.equal(d.matchDate, "2026-07-20"); // title date, not the Jul 21 slug date or Jul 28 arrival
  }
});

test("classifyVeo: unknown code → queued unknown_code", () => {
  const d = classifyVeo({
    subject: "ZZ | Jul 24 | 8:00PM is ready to watch!",
    slug: "20260725-zz-jul-24-800pm-vaaaa111",
    loadCandidates: () => [scMatch],
  });
  assert.equal(d.action, "queue");
  if (d.action === "queue") assert.equal(d.reason, "unknown_code");
});

test("classifyVeo: mapped-but-unconfirmed code queues even on a clean match", () => {
  // An unconfirmed code must NOT auto-post until Ryan confirms the camera + exact
  // string; it carries its best-guess candidate for one-click assign.
  //
  // THE MAP IS INJECTED, NOT READ OFF THE SHIPPING CONSTANT. This case used to lean
  // on VEO_FIELD_CODES having PRUMC at confirmed:false, so re-syncing the constant to
  // the live veo_codes table (where PRUMC is confirmed) turned a test about the
  // unconfirmed GATE into a test about one row's current value. The gate is the
  // subject here, so the fixture states it.
  const prumcMatch: VeoCandidateRow = { api_id: 555, field_id: 958, start_date: "2026-07-24T20:00:00+00:00", is_cancelled: false };
  const d = classifyVeo({
    subject: "PRUMC | Jul 24 | 8:00PM is ready to watch!",
    slug: "20260725-prumc-jul-24-800pm-vbbbb222",
    loadCandidates: () => [prumcMatch],
    codes: { PRUMC: { finVenueId: 16, fieldIds: [958], fieldLabel: "PRUMC", city: "Atlanta", confirmed: false } },
  });
  assert.equal(d.action, "queue");
  if (d.action === "queue") {
    assert.equal(d.reason, "unconfirmed_code");
    assert.deepEqual(d.candidateApiIds, [555]);
  }
});

// -------------------- year-boundary + am/pm resolution --------------------

test("classifyVeo: Dec 31 title with a January (next-year) slug matches the prior-year match (not queued)", () => {
  const dec31: VeoCandidateRow = { api_id: 90001, field_id: 102, start_date: "2026-12-31T20:00:00+00:00", is_cancelled: false };
  const d = classifyVeo({
    subject: "SC | Dec 31 | 8:00pm is ready to watch!",
    slug: "20270101-sc-dec-31-800pm-vyear999", // processed Jan 1 2027 (next year)
    loadCandidates: (_finVenueId, matchDate) => {
      assert.equal(matchDate, "2026-12-31"); // resolved to the prior year, not 2027
      return [dec31];
    },
  });
  assert.equal(d.action, "post");
  if (d.action === "post") {
    assert.equal(d.apiId, 90001);
    assert.equal(d.matchDate, "2026-12-31");
  }
});

test("classifyVeo: slug-year date has no match → retries prior year before queuing", () => {
  const prevYear: VeoCandidateRow = { api_id: 70007, field_id: 102, start_date: "2025-07-24T20:00:00+00:00", is_cancelled: false };
  const d = classifyVeo({
    subject: "SC | Jul 24 | 8:00pm is ready to watch!",
    slug: "20260725-sc-jul-24-800pm-vprev888", // slug year 2026
    loadCandidates: (_finVenueId, matchDate) => {
      if (matchDate === "2026-07-24") return []; // slug year: nothing scheduled
      if (matchDate === "2025-07-24") return [prevYear]; // prior year: the match
      return [];
    },
  });
  assert.equal(d.action, "post");
  if (d.action === "post") {
    assert.equal(d.apiId, 70007);
    assert.equal(d.matchDate, "2025-07-24");
  }
});

test("classifyVeo: bare time resolved to the single real match via schedule (PM)", () => {
  // "SC | Jul 24 | 8:00" (no am/pm). Only an 8 PM match exists → resolves PM.
  const d = classifyVeo({
    subject: "SC | Jul 24 | 8:00 is ready to watch!",
    slug: SLUG,
    loadCandidates: () => [scMatch], // 8 PM
  });
  assert.equal(d.action, "post");
  if (d.action === "post") {
    assert.equal(d.apiId, 14613);
    assert.equal(d.timeMinutes, 20 * 60);
    assert.equal(d.timeLabel, "8:00 PM");
  }
});

test("classifyVeo: bare time matching BOTH am and pm → queued ambiguous_time", () => {
  const amMatch: VeoCandidateRow = { api_id: 801, field_id: 102, start_date: "2026-07-24T08:00:00+00:00", is_cancelled: false };
  const pmMatch: VeoCandidateRow = { api_id: 802, field_id: 102, start_date: "2026-07-24T20:00:00+00:00", is_cancelled: false };
  const d = classifyVeo({
    subject: "SC | Jul 24 | 8:00 is ready to watch!",
    slug: SLUG,
    loadCandidates: () => [amMatch, pmMatch],
  });
  assert.equal(d.action, "queue");
  if (d.action === "queue") {
    assert.equal(d.reason, "ambiguous_time");
    assert.deepEqual(d.candidateApiIds.sort(), [801, 802].sort());
  }
});

test("classifyVeo: bare time matching NEITHER meridiem → queued no_match", () => {
  const noon: VeoCandidateRow = { api_id: 803, field_id: 102, start_date: "2026-07-24T12:00:00+00:00", is_cancelled: false };
  const d = classifyVeo({
    subject: "SC | Jul 24 | 8:00 is ready to watch!",
    slug: SLUG,
    loadCandidates: () => [noon], // noon is >90 min from both 8 AM and 8 PM
  });
  assert.equal(d.action, "queue");
  if (d.action === "queue") assert.equal(d.reason, "no_match");
});

test("classifyVeo: 'ATH P | Jul 24 | 9:15' resolves am/pm via schedule; would auto-post once confirmed", () => {
  // Held unconfirmed by the injected map (same reason as the PRUMC case above:
  // the live table now confirms ATH Pearland, and this case is about the gate,
  // not about that row). It queues as unconfirmed_code — but it parses (code
  // "ATH P"), resolves 9:15 → PM against the schedule, and carries the matched
  // candidate: flipping confirmed makes it an auto-post.
  const pearland915pm: VeoCandidateRow = { api_id: 4242, field_id: 32, start_date: "2026-07-24T21:15:00+00:00", is_cancelled: false };
  const d = classifyVeo({
    subject: "ATH P | Jul 24 | 9:15 is ready to watch!",
    slug: "20260725-ath-p-jul-24-915-vpppp333",
    codes: { "ATH P": { finVenueId: 8, fieldIds: [32], fieldLabel: "ATH Pearland", city: "Houston", confirmed: false } },
    loadCandidates: (finVenueId) => {
      assert.equal(finVenueId, 8); // ATH Pearland fin_venue
      return [pearland915pm];
    },
  });
  assert.equal(d.action, "queue");
  if (d.action === "queue") {
    assert.equal(d.reason, "unconfirmed_code");
    assert.equal(d.code, "ATH P");
    assert.equal(d.matchDate, "2026-07-24");
    assert.equal(d.timeLabel, "9:15 PM"); // resolved to PM via the schedule
    assert.deepEqual(d.candidateApiIds, [4242]);
  }
});

// -------------------- DB-backed code map (path B) --------------------

test("validateVeoCodeInput: accepts valid input, normalizes code, dedupes field_ids", () => {
  const r = validateVeoCodeInput({
    code: " ath  p ",
    finVenueId: 8,
    fieldIds: [32, 32],
    fieldLabel: "ATH Pearland",
    city: "Houston",
    confirmed: true,
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.code, "ATH P"); // trimmed, single-spaced, uppercased
    assert.deepEqual(r.value.field_ids, [32]); // deduped
    assert.equal(r.value.fin_venue_id, 8);
    assert.equal(r.value.confirmed, true);
  }
});

test("validateVeoCodeInput: rejects empty code / no fields / bad venue / bad field / missing label or city", () => {
  const base = { code: "X", finVenueId: 8, fieldIds: [1], fieldLabel: "L", city: "C" };
  assert.equal(validateVeoCodeInput({ ...base, code: "   " }).ok, false);
  assert.equal(validateVeoCodeInput({ ...base, fieldIds: [] }).ok, false);
  assert.equal(validateVeoCodeInput({ ...base, finVenueId: 0 }).ok, false);
  assert.equal(validateVeoCodeInput({ ...base, fieldIds: [-3] }).ok, false);
  assert.equal(validateVeoCodeInput({ ...base, fieldLabel: " " }).ok, false);
  assert.equal(validateVeoCodeInput({ ...base, city: " " }).ok, false);
});

test("classifyVeo: resolves against the PROVIDED map (an edit persists → matching uses it)", () => {
  // A code that exists only in the passed map — matching must use it.
  const codes = {
    "NEW CODE": { finVenueId: 42, fieldIds: [777], fieldLabel: "New Field", city: "Austin", confirmed: true },
  };
  const match: VeoCandidateRow = { api_id: 8888, field_id: 777, start_date: "2026-07-24T20:00:00+00:00", is_cancelled: false };
  const d = classifyVeo({
    subject: "NEW CODE | Jul 24 | 8:00PM is ready to watch!",
    slug: "20260725-newcode-jul-24-800pm-vnew111",
    loadCandidates: (finVenueId) => {
      assert.equal(finVenueId, 42); // uses the mapped venue
      return [match];
    },
    codes,
  });
  assert.equal(d.action, "post");
  if (d.action === "post") assert.equal(d.apiId, 8888);
});

test("classifyVeo: the confirmed flag in the map flips auto-post ⇄ queue", () => {
  const base = { finVenueId: 8, fieldIds: [32], fieldLabel: "ATH Pearland", city: "Houston" };
  const match: VeoCandidateRow = { api_id: 4242, field_id: 32, start_date: "2026-07-24T20:00:00+00:00", is_cancelled: false };
  const args = {
    subject: "ATH P | Jul 24 | 8:00PM is ready to watch!",
    slug: "20260725-ath-p-jul-24-800pm-vp1",
    loadCandidates: () => [match],
  };
  const q = classifyVeo({ ...args, codes: { "ATH P": { ...base, confirmed: false } } });
  assert.equal(q.action, "queue");
  if (q.action === "queue") assert.equal(q.reason, "unconfirmed_code");

  const p = classifyVeo({ ...args, codes: { "ATH P": { ...base, confirmed: true } } });
  assert.equal(p.action, "post");
  if (p.action === "post") assert.equal(p.apiId, 4242);
});

test("classifyVeo: a multi-field code matches on EITHER of its fields", () => {
  const codes = {
    SC: { finVenueId: 11, fieldIds: [102, 199], fieldLabel: "Soccer Central", city: "San Antonio", confirmed: true },
  };
  const on199: VeoCandidateRow = { api_id: 199199, field_id: 199, start_date: "2026-07-24T20:00:00+00:00", is_cancelled: false };
  const d = classifyVeo({ subject: SUBJECT, slug: SLUG, loadCandidates: () => [on199], codes });
  assert.equal(d.action, "post"); // field 199 ∈ [102, 199] → field-agreement holds
  if (d.action === "post") assert.equal(d.apiId, 199199);
});

test("authenticateAdmin: rejects a request with no / blank bearer (non-admin can't mutate codes)", async () => {
  const noHeader = await authenticateAdmin(new Request("https://x/api/veo/codes", { method: "POST" }));
  assert.equal(noHeader.ok, false);
  if (!noHeader.ok) assert.equal(noHeader.status, 401);
  const blank = await authenticateAdmin(
    new Request("https://x/api/veo/codes", { method: "POST", headers: { Authorization: "Bearer " } }),
  );
  assert.equal(blank.ok, false);
  if (!blank.ok) assert.equal(blank.status, 401);
});

test("classifyVeo: free-form titles with no clean time → queued, not posted", () => {
  const d1 = classifyVeo({
    subject: "Match Jul 20, 2026 WESTLAKE MONDAY 20tg is ready to watch!",
    slug: "20260721-westlake-jul-20-vqqqq444",
    loadCandidates: () => [scMatch],
  });
  assert.equal(d1.action, "queue");
  if (d1.action === "queue") assert.equal(d1.reason, "unparseable_subject");

  const d2 = classifyVeo({
    subject: "PRUMC-TUESDAY GAME JULY,21 2026 is ready to watch!",
    slug: "20260722-prumc-jul-21-vrrrr555",
    loadCandidates: () => [scMatch],
  });
  assert.equal(d2.action, "queue");
  if (d2.action === "queue") assert.equal(d2.reason, "unparseable_subject");
});

// =====================================================================
// THE LOOSER MATCHER — every case below is drawn from the 204 real rows
// in veo_recordings, not invented. Where a case names a recording, that
// recording exists and the sweep output is quoted with it.
// =====================================================================

// ------------------- resolving a code by degrees -------------------

test("resolveVeoCodeScored: the tiers, and what each one is worth", () => {
  const t = (code: string) => {
    const r = resolveVeoCodeScored(code);
    return [r.key, r.tier, r.score] as const;
  };
  assert.deepEqual(t("SC"), ["SC", "exact", 40]);
  assert.deepEqual(t("athk"), ["ATHK", "exact", 40]); // case is not a difference
  assert.deepEqual(t("ATH K"), ["ATHK", "squashed", 36]); // the space is not a difference
  assert.deepEqual(t("PRMUC"), ["PRUMC", "typo", 24]); // one transposition
  assert.deepEqual(t("Onion Creek"), ["OC", "label", 18]); // matched inside the field label
  assert.deepEqual(t("WESTLAKE"), ["WL", "label", 18]);
});

test("resolveVeoCodeScored: 'ATH' resolves to NOTHING — ATHK and ATHP are equidistant", () => {
  // The uniqueness rule, which is the whole safety property of the fuzzy tiers.
  // "ATH" is a prefix of both ATHK and ATHP and one edit from each. Two venues in
  // two different cities are not a near miss, they are a coin flip, and a coin
  // flip puts one club's film in another club's chat.
  const r = resolveVeoCodeScored("ATH");
  assert.equal(r.key, null);
  assert.equal(r.tier, "none");
  assert.equal(r.score, 0);

  // Control: the same call one letter longer resolves, so the null above is the
  // uniqueness rule firing and not a broken lookup.
  assert.equal(resolveVeoCodeScored("ATHP").key, "ATHP");
  assert.equal(resolveVeoCodeScored("ATHK").key, "ATHK");
});

test("resolveVeoCodeScored: nonsense stays nonsense", () => {
  assert.equal(resolveVeoCodeScored("nope").key, null);
  assert.equal(resolveVeoCodeScored("").key, null);
  assert.equal(resolveVeoCodeScored(null).key, null);
});

// ------------------------- reading the date -------------------------

test("parseVeoSubject: the four date shapes, and what each scores", () => {
  const form = (s: string) => {
    const p = parseVeoSubject(s);
    assert.ok(p.ok, s);
    return p.ok ? [p.value.month, p.value.day, p.value.dateForm] : [];
  };
  assert.deepEqual(form("SC | 2026-07-24 | 8:00PM"), [7, 24, "iso"]);
  assert.deepEqual(form("SC | Jul 24 | 8:00PM"), [7, 24, "month"]);
  assert.deepEqual(form("SC | Jul24 | 8:00PM"), [7, 24, "month"]);
  assert.deepEqual(form("SCISS | 24 jul | 8pm"), [7, 24, "dmon"]);
  assert.deepEqual(form("SC | 7/24 | 8:00PM"), [7, 24, "numeric"]);
});

test("parseVeoSubject: a numeric date flips ONLY when the first number cannot be a month", () => {
  const md = (s: string) => {
    const p = parseVeoSubject(s);
    assert.ok(p.ok, s);
    return p.ok ? [p.value.month, p.value.day] : [];
  };
  // 13 is not a month and 7 is → it can only be 13 July. Flip.
  assert.deepEqual(md("SC | 13/7 | 8:00PM"), [7, 13]);
  // 7 IS a month, so month-first stands: 13 July again, by the American reading.
  assert.deepEqual(md("SC | 7/13 | 8:00PM"), [7, 13]);
  // BOTH could be a month. It does NOT flip — it takes the American reading and
  // says so by scoring 22 instead of 30. This is the case the score exists for.
  assert.deepEqual(md("SC | 7/8 | 8:00PM"), [7, 8]);
  const p = parseVeoSubject("SC | 7/8 | 8:00PM");
  assert.equal(p.ok && p.value.dateForm, "numeric");
});

test("parseVeoSubject: a three-part numeric date is believed about its own year", () => {
  const p = parseVeoSubject("SATXMD/9-2-26/10PM");
  assert.ok(p.ok);
  if (p.ok) {
    assert.equal(p.value.dateYear, 2026);
    // And the stated year wins over the slug's year inference.
    assert.deepEqual(resolveMatchDates(p.value, { year: 2027, month: 1, day: 3 }), ["2026-09-02"]);
  }
});

test("parseVeoSubject: a misspelled month is read, and scores below a correct one", () => {
  // Real subject, recording processed 2026-08-27.
  const p = parseVeoSubject("SC-AGUST-26-11PM is ready to watch!");
  assert.ok(p.ok);
  if (p.ok) {
    assert.equal(p.value.month, 8);
    assert.equal(p.value.day, 26);
    assert.equal(p.value.dateForm, "month-typo");
    assert.equal(p.value.code, "SC");
  }
  // But only within ONE edit of a full month name. Three-letter noise is not a
  // typo for a month — this case is pinned unparseable above and stays there.
  assert.equal(parseVeoSubject("SC | JXl 24 | 8PM").ok, false);
});

test("parseVeoSubject: the numeric reader must not eat the kick-off time", () => {
  // THE REGRESSION. All three of these posted to the WRONG DAY in the sweep before
  // the month-typo reader existed: "agust" was not a month the parser knew, so the
  // numeric reader took the next pair it saw — which was the day and the hour.
  //   Sc-agust-4-10pm  → read 4/10  → posted into a match on 10 APRIL (api 13449)
  //   SC-agust14-7pm   → read 14/7  → posted into a match on 14 JULY  (api 16411)
  //   SC-agust28-7pm   → read 28/7  → posted into a match on 28 JULY  (api 17040)
  const cases: [string, number, number][] = [
    ["Sc-agust-4-10pm is ready to watch!", 8, 4],
    ["SC-agust14-7pm is ready to watch!", 8, 14],
    ["SC-agust28-7pm is ready to watch!", 8, 28],
  ];
  for (const [subject, month, day] of cases) {
    const p = parseVeoSubject(subject);
    assert.ok(p.ok, subject);
    if (p.ok) {
      assert.equal(p.value.month, month, subject);
      assert.equal(p.value.day, day, subject);
    }
  }
});

// ------------------------- reading the time -------------------------

test("parseVeoSubject: the three time shapes, and what each scores", () => {
  const shape = (s: string) => {
    const p = parseVeoSubject(s);
    assert.ok(p.ok, s);
    return p.ok ? [p.value.timeForm, p.value.timeOptions[0].label, p.value.ampmKnown] : [];
  };
  assert.deepEqual(shape("SC | Jul 24 | 8:00PM"), ["ampm", "8:00 PM", true]);
  assert.deepEqual(shape("SC | Jul 24 | 20:00"), ["hm", "8:00 PM", true]);
  // A lone trailing number is assumed PM and scored lowest of the three.
  assert.deepEqual(shape("SC | Jul 24 | 8"), ["bare-hour", "8:00 PM", true]);
});

test("parseVeoSubject: a bare hour is read AFTER the date, so the day is never the hour", () => {
  const p = parseVeoSubject("SC | Jul 24 | 8");
  assert.ok(p.ok);
  // 24 is the day. If the bare-hour reader searched the whole title it would find
  // 24 first, fail the 1-12 test, and the title would be unparseable.
  if (p.ok) assert.equal(p.value.day, 24);
});

// --------------------------- the four-part score ---------------------------

test("scoreVeo: a perfect read is 100, and 100 is the only clean band", () => {
  const perfect = scoreVeo({ codeTier: "exact", dateForm: "month", timeForm: "ampm", fieldAgrees: true });
  assert.equal(perfect.total, 100);
  assert.equal(perfect.band, "clean");
  // One guess anywhere and it posts FLAGGED rather than clean.
  assert.equal(scoreVeo({ codeTier: "label", dateForm: "month", timeForm: "ampm", fieldAgrees: true }).total, 78);
  assert.equal(scoreVeo({ codeTier: "label", dateForm: "month", timeForm: "ampm", fieldAgrees: true }).band, "flagged");
  assert.equal(scoreVeo({ codeTier: "exact", dateForm: "month-typo", timeForm: "ampm", fieldAgrees: true }).band, "flagged");
});

test("scoreVeo: no code is not a low score, it is no score", () => {
  // Measured: 19 real subjects ("Parmer Aug 12 8pm") name no known venue and scored
  // 50 on date and time alone, which was the only thing populating the flagged band.
  const s = scoreVeo({ codeTier: "none", dateForm: "month", timeForm: "ampm", fieldAgrees: false });
  assert.equal(s.total, 50);
  assert.equal(s.band, "review"); // NOT flagged, whatever the arithmetic says
});

test("classifyVeo: a clean post carries its score, and an exact read is not flagged", () => {
  const d = classifyVeo({ subject: SUBJECT, slug: SLUG, loadCandidates: () => [scMatch] });
  assert.equal(d.action, "post");
  if (d.action === "post") {
    assert.equal(d.flagged, false);
    assert.equal(d.score.total, 100);
    assert.equal(d.score.codeTier, "exact");
    assert.equal(d.score.fieldAgrees, true);
  }
});

test("classifyVeo: a fuzzily-read code still posts, but FLAGGED", () => {
  // Real recording: 'SCISS | Aug 20 | 8pm' → api 17926, Scissortail Park, field 1090.
  // "SCISS" is not a code. It resolves only by appearing inside the field label.
  const sciss: VeoCandidateRow = { api_id: 17926, field_id: 1090, start_date: "2026-08-20T20:00:00+00:00", is_cancelled: false };
  const d = classifyVeo({
    subject: "SCISS | Aug 20 | 8pm is ready to watch!",
    slug: "20260821-sciss-aug-20-8pm-vs1",
    loadCandidates: () => [sciss],
  });
  assert.equal(d.action, "post");
  if (d.action === "post") {
    assert.equal(d.apiId, 17926);
    assert.equal(d.flagged, true);
    assert.equal(d.score.total, 78);
    assert.equal(d.score.codeTier, "label");
  }
});

test("classifyVeo: too loose to send → queued low_confidence, never posted", () => {
  // A label-tier code, a numeric date and a guessed hour: 18 + 22 + 8 + 10 = 58.
  // Above the 45 line, so it posts flagged. Drop the field agreement and it is 48.
  // Below 45 the SAME clean single match is refused.
  const s = scoreVeo({ codeTier: "label", dateForm: "numeric", timeForm: "bare-hour", fieldAgrees: false });
  assert.equal(s.total, 48);
  assert.equal(s.band, "flagged");
  const under = scoreVeo({ codeTier: "typo", dateForm: "numeric", timeForm: "bare-hour", fieldAgrees: false });
  assert.equal(under.total, 54);
  assert.equal(bandFor(44), "review");
  assert.equal(bandFor(45), "flagged");
  assert.equal(bandFor(99), "flagged");
  assert.equal(bandFor(100), "clean");
});

// ------------------- the codes map, and when it may authorize -------------------

test("classifyVeo: a failed veo_codes read IDENTIFIES the code but never posts", () => {
  // The in-code constant is a snapshot that can be months stale. On a read failure
  // the route passes codesAuthoritative:false, and a would-be clean post — this is
  // the exact subject that posts at 100 above — queues instead, with a reason that
  // says the code list was the problem and not the title.
  const d = classifyVeo({
    subject: SUBJECT,
    slug: SLUG,
    loadCandidates: () => [scMatch],
    codesAuthoritative: false,
  });
  assert.equal(d.action, "queue");
  if (d.action === "queue") {
    assert.equal(d.reason, "codes_unavailable");
    assert.equal(d.code, "SC"); // identified
    assert.deepEqual(d.candidateApiIds, [14613]); // and carries the one-click assign
  }
});

test("VEO_FIELD_CODES: the fallback constant agrees with the live veo_codes table", () => {
  // Re-synced 2026-09-04 against the 12 live rows. Seven codes were missing entirely
  // (ATHK ATHP HC NEMP OC SCI WL) and five stale keys carried spaces or full names
  // ("ATH P", "WESTLAKE") that the table has never used.
  //
  // SC IS THE ONE DELIBERATE DISAGREEMENT. The table has SC on fields 102, 199 and
  // 1354; this constant keeps 102 and 199 because its own comment records 1354
  // (Premier) and 1123 (World Cup) as excluded ON PURPOSE. Unresolved on purpose —
  // whether Premier games should be filmed is not a question this file answers.
  assert.deepEqual(VEO_FIELD_CODES.SC.fieldIds, [102, 199]);
  assert.equal(Object.keys(VEO_FIELD_CODES).length, 12);
  for (const key of Object.keys(VEO_FIELD_CODES)) {
    assert.match(key, /^[A-Z]+$/, `${key} must be a bare code — the table has no spaces in it`);
  }
});
