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
  city: string;
  // Safety gate. Only `confirmed: true` codes auto-post; everything else is
  // routed to the review queue with reason "unconfirmed_code" so an unverified
  // mapping can never post to a real player chat before it's confirmed.
  confirmed: boolean;
};

// Normalize a code the SAME way everywhere — trim, collapse internal
// whitespace, uppercase — so "ath p", "ATH  P", and "ATH P" are one key. Codes
// are STORED normalized in veo_codes, so lookups and the UNIQUE constraint agree.
export function normalizeVeoCode(code: string | null | undefined): string {
  return (code ?? "").trim().replace(/\s+/g, " ").toUpperCase();
}

/* RUNTIME SOURCE OF TRUTH IS THE veo_codes TABLE (loaded + cached in veoCodes.ts). This constant
 * is A MIRROR OF THE SEED AND THE IN-MEMORY FALLBACK when that read fails — it is NOT a second
 * source of truth, and nothing should read it in preference to the table.
 *
 * RE-SYNCED 2026-09-04, AND IT HAD DRIFTED BADLY. Seven of the twelve live codes were missing
 * entirely — ATHK, ATHP, HC, NEMP, OC, SCI, WL — while five keys here (ATH P, ATH K, WESTLAKE,
 * ONION CREEK, HILL COUNTRY) no longer exist in the table at all. A failed read therefore turned
 * seven of twelve codes into unknown_code and queued a whole evening silently, which is the worst
 * shape a fallback can have: it looks like it is working.
 *
 * SC IS LEFT ALONE AND THE DISAGREEMENT IS RECORDED RATHER THAN RESOLVED. This constant carries
 * 102 and 199; the live table carries 102, 199 AND 1354. The note below says 1123 (World Cup) and
 * 1354 (Premier) are excluded ON PURPOSE, so the table is not ahead of a stale constant here —
 * something later overrode a deliberate exclusion, and which of the two is right is a question
 * about whether Premier games should be filmed, not a sync gap. Adopting the table's list silently
 * would erase the only surviving record that the exclusion was intentional. UNRESOLVED, flagged.
 *
 * Field notes kept from before: SC covers mdapi fields 102 AND 199 — regular "SC Field 3/4/4A"
 * matches land on both (199 is a legacy "Tourney" field_title carrying regular games). 1123 (World
 * Cup) / 1354 (Premier) are excluded on purpose. Austin Westlake / Onion Creek / Hill Country share
 * one camera (VC3-79705), so the title CODE is the only field signal and each keeps its own code. */
export const VEO_FIELD_CODES: Record<string, VeoFieldCode> = {
  SC: { finVenueId: 11, fieldIds: [102, 199], fieldLabel: "Soccer Central (SC Field 3/4/4A)", city: "San Antonio", confirmed: true },
  ATHP: { finVenueId: 8, fieldIds: [32], fieldLabel: "ATH Pearland", city: "Houston", confirmed: true },
  ATHK: { finVenueId: 7, fieldIds: [892], fieldLabel: "ATH Katy", city: "Houston", confirmed: true },
  PRUMC: { finVenueId: 16, fieldIds: [958], fieldLabel: "PRUMC", city: "Atlanta", confirmed: true },
  WL: { finVenueId: 49, fieldIds: [1], fieldLabel: "Westlake HS", city: "Austin", confirmed: true },
  OC: { finVenueId: 5, fieldIds: [27], fieldLabel: "Onion Creek", city: "Austin", confirmed: true },
  HC: { finVenueId: 56, fieldIds: [1453], fieldLabel: "Hill Country MS", city: "Austin", confirmed: true },
  NEMP: { finVenueId: 0, fieldIds: [17, 10], fieldLabel: "NEMP", city: "Austin", confirmed: true },
  SCI: { finVenueId: 0, fieldIds: [1090], fieldLabel: "Scissortail Park", city: "OKC", confirmed: true },
  LF: { finVenueId: 18, fieldIds: [664], fieldLabel: "Lou Fusz Outdoor (Field 5/10)", city: "St. Louis", confirmed: true },
  /* QUEUE-ONLY BY SETTING, NOT BY PARSE. LFI resolves perfectly and still queues, because
   * `confirmed: false` is an operational choice about going live, not a failure to understand
   * the title. */
  LFI: { finVenueId: 19, fieldIds: [364], fieldLabel: "Lou Fusz Indoor (Training Center)", city: "St. Louis", confirmed: false },
  CC: { finVenueId: 20, fieldIds: [760], fieldLabel: "Centennial Commons", city: "St. Louis", confirmed: true },
};

