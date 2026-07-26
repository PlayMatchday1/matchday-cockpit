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
  selectVeoMatches,
  type VeoCandidateRow,
} from "./veo.ts";

// A confirmed-venue subject (SC = Soccer Central, the one confirmed code) and
// the shareable URL Veo produces for it. The URL's leading date (20260725) is
// the PROCESSING date, one day after the Jul 24 match.
const SUBJECT = "SC | Jul 24 | 8:00PM is ready to watch!";
const URL = "https://app.veo.co/matches/20260725-sc-jul-24-800pm-v8d5b42e/";
const SLUG = "20260725-sc-jul-24-800pm-v8d5b42e";

// One SC match on Jul 24 at 8:00 PM local (start_date is venue-local wall
// clock at UTC offset, so the UTC parts read as the local date/time).
const scMatch: VeoCandidateRow = {
  api_id: 14613,
  start_date: "2026-07-24T20:00:00+00:00",
  is_cancelled: false,
};

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
    assert.equal(r.value.timeMinutes, 20 * 60); // 8:00 PM
    assert.equal(r.value.timeLabel, "8:00 PM");
  }
});

test("parseVeoSubject: handles '8PM' and lowercase am/pm and noon/midnight", () => {
  assert.equal((parseVeoSubject("SC | Jul 24 | 8PM") as any).value.timeMinutes, 20 * 60);
  assert.equal((parseVeoSubject("SC | Jul 24 | 8:30 pm") as any).value.timeMinutes, 20 * 60 + 30);
  assert.equal((parseVeoSubject("SC | Jul 24 | 12:00PM") as any).value.timeMinutes, 12 * 60);
  assert.equal((parseVeoSubject("SC | Jul 24 | 12:00AM") as any).value.timeMinutes, 0);
});

test("parseVeoSubject: rejects mis-named / untitled subjects", () => {
  assert.equal(parseVeoSubject("Untitled recording is ready to watch!").ok, false);
  assert.equal(parseVeoSubject("SC Jul 24 8PM").ok, false); // no pipes
  assert.equal(parseVeoSubject("SC | Jul 24").ok, false); // missing time
  assert.equal(parseVeoSubject("SC | JXl 24 | 8PM").ok, false); // bad month
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
  const wrongDay: VeoCandidateRow = { api_id: 2, start_date: "2026-07-25T20:00:00+00:00", is_cancelled: false };
  const tooFar: VeoCandidateRow = { api_id: 3, start_date: "2026-07-24T22:00:00+00:00", is_cancelled: false };
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
  const twin: VeoCandidateRow = { api_id: 99, start_date: "2026-07-24T20:30:00+00:00", is_cancelled: false };
  const d = classifyVeo({ subject: SUBJECT, slug: SLUG, loadCandidates: () => [scMatch, twin] });
  assert.equal(d.action, "queue");
  if (d.action === "queue") {
    assert.equal(d.reason, "multiple_matches");
    assert.deepEqual(d.candidateApiIds.sort(), [99, 14613].sort());
  }
});

test("classifyVeo: no scheduled match in window → queued no_match", () => {
  const d = classifyVeo({ subject: SUBJECT, slug: SLUG, loadCandidates: () => [] });
  assert.equal(d.action, "queue");
  if (d.action === "queue") assert.equal(d.reason, "no_match");
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
  // NEMP is a proposed (confirmed:false) mapping — it must NOT auto-post until
  // Ryan confirms it, but it carries its best-guess candidate for one-click
  // assign.
  const nempMatch: VeoCandidateRow = { api_id: 555, start_date: "2026-07-24T20:00:00+00:00", is_cancelled: false };
  const d = classifyVeo({
    subject: "NEMP | Jul 24 | 8:00PM is ready to watch!",
    slug: "20260725-nemp-jul-24-800pm-vbbbb222",
    loadCandidates: () => [nempMatch],
  });
  assert.equal(d.action, "queue");
  if (d.action === "queue") {
    assert.equal(d.reason, "unconfirmed_code");
    assert.deepEqual(d.candidateApiIds, [555]);
  }
});
