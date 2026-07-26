// Veo → match-chat auto-poster: pure parsing / matching logic + the
// code→venue config. No server-only imports here so every branch is
// unit-testable under `node --test`. The DB + Firestore side lives in
// src/lib/veoPost.ts and the route handlers.
//
// Background (confirmed constraints):
//   - There is NO Veo API. The only trigger is the email from
//     service@veo.co with subject "<TITLE> is ready to watch!" — the
//     FINAL video. The "is processing - early access available!"
//     preview emails MUST be ignored.
//   - The ONLY match-key is the subject TITLE: "CODE | Mon DD | H:MMPM"
//     (e.g. "SC | Jul 24 | 8:00PM"). Titles are user-set and not always
//     correct — anything not confidently matched goes to a review queue,
//     never a blind post to the wrong chat.
//   - The shareable link is the "Watch your video" href, of the form
//     https://app.veo.co/matches/<title-slug>-<id>/ — posted as-is. The
//     trailing recording id (e.g. v8d5b42e) is the IDEMPOTENCY KEY.
//   - The URL's leading date (e.g. 20260725) is the PROCESSING date,
//     ~1 day AFTER the match. It is used ONLY to disambiguate the year;
//     the TITLE date/time is the source of truth for matching.

// ---------------------------------------------------------------------------
// Config: CODE → venue map
// ---------------------------------------------------------------------------

export type VeoCodeVenue = {
  // fin_venues.id — a code maps to a whole venue, which may cover several
  // mdapi field_ids (Soccer Central = SC Field 3 / 4 / 4A). Date + time
  // disambiguate the specific match under that venue.
  finVenueId: number;
  venueName: string;
  city: string;
  // Safety gate. Only `confirmed: true` codes auto-post; everything else
  // is routed to the review queue with reason "unconfirmed_code" so a
  // guessed mapping can never post to a real player chat before Ryan has
  // signed off on it. Flip to true once confirmed.
  confirmed: boolean;
};

// SC = Soccer Central is the one confirmed seed (given). The other six are
// PROPOSED best-guesses for Ryan to confirm/correct before go-live — kept
// `confirmed: false` so they queue-only until then. fin_venues ids are from
// the seeded fin_venue_fields links (migration 0041 and later).
export const VEO_CODE_VENUES: Record<string, VeoCodeVenue> = {
  SC: { finVenueId: 11, venueName: "Soccer Central", city: "San Antonio", confirmed: true },

  // ---- PROPOSED — confirm or correct before flipping `confirmed` ----
  NEMP: { finVenueId: 2, venueName: "NEMP", city: "Austin", confirmed: false },
  AK: { finVenueId: 7, venueName: "ATH Katy", city: "Houston", confirmed: false },
  PR: { finVenueId: 16, venueName: "PRUMC", city: "Atlanta", confirmed: false },
  BP: { finVenueId: 13, venueName: "Bicentennial Park", city: "Dallas", confirmed: false },
  LF: { finVenueId: 18, venueName: "Lou Fusz Outdoor", city: "St. Louis", confirmed: false },
  STP: { finVenueId: 21, venueName: "Scissortail Park", city: "OKC", confirmed: false },
};

export function resolveVeoCode(code: string | null | undefined): VeoCodeVenue | null {
  if (!code) return null;
  return VEO_CODE_VENUES[code.trim().toUpperCase()] ?? null;
}

// ± window (minutes) around the title start time when hunting for the
// scheduled match. Titles carry the intended slot; a ±90-min window
// absorbs early/late starts and rounding while staying tight enough that
// two same-venue matches on the same evening stay distinguishable.
export const VEO_MATCH_WINDOW_MIN = 90;

// ---------------------------------------------------------------------------
// Status / queue-reason vocab (mirrors the veo_recordings.status column)
// ---------------------------------------------------------------------------

export type VeoStatus = "posted" | "queued" | "dismissed";

export type VeoQueueReason =
  | "unparseable_subject" // title didn't match "CODE | Mon DD | H:MMPM"
  | "unknown_code" // code not in VEO_CODE_VENUES
  | "unconfirmed_code" // code mapped but not yet confirmed for go-live
  | "no_match" // parsed fine, zero scheduled matches in window
  | "multiple_matches" // more than one candidate — never auto-pick
  | "post_failed"; // matched + posted attempt threw (Firestore/DB) — retry via queue

// ---------------------------------------------------------------------------
// Email gate
// ---------------------------------------------------------------------------

const READY_RX = /is ready to watch/i;
const PREVIEW_RX = /is processing|early access/i;

// True only for the FINAL "ready to watch" email. Preview / early-access
// emails are rejected even if some future variant also contains the words
// "ready to watch".
export function isFinalReadyEmail(subject: string | null | undefined): boolean {
  if (!subject) return false;
  if (PREVIEW_RX.test(subject)) return false;
  return READY_RX.test(subject);
}

// ---------------------------------------------------------------------------
// Link parsing → recording id + slug (the idempotency key)
// ---------------------------------------------------------------------------