// Resolve a title code against a code map (defaults to the fallback constant;
// the routes pass the DB-loaded map). EXACT ONLY — unchanged, and still what any caller wanting
// certainty should use. The scored resolver below is the one the matcher uses.
export function resolveVeoCode(
  code: string | null | undefined,
  codes: Record<string, VeoFieldCode> = VEO_FIELD_CODES,
): VeoFieldCode | null {
  const key = normalizeVeoCode(code);
  return key ? (codes[key] ?? null) : null;
}

/* ── RESOLVING A CODE BY DEGREES ───────────────────────────────────────────────────────────────
 * `codes[key] ?? null` turned "ATH K", "PRMUC" and "Onion Creek" into unknown_code even though
 * each names exactly one venue and nothing else. This returns a SCORE instead of a hit or a miss,
 * so a near-certain read can post and a genuinely ambiguous one can queue.
 *
 * EVERY FUZZY TIER MUST BE UNIQUE OR IT DOES NOT COUNT. Two codes at distance 1 is not a near
 * miss, it is a coin flip, and a coin flip puts a stranger's film in a stranger's chat. */
export type CodeTier = "exact" | "squashed" | "prefix" | "typo" | "label" | "none";
export const CODE_SCORE: Record<CodeTier, number> = {
  exact: 40, squashed: 36, prefix: 30, typo: 24, label: 18, none: 0,
};

/** Punctuation and spaces removed: "ATH K" and "A.T.H.K" both become "ATHK". */
const squash = (x: string) => x.replace(/[^A-Z0-9]/gi, "").toUpperCase();

/* DAMERAU, NOT PLAIN LEVENSHTEIN. Plain edit distance charges TWO for a transposition, so PRMUC
 * sits at distance 2 from PRUMC and a `<= 1` filter throws away the commonest typing mistake
 * there is. The transposition clause is the four lines marked below. */
export function damerau(a: string, b: string): number {
  const m = a.length, n = b.length;
  const d: number[][] = Array.from({ length: m + 1 }, (_, i) => Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      // THE TRANSPOSITION CLAUSE — this is what makes PRMUC → PRUMC a distance of one.
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + cost);
      }
    }
  }
  return d[m][n];
}

export type ScoredCode = { key: string; field: VeoFieldCode; tier: CodeTier; score: number } | { key: null; field: null; tier: "none"; score: 0 };

export function resolveVeoCodeScored(
  code: string | null | undefined,
  codes: Record<string, VeoFieldCode> = VEO_FIELD_CODES,
): ScoredCode {
  const miss: ScoredCode = { key: null, field: null, tier: "none", score: 0 };
  const key = normalizeVeoCode(code);
  if (!key) return miss;
  const keys = Object.keys(codes);
  const hit = (k: string, tier: CodeTier): ScoredCode => ({ key: k, field: codes[k], tier, score: CODE_SCORE[tier] });

  if (codes[key]) return hit(key, "exact");

  const sq = squash(key);
  const squashed = keys.filter((k) => squash(k) === sq);
  if (squashed.length === 1) return hit(squashed[0], "squashed");

  // A UNIQUE PREFIX EITHER WAY — "ATH" names ATHK and ATHP, so it is not unique and queues.
  const prefix = keys.filter((k) => squash(k).startsWith(sq) || sq.startsWith(squash(k)));
  if (prefix.length === 1) return hit(prefix[0], "prefix");

  const dist = keys.map((k) => ({ k, d: damerau(sq, squash(k)) })).filter((x) => x.d === 1);
  if (dist.length === 1) return hit(dist[0].k, "typo");

  /* THE FIELD LABEL. "Onion Creek" is what a person types when they do not know the code is OC.
   * Whole-string containment only — a single shared word would match half the board. */
  const lower = key.toLowerCase();
  const label = keys.filter((k) => (codes[k].fieldLabel ?? "").toLowerCase().includes(lower));
  if (label.length === 1) return hit(label[0], "label");

  return miss;
}

