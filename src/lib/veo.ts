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
// Config: CODE → FIELD map
// ---------------------------------------------------------------------------
//
// The Veo title code is a FIELD abbreviation — matches in our data go by
// field, so the code identifies which camera'd field the recording is from.
// Each code therefore maps to a specific mdapi field (mdapi_matches.field_id)
// within a fin_venue. Codes were DERIVED from live data, not guessed:
//   - fin_venue_fields links (fin_venue_id ↔ mdapi_field_id),
//   - schedule_master.detail / the ops abbreviations in venueAbbreviations.ts,
//   - and camera-marked match names (mdapi_matches.name contains "🎥"), which
//     is the strongest signal for which fields actually have a Veo camera.
//
// `fieldIds` is the set of mdapi field_ids the code denotes (usually one; a
// venue's several physical sub-fields — Soccer Central Field 3/4/4A — share a
// single mdapi field_id, so date + time disambiguate the match). It powers the
// FIELD-AGREEMENT CROSS-CHECK: after matching by venue + title date/time, the
// winning match's field_id must be in this set, else the item is queued
// (reason "field_mismatch") rather than posted to a possibly-wrong field.

export type VeoFieldCode = {
  finVenueId: number; // fin_venues.id — the candidate net (all its fields)
  fieldIds: number[]; // mdapi_matches.field_id values this code denotes
  fieldLabel: string; // human label for the review UI
  venueName: string;
  city: string;
  // Safety gate. Only `confirmed: true` codes auto-post; everything else is
  // routed to the review queue with reason "unconfirmed_code" so a derived-
  // but-unverified mapping can never post to a real player chat before Ryan
  // confirms (a) the field has a Veo camera and (b) this is EXACTLY the string
  // Veo produces. Flip to true per field once confirmed.
  confirmed: boolean;
};