export type VeoRecordingRef = { slug: string; recordingId: string };

// Extract the match-path slug and trailing recording id from the shareable
// URL. e.g. https://app.veo.co/matches/20260725-sc-jul-24-800pm-v8d5b42e/
//   → { slug: "20260725-sc-jul-24-800pm-v8d5b42e", recordingId: "v8d5b42e" }
export function extractRecordingRef(url: string | null | undefined): VeoRecordingRef | null {
  if (!url) return null;
  const m = /app\.veo\.co\/matches\/([^/?#]+)/i.exec(url.trim());
  if (!m) return null;
  const slug = m[1];
  const parts = slug.split("-").filter(Boolean);
  const recordingId = parts[parts.length - 1];
  // A valid slug always ends in an id segment distinct from the leading
  // date; a bare 8-digit date alone is not a usable recording id.
  if (!recordingId || parts.length < 2) return null;
  return { slug, recordingId };
}

// The leading YYYYMMDD in the slug is Veo's PROCESSING date (~1 day after
// the match). Used ONLY to resolve the title's year — never for matching.
export type YMD = { year: number; month: number; day: number };

export function processingDateFromSlug(slug: string | null | undefined): YMD | null {
  if (!slug) return null;
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(slug);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

// ---------------------------------------------------------------------------
// Subject title parsing → code / month-day / start minutes
// ---------------------------------------------------------------------------

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

export type VeoTitle = {
  code: string;
  month: number; // 1-12
  day: number; // 1-31
  timeMinutes: number; // minutes since local midnight (title start time)
  timeLabel: string; // normalized "8:00 PM"
};

export type ParseResult =
  | { ok: true; value: VeoTitle }
  | { ok: false; reason: Extract<VeoQueueReason, "unparseable_subject"> };

function fail(): ParseResult {
  return { ok: false, reason: "unparseable_subject" };
}

// Parse "CODE | Mon DD | H:MMPM" out of the subject. The subject usually
// carries a trailing " is ready to watch!" suffix — stripped first. The
// title is the source of truth for date + time.
export function parseVeoSubject(subject: string | null | undefined): ParseResult {
  if (!subject) return fail();
  // Strip the trailing "... is ready to watch!" (and anything after).
  const title = subject.replace(/\s+is ready to watch.*$/i, "").trim();
  const parts = title.split("|").map((s) => s.trim()).filter(Boolean);
  if (parts.length < 3) return fail();

  const code = parts[0].toUpperCase();
  if (!code) return fail();

  // Date: "Jul 24" (allow an optional trailing dot: "Jul. 24").
  const dm = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})$/.exec(parts[1]);
  if (!dm) return fail();
  const month = MONTHS[dm[1].slice(0, 3).toLowerCase()];
  const day = Number(dm[2]);
  if (!month || day < 1 || day > 31) return fail();

  // Time: "8:00PM" / "8PM" / "8:00 pm".
  const tm = /^(\d{1,2})(?::(\d{2}))?\s*([AaPp][Mm])$/.exec(parts[2]);
  if (!tm) return fail();
  let hour = Number(tm[1]);
  const minute = tm[2] ? Number(tm[2]) : 0;
  if (hour < 1 || hour > 12 || minute > 59) return fail();
  const isPm = tm[3].toLowerCase() === "pm";
  if (isPm && hour < 12) hour += 12;
  else if (!isPm && hour === 12) hour = 0;
  const timeMinutes = hour * 60 + minute;

  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const timeLabel = `${h12}:${String(minute).padStart(2, "0")} ${isPm ? "PM" : "AM"}`;

  return { ok: true, value: { code, month, day, timeMinutes, timeLabel } };
}

// ---------------------------------------------------------------------------
// Match date resolution (year comes from the processing date)
// ---------------------------------------------------------------------------

function isoFromParts(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// The title has no year; the processing date (from the URL slug) does, and
// the match is ~1 day BEFORE processing. Pick the year so the match date
// sits at or just before the processing date — handling the Dec→Jan
// boundary (match Dec 31 → processed Jan 1 of the next year).
export function resolveMatchDate(
  title: Pick<VeoTitle, "month" | "day">,
  processing: YMD | null,
): string | null {
  if (!processing) {
    // No year context at all. Refuse rather than guess — the caller
    // queues it (better a review item than a wrong-year match).
    return null;
  }
  const candUtc = Date.UTC(processing.year, title.month - 1, title.day);
  const procUtc = Date.UTC(processing.year, processing.month - 1, processing.day);
  const diffDays = (procUtc - candUtc) / 86_400_000;
  // If the same-year candidate lands more than a few days in the FUTURE of
  // the processing date, the real match was late last year.
  const year = diffDays < -3 ? processing.year - 1 : processing.year;
  return isoFromParts(year, title.month, title.day);
}

// ---------------------------------------------------------------------------
// Match selection against candidate mdapi_matches rows
// ---------------------------------------------------------------------------

// Venue-local calendar date + minutes-since-midnight for an mdapi row.
// mdapi.start_date stores venue-local wall clock as a timestamptz at UTC
// offset, so reading its UTC parts yields the local date + 24h time with no
// IANA conversion (same approach as schedule-master/discrepancies).
export function matchLocalStart(
  startDate: string | null | undefined,
): { date: string; minutes: number } | null {
  if (!startDate) return null;
  const ts = Date.parse(startDate);
  if (Number.isNaN(ts)) return null;
  const d = new Date(ts);
  return {
    date: d.toISOString().slice(0, 10),
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
  };
}

export type VeoCandidateRow = {
  api_id: number;
  start_date: string | null;
  is_cancelled: boolean | null;
};

// From the candidate mdapi rows (caller has already restricted to this
// venue's field_ids and excluded soft-deleted rows), keep the ones on the
// title's local date within ±window of the title start time. Cancelled
// matches are excluded — we never post a video into a called-off match.
export function selectVeoMatches(
  target: { matchDate: string; timeMinutes: number },
  rows: VeoCandidateRow[],
): VeoCandidateRow[] {
  return rows.filter((r) => {
    if (r.is_cancelled === true) return false;
    const s = matchLocalStart(r.start_date);
    if (!s) return false;
    if (s.date !== target.matchDate) return false;
    return Math.abs(s.minutes - target.timeMinutes) <= VEO_MATCH_WINDOW_MIN;
  });
}

// ---------------------------------------------------------------------------
// End-to-end classification (pure): given a subject + link + the candidate
// rows for the resolved venue, decide post vs queue and why. The route
// handler does the IO (fetching candidate rows, Firestore write, DB write);
// this function owns every branch of the decision so it's fully testable.
// ---------------------------------------------------------------------------

export type VeoDecision =
  | {
      action: "post";
      code: string;
      finVenueId: number;
      matchDate: string;
      timeMinutes: number;
      timeLabel: string;
      apiId: number;
    }
  | {
      action: "queue";
      reason: VeoQueueReason;
      // Best-effort parse output for the review UI (any of these may be null
      // when parsing failed upstream).
      code: string | null;
      finVenueId: number | null;
      matchDate: string | null;
      timeMinutes: number | null;
      timeLabel: string | null;
      // Candidate match ids for the multiple_matches case (or a lone
      // best-guess), surfaced so the reviewer can one-click assign.
      candidateApiIds: number[];
    };

export function classifyVeo(args: {
  subject: string;
  slug: string;
  // Loader the route supplies: given a fin_venues id, return that venue's
  // candidate mdapi rows on the resolved date. Kept as an injected function
  // so this stays pure and testable with fixtures.
  loadCandidates: (finVenueId: number, matchDate: string) => VeoCandidateRow[];
}): VeoDecision {
  const { subject, slug, loadCandidates } = args;

  const parsed = parseVeoSubject(subject);
  if (!parsed.ok) {
    return {
      action: "queue",
      reason: "unparseable_subject",
      code: null,
      finVenueId: null,
      matchDate: null,
      timeMinutes: null,
      timeLabel: null,
      candidateApiIds: [],
    };
  }
  const title = parsed.value;

  const venue = resolveVeoCode(title.code);
  if (!venue) {
    return {
      action: "queue",
      reason: "unknown_code",
      code: title.code,
      finVenueId: null,
      matchDate: null,
      timeMinutes: title.timeMinutes,
      timeLabel: title.timeLabel,
      candidateApiIds: [],
    };
  }

  const matchDate = resolveMatchDate(title, processingDateFromSlug(slug));
  if (!matchDate) {
    return {
      action: "queue",
      reason: "no_match",
      code: title.code,
      finVenueId: venue.finVenueId,
      matchDate: null,
      timeMinutes: title.timeMinutes,
      timeLabel: title.timeLabel,
      candidateApiIds: [],
    };
  }

  const hits = selectVeoMatches(
    { matchDate, timeMinutes: title.timeMinutes },
    loadCandidates(venue.finVenueId, matchDate),
  );

  // Safety gate: a mapped-but-unconfirmed code queues even on a clean single
  // match, carrying its best-guess so Ryan can one-click assign after review.
  if (!venue.confirmed) {
    return {
      action: "queue",
      reason: "unconfirmed_code",
      code: title.code,
      finVenueId: venue.finVenueId,
      matchDate,
      timeMinutes: title.timeMinutes,
      timeLabel: title.timeLabel,
      candidateApiIds: hits.map((h) => h.api_id),
    };
  }

  if (hits.length === 1) {
    return {
      action: "post",
      code: title.code,
      finVenueId: venue.finVenueId,
      matchDate,
      timeMinutes: title.timeMinutes,
      timeLabel: title.timeLabel,
      apiId: hits[0].api_id,
    };
  }

  return {
    action: "queue",
    reason: hits.length === 0 ? "no_match" : "multiple_matches",
    code: title.code,
    finVenueId: venue.finVenueId,
    matchDate,
    timeMinutes: title.timeMinutes,
    timeLabel: title.timeLabel,
    candidateApiIds: hits.map((h) => h.api_id),
  };
}