// ---------------------------------------------------------------------------
// veo_codes create/update validation (pure; field-existence is checked in the
// route against fin_venue_fields)
// ---------------------------------------------------------------------------

export type VeoCodeInput = {
  code?: unknown;
  finVenueId?: unknown;
  fieldIds?: unknown;
  fieldLabel?: unknown;
  city?: unknown;
  confirmed?: unknown;
};

export type VeoCodeValue = {
  code: string;
  fin_venue_id: number;
  field_ids: number[];
  field_label: string;
  city: string;
  confirmed: boolean;
};

export function validateVeoCodeInput(
  input: VeoCodeInput,
): { ok: true; value: VeoCodeValue } | { ok: false; error: string } {
  const code = normalizeVeoCode(typeof input.code === "string" ? input.code : "");
  if (!code) return { ok: false, error: "Code is required." };
  if (code.length > 40) return { ok: false, error: "Code is too long (max 40)." };

  const finVenueId = Number(input.finVenueId);
  if (!Number.isInteger(finVenueId) || finVenueId <= 0) {
    return { ok: false, error: "A venue is required." };
  }

  const rawIds = Array.isArray(input.fieldIds) ? input.fieldIds : [];
  const fieldIds = Array.from(new Set(rawIds.map((n) => Number(n))));
  if (fieldIds.length === 0) return { ok: false, error: "Select at least one field." };
  if (fieldIds.some((n) => !Number.isInteger(n) || n <= 0)) {
    return { ok: false, error: "Field ids must be positive integers." };
  }

  const fieldLabel = (typeof input.fieldLabel === "string" ? input.fieldLabel : "").trim();
  if (!fieldLabel) return { ok: false, error: "A field label is required." };

  const city = (typeof input.city === "string" ? input.city : "").trim();
  if (!city) return { ok: false, error: "A city is required." };

  return {
    ok: true,
    value: {
      code,
      fin_venue_id: finVenueId,
      field_ids: fieldIds,
      field_label: fieldLabel,
      city,
      confirmed: input.confirmed === true,
    },
  };
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
  | "low_confidence" // read too loosely to post: the four-part score came in under 45
  | "codes_unavailable" // veo_codes read failed; identified off the in-code fallback, never posted
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
  /** Which shape the date arrived in — it feeds the confidence score, not the calendar. */
  dateForm?: DateForm;
  /** Only an ISO or a three-part numeric date carries one; otherwise the processing date decides. */
  dateYear?: number;
  timeForm?: TimeForm;
};

export type TimeForm = "ampm" | "hm" | "bare-hour";
/** An explicit meridiem is certain; a bare H:MM is resolved by the schedule; a lone hour is a guess. */
export const TIME_SCORE: Record<TimeForm, number> = { ampm: 20, hm: 16, "bare-hour": 8 };

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

/* ── THE DATE, IN FOUR SHAPES, TRIED LEAST-AMBIGUOUS FIRST ────────────────────────────────────
 * Only the month-name form existed, so 7/24, 07-24, 2026-07-24, 24 Jul and Jul24 all returned
 * unparseable_subject — five of the twenty real title shapes on the board.
 *
 * THE ORDER IS THE POINT: an ISO date cannot mean anything else, a month NAME cannot be misread,
 * and a bare numeric pair can. They are tried in that order and the numeric form SCORES LOWER,
 * which is the mechanism for saying "7/8 could be either". */