// Codes are the REAL strings observed in live recordings ("ATH P", "ATH K",
// "PRUMC") plus the Austin fields that share one camera (VC3-79705: Westlake,
// Onion Creek, Hill Country — since they share a camera, the title CODE is the
// only field signal, so each gets its own code). SC = Soccer Central is the
// confirmed seed. Everything stays `confirmed:false` EXCEPT SC until Ryan
// confirms the exact strings + the camera set per field. St. Louis codes are
// still TBD — kept as unconfirmed placeholders. Keys are normalized (uppercase,
// single-spaced); add alias keys pointing at the same field for any variant.
export const VEO_FIELD_CODES: Record<string, VeoFieldCode> = {
  // fin_venue 11 "Soccer Central". Regular "SC Field 3/4/4A" matches land on
  // BOTH mdapi field 102 ("Soccer Central Complex") AND field 199 ("Tourney at
  // Soccer Central" — a legacy field_title; it carries the same regular
  // Field 3/4/4A matches, in fact more of them). SC must cover both, else a
  // regular recording on 199 would false-positive as field_mismatch. Fields
  // 1123 (World Cup) and 1354 (Premier Match) are genuinely distinct events —
  // deliberately excluded, so a recording that only matches one of those is
  // surfaced for review rather than posted as a normal SC game.
  SC: {
    finVenueId: 11,
    fieldIds: [102, 199],
    fieldLabel: "Soccer Central (SC Field 3/4/4A)",
    venueName: "Soccer Central",
    city: "San Antonio",
    confirmed: true,
  },

  // ---- Real observed codes (confirm exact string + camera, then flip) ----
  // fin_venue 8, field 32 "ATH Pearland" (tourney field 22 excluded).
  "ATH P": {
    finVenueId: 8,
    fieldIds: [32],
    fieldLabel: "ATH Pearland",
    venueName: "ATH Pearland",
    city: "Houston",
    confirmed: false,
  },
  // fin_venue 7, field 892 "ATH Katy".
  "ATH K": {
    finVenueId: 7,
    fieldIds: [892],
    fieldLabel: "ATH Katy",
    venueName: "ATH Katy",
    city: "Houston",
    confirmed: false,
  },
  // fin_venue 16, field 958 "PRUMC".
  PRUMC: {
    finVenueId: 16,
    fieldIds: [958],
    fieldLabel: "PRUMC",
    venueName: "PRUMC",
    city: "Atlanta",
    confirmed: false,
  },

  // ---- Austin shared camera VC3-79705 — CODE is the only field signal ----
  // fin_venue 49, field 1 "Westlake HS Field 3".
  WESTLAKE: {
    finVenueId: 49,
    fieldIds: [1],
    fieldLabel: "Westlake HS",
    venueName: "Westlake",
    city: "Austin",
    confirmed: false,
  },
  // fin_venue 5, field 27 "Onion Creek".
  "ONION CREEK": {
    finVenueId: 5,
    fieldIds: [27],
    fieldLabel: "Onion Creek",
    venueName: "Onion Creek",
    city: "Austin",
    confirmed: false,
  },
  // fin_venue 56, field 1453 "Hill Country Middle School".
  "HILL COUNTRY": {
    finVenueId: 56,
    fieldIds: [1453],
    fieldLabel: "Hill Country MS",
    venueName: "Hill Country",
    city: "Austin",
    confirmed: false,
  },

  // ---- St. Louis — codes still TBD, placeholders (unconfirmed) ----
  // fin_venue 18, field 664 "Lou Fusz Athletic Complex" (Outdoor Field 5/10).
  LF: {
    finVenueId: 18,
    fieldIds: [664],
    fieldLabel: "Lou Fusz Outdoor (Field 5/10)",
    venueName: "Lou Fusz Outdoor",
    city: "St. Louis",
    confirmed: false,
  },
  // fin_venue 19, field 364 "Lou Fusz Athletic Training Center" (Indoor).
  LFI: {
    finVenueId: 19,
    fieldIds: [364],
    fieldLabel: "Lou Fusz Indoor (Training Center)",
    venueName: "Lou Fusz Indoor",
    city: "St. Louis",
    confirmed: false,
  },
  // fin_venue 20, field 760 "Centennial Commons".
  CC: {
    finVenueId: 20,
    fieldIds: [760],
    fieldLabel: "Centennial Commons",
    venueName: "Centennial Commons",
    city: "St. Louis",
    confirmed: false,
  },
};

export function resolveVeoCode(code: string | null | undefined): VeoFieldCode | null {
  if (!code) return null;
  // Normalize like the parser: trim, collapse internal whitespace, uppercase —
  // so "ath p", "ATH  P", and "ATH P" all resolve to the same field code.
  const key = code.trim().replace(/\s+/g, " ").toUpperCase();
  return VEO_FIELD_CODES[key] ?? null;
}

// ± window (minutes) around the title start time when hunting for the
// scheduled match. Titles carry the intended slot; a ±90-min window
// absorbs early/late starts and rounding while staying tight enough that
// two same-venue matches on the same evening stay distinguishable.
export const VEO_MATCH_WINDOW_MIN = 90;

// The copy line posted into the match thread immediately BEFORE the bare
// video URL. Two separate messages are sent — this copy line, then the URL
// alone — because the players' app only makes a URL clickable when the URL
// is the ENTIRE message body; any text in the same bubble kills the link.
// Edit this string to change the wording (it's the one editable place).
export function veoMessageText(): string {
  return "🎥 Your match film is ready to watch!";
}

// ---------------------------------------------------------------------------
// Status / queue-reason vocab (mirrors the veo_recordings.status column)
// ---------------------------------------------------------------------------

export type VeoStatus = "posted" | "queued" | "dismissed";

export type VeoQueueReason =
  | "unparseable_subject" // title didn't match "CODE | Mon DD | H:MMPM"
  | "unknown_code" // code not in VEO_FIELD_CODES
  | "unconfirmed_code" // code mapped but not yet confirmed for go-live
  | "no_match" // parsed fine, zero scheduled matches in window
  | "multiple_matches" // more than one candidate — never auto-pick
  | "field_mismatch" // one match, but its field disagrees with the title code
  | "ambiguous_time" // bare time (no am/pm) matched a real game under BOTH meridiems
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