const MON = "jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec";
const DATE_ISO_RX = /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/;
// The ONLY change to the original: [.,\s]* rather than +, which is what admits "Jul24".
const DATE_RX = new RegExp(`\\b(${MON})[a-z]*[.,\\s]*(\\d{1,2})\\b`, "i");
const DATE_DMON_RX = new RegExp(`\\b(\\d{1,2})\\s*(${MON})`, "i");
const DATE_NUM_RX = /(?<!\d)(\d{1,2})[/\-.](\d{1,2})(?:[/\-.](\d{2,4}))?(?!\d)/;
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
/** DATE_FORM scores. A month name cannot be misread; a bare numeric pair can. */
/* A MISSPELLED MONTH IS STILL UNAMBIGUOUS ABOUT WHICH MONTH — "agust" can only be August — so it
 * scores above a bare numeric pair, which genuinely could be either way round. */
export const DATE_SCORE: Record<DateForm, number> = { iso: 30, month: 30, dmon: 30, "month-typo": 24, numeric: 22 };
export type DateForm = "iso" | "month" | "dmon" | "month-typo" | "numeric";

/* THE TIME, AND THE SHAPE IT ARRIVED IN. The shape is returned here rather than re-derived at
 * scoring time: a score that recomputes what the parser already decided is a second reading of the
 * same string, and the two can disagree.
 *
 * A BARE TRAILING HOUR ("SC | Jul 24 | 8") is assumed PM and scored low. Every camera match on the
 * board is an evening game, and an 8 that really meant 8am is still caught downstream — the
 * schedule lookup finds nothing at 08:00. It is read only AFTER the date, so the day number in
 * "Jul 24" can never be mistaken for the hour. */
function findTime(title: string, dateIdx: number): { hour: number; minute: number; meridiem: "a" | "p" | null; index: number; form: TimeForm } | null {
  const ampm = TIME_AMPM_RX.exec(title);
  if (ampm) {
    return { hour: Number(ampm[1]), minute: ampm[2] ? Number(ampm[2]) : 0,
      meridiem: ampm[3].toLowerCase() as "a" | "p", index: ampm.index, form: "ampm" };
  }
  const hm = TIME_HM_RX.exec(title);
  if (hm) return { hour: Number(hm[1]), minute: Number(hm[2]), meridiem: null, index: hm.index, form: "hm" };

  // A LONE NUMBER AFTER THE DATE. Searched only past the date's own text, so the 24 in "Jul 24"
  // cannot be read as an hour.
  const after = title.slice(dateIdx);
  const bare = /(?<![\d:])(\d{1,2})(?![\d:])/g;
  let m: RegExpExecArray | null;
  const seen: { v: number; i: number }[] = [];
  while ((m = bare.exec(after)) !== null) seen.push({ v: Number(m[1]), i: dateIdx + m.index });
  // The first is the date's own day number; anything after it is a candidate hour.
  const cand = seen.slice(1).find((x) => x.v >= 1 && x.v <= 12);
  if (cand) return { hour: cand.v, minute: 0, meridiem: "p", index: cand.i, form: "bare-hour" };
  return null;
}

/* ── THE MONTH, MISSPELLED ────────────────────────────────────────────────────────────────────
 * Ryan's ask was that it should work "if we're close". On the real corpus the thing that is close
 * is almost never the code — it is the month: agust, agost, jully, febuary. A month word within
 * one edit of a real month can only be that month, so it is accepted and scored below an exact
 * one. UNIQUENESS IS REQUIRED, same rule as the code tiers: "jun"/"jul" are one edit apart and a
 * word equidistant from both is not a near miss, it is a coin flip.
 *
 * ONLY FULL MONTH NAMES, AND ONLY WORDS OF FOUR LETTERS OR MORE. One edit inside a three-letter
 * abbreviation is a third of the word, and "JXl" is not a typo for July — it is noise that happens
 * to sit one substitution from "jul". The existing suite pins that case as unparseable and it
 * stays unparseable. "agust" is one deletion from the six letters of "august", which is a typo. */
const MONTH_WORDS: [string, number][] = [
  ["january", 1], ["february", 2], ["march", 3], ["april", 4], ["may", 5], ["june", 6],
  ["july", 7], ["august", 8], ["september", 9], ["october", 10], ["november", 11], ["december", 12],
];

function readTypoMonth(title: string): { month: number; day: number; index: number; form: DateForm } | null {
  const words = /[a-z]{4,12}/gi;
  let w: RegExpExecArray | null;
  while ((w = words.exec(title)) !== null) {
    const word = w[0].toLowerCase();
    // "is ready to watch" is stripped upstream, but a venue word must never be read as a month.
    let best: { month: number; d: number } | null = null;
    let tied = false;
    for (const [name, month] of MONTH_WORDS) {
      const d = damerau(word, name);
      if (!best || d < best.d) { best = { month, d }; tied = false; }
      else if (d === best.d && month !== best.month) tied = true;
    }
    if (!best || best.d !== 1 || tied) continue;
    // The day is the first 1-2 digit number after the word that is NOT glued to a meridiem
    // (that one is the kick-off hour), searched only within the tail of the title.
    const tail = title.slice(w.index + word.length);
    const nums = /(?<!\d)(\d{1,2})(?!\d)/g;
    let n: RegExpExecArray | null;
    while ((n = nums.exec(tail)) !== null) {
      if (/^\s*(?:am|pm|a\.m|p\.m|:)/i.test(tail.slice(n.index + n[0].length))) continue;
      const day = Number(n[1]);
      if (day >= 1 && day <= 31) return { month: best.month, day, index: w.index, form: "month-typo" };
    }
    // "24 agust" — the day may sit before the word instead.
    const head = /(\d{1,2})\s*$/.exec(title.slice(0, w.index));
    if (head) {
      const day = Number(head[1]);
      if (day >= 1 && day <= 31) return { month: best.month, day, index: w.index, form: "month-typo" };
    }
  }
  return null;
}

function readDate(title: string): { month: number; day: number; index: number; year?: number; form: DateForm } | null {
  const iso = DATE_ISO_RX.exec(title);
  if (iso) return { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]), index: iso.index, form: "iso" };
  const mn = DATE_RX.exec(title);
  if (mn) {
    const month = MONTHS[mn[1].slice(0, 3).toLowerCase()];
    if (month) return { month, day: Number(mn[2]), index: mn.index, form: "month" };
  }
  const dm2 = DATE_DMON_RX.exec(title);
  if (dm2) {
    const month = MONTHS[dm2[2].slice(0, 3).toLowerCase()];
    if (month) return { month, day: Number(dm2[1]), index: dm2.index, form: "dmon" };
  }
  /* A MISSPELLED MONTH, BEFORE ANY NUMERIC READING. This ordering is not cosmetic — it is the fix
   * for three real recordings that auto-posted to the WRONG DAY.
   *
   *   "Sc-agust-4-10pm"  → posted into a match on 10 APRIL 2026 (api 13449)
   *   "SC-agust14-7pm"   → posted into a match on 14 JULY   2026 (api 16411)
   *   "SC-agust28-7pm"   → posted into a match on 28 JULY   2026 (api 17040)
   *
   * "agust" is not a month the exact reader knows, so the numeric reader got the string next and
   * found a pair — except the pair it found was the DAY and the HOUR ("4-10pm" → 4/10 → April 10).
   * Every one of them then passed the schedule check, the field check and the single-match check,
   * because a real SC game existed at that time on the wrong day. Nothing downstream could have
   * caught it: by then the date was simply a date.
   *
   * So the month word is read fuzzily first, and the numeric reader is taught to refuse a pair
   * whose second half is the kick-off time. */
  const mt = readTypoMonth(title);
  if (mt) return mt;

  const nu = DATE_NUM_RX.exec(title);
  if (nu) {
    /* AND THE SECOND HALF OF A NUMERIC PAIR IS NOT A DATE IF IT IS THE TIME. "4-10pm" is four
     * o'clock nothing and ten PM, not the tenth of April. */
    if (/^\s*(?:am|pm|a\.m|p\.m)/i.test(title.slice(nu.index + nu[0].length))) return null;
    let a = Number(nu[1]), b = Number(nu[2]);
    /* MONTH-FIRST, BECAUSE THE OPERATORS ARE AMERICAN. It flips ONLY when the first number cannot
     * be a month and the second can — 13/7 is unambiguously 13 July. 7/8 does not flip, and its
     * lower score is how the parser says it could not tell. */
    if (a > 12 && b <= 12) { const t = a; a = b; b = t; }
    const year = nu[3] ? (nu[3].length === 2 ? 2000 + Number(nu[3]) : Number(nu[3])) : undefined;
    if (a >= 1 && a <= 12) return { month: a, day: b, index: nu.index, year, form: "numeric" };
  }
  return null;
}