export type TimeOption = { minutes: number; label: string };

export type VeoTitle = {
  code: string;
  month: number; // 1-12
  day: number; // 1-31
  // Candidate start times. One option when the meridiem is explicit (or the
  // time is unambiguous 24-hour); TWO (PM first, then AM) when the title gives
  // a bare 12-hour time — the correct one is resolved against the schedule.
  timeOptions: TimeOption[];
  ampmKnown: boolean;
};

export type ParseResult =
  | { ok: true; value: VeoTitle }
  | { ok: false; reason: Extract<VeoQueueReason, "unparseable_subject"> };

function fail(): ParseResult {
  return { ok: false, reason: "unparseable_subject" };
}

function fmt12(h24: number, minute: number): string {
  const ampm = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(minute).padStart(2, "0")} ${ampm}`;
}

// Month name/abbrev + day, anywhere: "Jul 24", "July 24", "July,21", "Sept 3".
const DATE_RX =
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[.,\s]+(\d{1,2})\b/i;
// Time WITH meridiem: "8PM", "8:00PM", "9:15 pm", "9 p.m.".
const TIME_AMPM_RX = /\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?/i;
// Bare "H:MM" (meridiem to be resolved against the schedule).
const TIME_HM_RX = /(?<!\d)(\d{1,2}):(\d{2})(?!\d)/;

// Delimiter-AGNOSTIC, pattern-based parse. We do NOT split on "|": the date is
// found by pattern (month + day) anywhere in the title, the time by pattern
// (H:MM / H:MMam-pm / H am-pm) anywhere, and the FIELD CODE is the leftover
// leading text (trimmed, internal whitespace collapsed) — matched against the
// known code list by the caller. So "ATH P | Jul 24 | 9:15", "ATH P - Jul 24 -
// 9:15", and "ATH P Jul 24 9:15pm" all parse identically. If there's no
// recognizable date, or no recognizable time, the subject is queued — we never
// fuzzy-guess field/time from free-form titles.
export function parseVeoSubject(subject: string | null | undefined): ParseResult {
  if (!subject) return fail();
  // Strip the trailing "... is ready to watch!" (and anything after).
  const title = subject.replace(/\s+is ready to watch.*$/i, "").trim();

  // --- DATE (required) ---
  const dm = DATE_RX.exec(title);
  if (!dm) return fail();
  const month = MONTHS[dm[1].slice(0, 3).toLowerCase()];
  const day = Number(dm[2]);
  if (!month || day < 1 || day > 31) return fail();
  const dateIdx = dm.index;

  // --- TIME (required) — meridiem form first, then bare H:MM ---
  let hour: number;
  let minute: number;
  let meridiem: "a" | "p" | null;
  let timeIdx: number;
  const ampmMatch = TIME_AMPM_RX.exec(title);
  if (ampmMatch) {
    hour = Number(ampmMatch[1]);
    minute = ampmMatch[2] ? Number(ampmMatch[2]) : 0;
    meridiem = ampmMatch[3].toLowerCase() as "a" | "p";
    timeIdx = ampmMatch.index;
  } else {
    const hmMatch = TIME_HM_RX.exec(title);
    if (!hmMatch) return fail();
    hour = Number(hmMatch[1]);
    minute = Number(hmMatch[2]);
    meridiem = null;
    timeIdx = hmMatch.index;
  }
  if (minute > 59) return fail();

  let timeOptions: TimeOption[];
  let ampmKnown: boolean;
  if (meridiem) {
    if (hour < 1 || hour > 12) return fail();
    let h24 = hour % 12;
    if (meridiem === "p") h24 += 12;
    timeOptions = [{ minutes: h24 * 60 + minute, label: fmt12(h24, minute) }];
    ampmKnown = true;
  } else if (hour === 0 || (hour >= 13 && hour <= 23)) {
    // Unambiguous 24-hour time (00:MM or 13:00–23:59).
    timeOptions = [{ minutes: hour * 60 + minute, label: fmt12(hour, minute) }];
    ampmKnown = true;
  } else if (hour >= 1 && hour <= 12) {
    // Ambiguous bare 12-hour time — PM first, then AM. The schedule decides.
    const amH = hour % 12; // 12 → 0
    const pmH = (hour % 12) + 12; // 12 → 12
    timeOptions = [
      { minutes: pmH * 60 + minute, label: fmt12(pmH, minute) },
      { minutes: amH * 60 + minute, label: fmt12(amH, minute) },
    ];
    ampmKnown = false;
  } else {
    return fail();
  }

  // --- CODE = leftover leading text (before the date/time), normalized ---
  const code = title
    .slice(0, Math.min(dateIdx, timeIdx))
    .replace(/[\s|,\-–—:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();

  return { ok: true, value: { code, month, day, timeOptions, ampmKnown } };
}

// ---------------------------------------------------------------------------
// Match date resolution (year comes from the processing date)
// ---------------------------------------------------------------------------

function isoFromParts(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// The title has no year; the processing date (from the URL slug) supplies it.
// The processing date is ALWAYS >= the match date (Veo processes after the
// match), so the match year is the slug year or the slug year − 1 — and
// trying both is complete (no year+1 needed).
//
// Returns the candidate match dates to try, in priority order:
//   - If the slug-year date falls AFTER the processing date, the slug year is
//     impossible (the match can't be in the future) — the match was late last
//     year (Dec 31 processed Jan 1). Return ONLY the prior-year date.
//   - Otherwise the slug year is the match year; return [slugYear, slugYear−1],
//     the prior year kept as a fallback the caller uses only if the slug year
//     yields no candidate match. This closes the year boundary empirically
//     even under residual date skew.
export function resolveMatchDates(
  title: Pick<VeoTitle, "month" | "day">,
  processing: YMD | null,
): string[] {
  if (!processing) {
    // No year context at all. Refuse rather than guess — the caller queues it
    // (better a review item than a wrong-year match).
    return [];
  }
  const slugYear = processing.year;
  const candUtc = Date.UTC(slugYear, title.month - 1, title.day);
  const procUtc = Date.UTC(processing.year, processing.month - 1, processing.day);
  if (candUtc > procUtc) {
    return [isoFromParts(slugYear - 1, title.month, title.day)];
  }
  return [
    isoFromParts(slugYear, title.month, title.day),
    isoFromParts(slugYear - 1, title.month, title.day),
  ];
}

// The single most-likely match date (the first candidate), or null when there
// is no processing date. Kept for callers that only need the primary date.
export function resolveMatchDate(
  title: Pick<VeoTitle, "month" | "day">,
  processing: YMD | null,
): string | null {
  return resolveMatchDates(title, processing)[0] ?? null;
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
  field_id: number | null; // for the field-agreement cross-check
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
      timeMinutes: title.timeOptions[0].minutes,
      timeLabel: title.timeOptions[0].label,
      candidateApiIds: [],
    };
  }

  const dates = resolveMatchDates(title, processingDateFromSlug(slug));
  if (dates.length === 0) {
    return {
      action: "queue",
      reason: "no_match",
      code: title.code,
      finVenueId: venue.finVenueId,
      matchDate: null,
      timeMinutes: title.timeOptions[0].minutes,
      timeLabel: title.timeOptions[0].label,
      candidateApiIds: [],
    };
  }

  const fieldAgrees = (h: VeoCandidateRow) =>
    h.field_id != null && venue.fieldIds.includes(h.field_id);

  type Outcome =
    | { kind: "post"; matchDate: string; time: TimeOption; apiId: number }
    | { kind: "queue"; reason: VeoQueueReason; matchDate: string; time: TimeOption; candidateApiIds: number[] };

  // Evaluate one candidate date across the title's time option(s). Returns null
  // when the date has NO in-window hits for ANY time option (→ caller tries the
  // next candidate year — the Dec→Jan boundary fallback).
  const evalDate = (date: string): Outcome | null => {
    const rows = loadCandidates(venue.finVenueId, date);
    const evals = title.timeOptions.map((t) => {
      const inWindow = selectVeoMatches({ matchDate: date, timeMinutes: t.minutes }, rows);
      return { t, inWindow, agreeing: inWindow.filter(fieldAgrees) };
    });
    if (evals.every((e) => e.inWindow.length === 0)) return null;

    // Pick the effective time option. When am/pm is explicit there's one; when
    // it's a bare time we resolve the meridiem against the schedule: exactly
    // one interpretation must land on a real field-agreeing game.
    let chosen: (typeof evals)[number];
    if (title.ampmKnown) {
      chosen = evals[0];
    } else {
      const viable = evals.filter((e) => e.agreeing.length >= 1);
      if (viable.length >= 2) {
        // Both meridiems match a real game — cannot disambiguate → queue.
        return {
          kind: "queue",
          reason: "ambiguous_time",
          matchDate: date,
          time: viable[0].t,
          candidateApiIds: viable.flatMap((e) => e.agreeing.map((h) => h.api_id)),
        };
      }
      // Exactly one viable meridiem → use it. If none is field-agreeing, fall
      // back to whichever has in-window hits so we still surface
      // field_mismatch / multiple_matches instead of a silent miss.
      chosen = viable[0] ?? evals.find((e) => e.inWindow.length > 0)!;
    }

    const { inWindow, agreeing, t } = chosen;
    if (inWindow.length === 1) {
      if (agreeing.length === 1) {
        return { kind: "post", matchDate: date, time: t, apiId: agreeing[0].api_id };
      }
      // Field-agreement cross-check: single match on a DIFFERENT field of the
      // same venue than the code names → never post, queue for review.
      return { kind: "queue", reason: "field_mismatch", matchDate: date, time: t, candidateApiIds: [inWindow[0].api_id] };
    }
    return { kind: "queue", reason: "multiple_matches", matchDate: date, time: t, candidateApiIds: inWindow.map((h) => h.api_id) };
  };

  let outcome: Outcome | null = null;
  for (const date of dates) {
    outcome = evalDate(date);
    if (outcome) break;
  }
  if (!outcome) {
    // No candidate date had any in-window match — report against the primary.
    outcome = { kind: "queue", reason: "no_match", matchDate: dates[0], time: title.timeOptions[0], candidateApiIds: [] };
  }

  const candidateApiIds = outcome.kind === "post" ? [outcome.apiId] : outcome.candidateApiIds;

  // Safety gate: a mapped-but-unconfirmed code queues even on a clean single
  // match, carrying its best-guess (resolved date/time + candidate) so Ryan can
  // one-click assign after review.
  if (!venue.confirmed) {
    return {
      action: "queue",
      reason: "unconfirmed_code",
      code: title.code,
      finVenueId: venue.finVenueId,
      matchDate: outcome.matchDate,
      timeMinutes: outcome.time.minutes,
      timeLabel: outcome.time.label,
      candidateApiIds,
    };
  }

  if (outcome.kind === "post") {
    return {
      action: "post",
      code: title.code,
      finVenueId: venue.finVenueId,
      matchDate: outcome.matchDate,
      timeMinutes: outcome.time.minutes,
      timeLabel: outcome.time.label,
      apiId: outcome.apiId,
    };
  }
  return {
    action: "queue",
    reason: outcome.reason,
    code: title.code,
    finVenueId: venue.finVenueId,
    matchDate: outcome.matchDate,
    timeMinutes: outcome.time.minutes,
    timeLabel: outcome.time.label,
    candidateApiIds,
  };
}