export function parseVeoSubject(subject: string | null | undefined): ParseResult {
  if (!subject) return fail();
  // Strip the trailing "... is ready to watch!" (and anything after).
  const title = subject.replace(/\s+is ready to watch.*$/i, "").trim();

  // --- DATE (required) — four shapes, least ambiguous first ---
  const d = readDate(title);
  if (!d) return fail();
  const { month, day, index: dateIdx, year: dateYear, form: dateForm } = d;

  // --- TIME (required) — one reader, which reports the SHAPE it found ---
  const t = findTime(title, dateIdx);
  if (!t) return fail();
  const { hour, minute, meridiem, index: timeIdx, form: timeForm } = t;
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

  return { ok: true, value: { code, month, day, timeOptions, ampmKnown, dateForm, dateYear, timeForm } };
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
  title: Pick<VeoTitle, "month" | "day" | "dateYear">,
  processing: YMD | null,
): string[] {
  // A TITLE THAT STATES ITS YEAR IS BELIEVED. ISO and three-part numeric dates
  // carry one; the slug-year inference below exists only for the shapes that do
  // not, and running it over a stated year would be inventing an ambiguity the
  // title does not have.
  if (title.dateYear) return [isoFromParts(title.dateYear, title.month, title.day)];
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
  title: Pick<VeoTitle, "month" | "day" | "dateYear">,
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

/* ── THE SCORE, AND WHY IT IS FOUR NUMBERS AND NOT ONE ─────────────────────────────────────────
 * "Post only on an exact title" is one bit of confidence, and it threw away every recording whose
 * subject had a space in the code or a slash in the date. This scores the four things the parser
 * actually learned, each on its own axis, so a title can be WRONG in one place and still post:
 *
 *   code  40   which venue the title names          — the only axis that can put film in a
 *                                                     stranger's chat, so it is worth the most
 *   date  30   which day                            — a numeric date scores 22, not 30, because
 *                                                     7/8 could be either way round
 *   time  20   which kick-off                       — an explicit meridiem is certain, a lone
 *                                                     trailing hour is a guess
 *   field 10   the match's field is one the code names
 *
 * The FIELD point is small on purpose. It is a cross-check, not evidence: it only ever confirms
 * a match the other three already chose, and it is the axis a venue re-numbering breaks.
 *
 * THE BANDS, AND WHY CLEAN IS 100 AND NOT 70.
 *
 *   100    post, clean          — nothing was guessed: exact code, a date that cannot be read two
 *                                 ways, an explicit am/pm, and a field the code names
 *   45-99  post, FLAGGED        — it posted, and the score says which of the four was a guess
 *   <  45  do not post          — the read was too loose to send
 *
 * 70 WAS THE FIRST CUT AND IT WAS MEASURABLY WRONG. Swept over all 204 real recordings in
 * veo_recordings, a 70 line put every single post in "clean" and left the flagged band EMPTY —
 * because no real Veo subject has ever omitted am/pm, so the time axis is a near-constant 20 and
 * only a title that is vague about BOTH its venue and its date could fall under 70. The flagged
 * behaviour existed in the code and never once in the data.
 *
 * At 100 the same sweep flags six real posts and they are exactly the ones a person would want to
 * see: 'SCISS | Aug 20 | 8pm' (78 — "SCISS" is not a code, it was matched by finding it inside
 * "Scissortail Park") and 'SC-AGUST-26-11PM' (94 — the month is misspelled). Both are almost
 * certainly right. Neither was read with certainty, and that is the distinction the flag is for.
 *
 * The 45 line is untouched, so this moved no recording between posting and queueing — it only
 * changed which posts carry the flag. */
export type ScoreBand = "clean" | "flagged" | "review";
export const BAND_CLEAN = 100;
export const BAND_FLAGGED = 45;
export const FIELD_SCORE = 10;

export type VeoScore = {
  total: number;
  band: ScoreBand;
  code: number;
  codeTier: CodeTier;
  date: number;
  dateForm: DateForm | null;
  time: number;
  timeForm: TimeForm | null;
  field: number;
  fieldAgrees: boolean;
};

export function bandFor(total: number): ScoreBand {
  if (total >= BAND_CLEAN) return "clean";
  if (total >= BAND_FLAGGED) return "flagged";
  return "review";
}

export function scoreVeo(parts: {
  codeTier: CodeTier;
  dateForm: DateForm | null;
  timeForm: TimeForm | null;
  fieldAgrees: boolean;
}): VeoScore {
  const code = CODE_SCORE[parts.codeTier];
  const date = parts.dateForm ? DATE_SCORE[parts.dateForm] : 0;
  const time = parts.timeForm ? TIME_SCORE[parts.timeForm] : 0;
  const field = parts.fieldAgrees ? FIELD_SCORE : 0;
  const total = code + date + time + field;
  /* NO CODE IS NOT A LOW SCORE, IT IS NO SCORE. Measured on 204 real recordings: 19 subjects
   * ("Parmer Aug 12 8pm", "Match Aug 8, 2026/ MD SC 8PM-9PM") name no known venue at all and yet
   * scored 50 on date and time alone — landing them in the post-flagged band, which was the only
   * thing populating it. They queue as unknown_code long before the band is consulted, so nothing
   * was ever at risk; the tally was simply measuring rows that can never post. A title that does
   * not name a venue is a review item whatever else it gets right. */
  const band = parts.codeTier === "none" ? "review" : bandFor(total);
  return { total, band, code, codeTier: parts.codeTier, date,
    dateForm: parts.dateForm, time, timeForm: parts.timeForm, field, fieldAgrees: parts.fieldAgrees };
}

export type VeoDecision =
  | {
      action: "post";
      code: string;
      finVenueId: number;
      matchDate: string;
      timeMinutes: number;
      timeLabel: string;
      apiId: number;
      /** True for the 45-69 band: it posted, and the review page says why it was not certain. */
      flagged: boolean;
      score: VeoScore;
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
      /** Null only when the subject never parsed — there is nothing to score. */
      score: VeoScore | null;
    };

export function classifyVeo(args: {
  subject: string;
  slug: string;
  // Loader the route supplies: given a fin_venues id, return that venue's
  // candidate mdapi rows on the resolved date. Kept as an injected function
  // so this stays pure and testable with fixtures.
  loadCandidates: (finVenueId: number, matchDate: string) => VeoCandidateRow[];
  // Code→field map. Routes pass the DB-loaded map; defaults to the fallback
  // constant so existing tests and any offline path still resolve codes.
  codes?: Record<string, VeoFieldCode>;
  // FALSE when `codes` is the in-code fallback because the veo_codes read failed.
  // The fallback IDENTIFIES a code so the review UI can show one. It does not
  // AUTHORIZE a post: the constant is a snapshot that can be months stale, and a
  // DB blip must not turn a stale venue→field map into an automatic message in a
  // player-visible chat. Every would-be post queues as `codes_unavailable`.
  codesAuthoritative?: boolean;
}): VeoDecision {
  const { subject, slug, loadCandidates, codes = VEO_FIELD_CODES, codesAuthoritative = true } = args;

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
      score: null,
    };
  }
  const title = parsed.value;
  // The three parts the TITLE decides. The fourth (field) is only known once a
  // match is selected, so the score is finished at the bottom.
  const titleScore = (fieldAgrees: boolean, tier: CodeTier) =>
    scoreVeo({ codeTier: tier, dateForm: title.dateForm ?? null, timeForm: title.timeForm ?? null, fieldAgrees });

  const resolved = resolveVeoCodeScored(title.code, codes);
  const venue = resolved.field;
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
      score: titleScore(false, "none"),
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
      score: titleScore(false, resolved.tier),
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
  const score = titleScore(outcome.kind === "post", resolved.tier);

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
      score,
    };
  }

  // The codes map is a snapshot from a failed read: identify, do not post.
  if (!codesAuthoritative) {
    return {
      action: "queue",
      reason: "codes_unavailable",
      code: title.code,
      finVenueId: venue.finVenueId,
      matchDate: outcome.matchDate,
      timeMinutes: outcome.time.minutes,
      timeLabel: outcome.time.label,
      candidateApiIds,
      score,
    };
  }

  if (outcome.kind === "post") {
    /* THE BAND DECIDES WHETHER A CLEAN MATCH IS GOOD ENOUGH TO SEND. Everything above this line
     * has already agreed on ONE match at the right venue, on the right day, at the right time,
     * on a field the code names. The score asks a different question: how much of that agreement
     * came from reading the title confidently, and how much from guessing. A guessed venue that
     * happens to have exactly one game in the window is exactly the failure this catches. */
    if (score.band === "review") {
      return {
        action: "queue",
        reason: "low_confidence",
        code: title.code,
        finVenueId: venue.finVenueId,
        matchDate: outcome.matchDate,
        timeMinutes: outcome.time.minutes,
        timeLabel: outcome.time.label,
        candidateApiIds,
        score,
      };
    }
    return {
      action: "post",
      code: title.code,
      finVenueId: venue.finVenueId,
      matchDate: outcome.matchDate,
      timeMinutes: outcome.time.minutes,
      timeLabel: outcome.time.label,
      apiId: outcome.apiId,
      flagged: score.band === "flagged",
      score,
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
    score,
  };
}

// ---------------------------------------------------------------------------
// Camera-emoji detection over match NAMES (the manual admin marker).
// ---------------------------------------------------------------------------
// The camera indicator is not a DB field — admins type a camera emoji into the
// match name in the MatchDay app. An audit of all 9,394 live matches found exactly
// ONE glyph in use — 🎥 U+1F3A5, in 924 names — but this matches the whole camera
// FAMILY so a future variant (📹/📷/📸/🎬/🎦/📽️/🎞️) can't silently render an empty
// grid. Team-colour circles (🔴/🔵/⚪️) are deliberately NOT cameras. The glyph
// appears at the start or middle of the name, glued to other emoji or to letters
// with inconsistent spacing, so both helpers handle it anywhere and re-normalise.
const CAMERA_EMOJI = /[\u{1F3A5}\u{1F4F9}\u{1F4F7}\u{1F4F8}\u{1F3A6}\u{1F3AC}\u{1F4FD}\u{1F39E}]️?/gu;

/** True if the match name carries any camera-family emoji. */
export function hasCameraEmoji(name: string | null | undefined): boolean {
  if (!name) return false;
  CAMERA_EMOJI.lastIndex = 0;
  return CAMERA_EMOJI.test(name);
}

/** The match name with every camera emoji removed and whitespace re-normalised —
 * the camera chip carries that information now, so no Clubhouse surface should
 * render the raw glyph. Other emoji in the name are left untouched. */
export function stripCameraEmoji(name: string | null | undefined): string {
  if (!name) return "";
  return name.replace(CAMERA_EMOJI, "").replace(/\s{2,}/g, " ").trim();
}
