// Growth-tab analytics engine. Pure, deterministic, server-side. Takes the raw
// rows the /api/growth route reads (paginated, service-role) and produces the
// single compact payload the client dashboard renders.
//
// THREE TIME FLOORS, not one (see AGENTS growth audit):
//   registrations (mdapi_users)      2023-03-24
//   memberships   (mdapi_subscriptions) 2024-02-29
//   play / spots / revenue / cohorts 2026-01-01  — hard floor, zero matches before
// Registrations use their full history; every play-derived series starts 2026-01.
//
// STANDING FILTER everywhere: user_is_fake_player = false AND deleted_at IS NULL.
// A "played" spot = non-fake, live row, on a live non-cancelled match, the player
// did not cancel (canceled_at IS NULL) and did not merely waitlist
// (paid_status != 'WAITING'). Absent-but-booked players are kept — they held a
// spot. These exact filters reproduce the audit's regression targets
// (played≥1 = 7,517, played≥5 = 2,327, and the eight cohort sizes).

import { CITY_CODE_TO_DISPLAY } from "./scheduleReconcile";
import { canonicalVenueName, venueCategory } from "./venueResolver";

// ── City attribution ────────────────────────────────────────────────────────
// DECISION 3: a played player's city is their self-declared preferable_city_name
// (normalised to canonical display names). Fallback for a played player with it
// unset: most-frequent play city, ties broken toward the most recent play. The
// rule lives behind this one constant so it can be switched in a single line.
export type CityAttributionRule = "declared" | "mostFrequentPlay";
export const CITY_ATTRIBUTION_RULE: CityAttributionRule = "declared";

// Canonical city display names — the same strings fin_revenue.city uses, so
// revenue, play and declared data all key on one vocabulary.
export const CANONICAL_CITIES = [
  "Austin",
  "Houston",
  "San Antonio",
  "Dallas",
  "Atlanta",
  "OKC",
  "St. Louis",
  "El Paso",
] as const;

// Revenue / players that carry no mappable city land here, never dropped and
// never spread across cities (DECISION 2).
export const UNKNOWN_CITY = "Unknown city";

// Free-text preferable_city_name → canonical. Anything unmapped (e.g. "New York
// City", where MatchDay has no matches) is kept verbatim so it stays visible.
const DECLARED_TO_CANONICAL: Record<string, string> = {
  Austin: "Austin",
  Houston: "Houston",
  "San Antonio": "San Antonio",
  "Dallas / Fort Worth": "Dallas",
  Dallas: "Dallas",
  Atlanta: "Atlanta",
  "St. Louis": "St. Louis",
  "Oklahoma City": "OKC",
  OKC: "OKC",
  "El Paso": "El Paso",
};

// fin_revenue.city → canonical. "Deleted Account Revenue" and anything else with
// no matching market bucket to Unknown city.
const REVENUE_CITY_TO_CANONICAL: Record<string, string> = {
  Austin: "Austin",
  Houston: "Houston",
  "San Antonio": "San Antonio",
  Dallas: "Dallas",
  Atlanta: "Atlanta",
  OKC: "OKC",
  "St. Louis": "St. Louis",
  "El Paso": "El Paso",
};

export function normalizeDeclared(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = raw.trim();
  if (!t) return null;
  return DECLARED_TO_CANONICAL[t] ?? t;
}
export function normalizeMatchCity(code: string | null | undefined): string {
  if (!code) return UNKNOWN_CITY;
  return CITY_CODE_TO_DISPLAY[code] ?? code;
}
export function normalizeRevenueCity(raw: string | null | undefined): string {
  if (!raw) return UNKNOWN_CITY;
  return REVENUE_CITY_TO_CANONICAL[raw.trim()] ?? UNKNOWN_CITY;
}

// ── month helpers ────────────────────────────────────────────────────────────
// start_date / created_at are stored as local (America/Chicago) wall-clock with
// a +00:00 suffix; taking the leading YYYY-MM is the timezone-safe month key and
// reproduces the audit's Chicago-calendar cohort sizes.
export function monthKey(iso: string): string {
  return iso.slice(0, 7);
}
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// fin_revenue.month is a label like "Jul 2026".
export function revMonthToKey(label: string): string | null {
  const [mm, yy] = label.split(" ");
  const i = MON.indexOf(mm);
  if (i < 0 || !yy) return null;
  return `${yy}-${String(i + 1).padStart(2, "0")}`;
}
export function addMonthsToKey(key: string, n: number): string {
  const [y, m] = key.split("-").map(Number);
  const total = y * 12 + (m - 1) + n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}
export function monthDiff(from: string, to: string): number {
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  return ty * 12 + (tm - 1) - (fy * 12 + (fm - 1));
}
export function monthRange(start: string, end: string): string[] {
  const out: string[] = [];
  for (let k = start; monthDiff(k, end) >= 0; k = addMonthsToKey(k, 1)) out.push(k);
  return out;
}

// ── raw row shapes (only the columns the engine reads) ───────────────────────
export type RawMatch = {
  api_id: number;
  start_date: string | null;
  city_identifier: string | null;
  field_id: number | null;
  field_title: string | null;
  is_cancelled: boolean | null;
  deleted_at: string | null;
};
export type RawPlayer = {
  user_id: number | null;
  match_api_id: number | null;
  paid_status: string | null;
  canceled_at: string | null;
  user_is_fake_player: boolean | null;
  deleted_at: string | null;
  total_amount: number | null;
};
export type RawUser = {
  id: number;
  created_at: string | null;
  completed_sign_up_at: string | null;
  preferable_city_name: string | null;
  is_fake_player: boolean | null;
};
export type RawSubscription = {
  user_id: number | null;
  city_identifier: string | null;
  activation_date: string | null;
  canceled_at: string | null;
  price?: number | null; // monthly membership fee (for the ARPP field-level allocation)
};
export type RawRevenue = {
  month: string | null;
  city: string | null;
  type: string | null;
  net: number | null;
  venue?: string | null; // raw venue string (for ARPP field-level revenue; canonicalised in Node)
};

export type RawAndroidInstall = { period_date: string; count: number };

// Play-ingest health for the App downloads KPI. `state` drives the label; the
// other fields fill in the specifics ("last ran <at>", "failed with <error>",
// "last synced <date>"). Derived from the runtime SA-key presence + the latest
// fin_sync_log 'play-installs' row + the freshest app_downloads date.
export type PlaySyncStatus = {
  state: "not_configured" | "never_run" | "failed" | "no_data" | "synced";
  lastRunAt: string | null; // ISO instant of the latest play-installs run
  error: string | null; // verbatim error_message of the latest run, if it failed
  lastSyncedDate: string | null; // freshest app_downloads period_date (YYYY-MM-DD)
};

// Apple App Store ingest health — same shape/semantics as PlaySyncStatus, derived
// from the runtime APP_STORE_CONNECT_* presence + latest 'app-store-installs'
// fin_sync_log row + freshest ios app_downloads date.
export type AppleSyncStatus = PlaySyncStatus;
export type RawIosInstall = { period_date: string; count: number };

export type RawInput = {
  matches: RawMatch[];
  players: RawPlayer[];
  users: RawUser[];
  subscriptions: RawSubscription[];
  revenue: RawRevenue[];
  // Android daily user-installs from app_downloads (empty until the Play ingest
  // runs; absent entirely if the table doesn't exist yet). iOS is not wired.
  androidDaily?: RawAndroidInstall[];
  // iOS daily App Store units (empty until the Apple ingest runs). Kept separate
  // from android — the two metrics are defined differently and are never summed
  // into one series.
  iosDaily?: RawIosInstall[];
  // Play-ingest health, computed server-side (impure: reads env + fin_sync_log)
  // and passed through to the output unchanged. Optional so pure-fn tests can omit
  // it; absent → treated as not_configured with no run history.
  playSync?: PlaySyncStatus;
  appleSync?: AppleSyncStatus;
  // ISO instant the read ran (server "now"); churn "days inactive" is measured
  // from this. Passed in (never Date.now() inside the pure fn) so the engine
  // stays deterministic and testable.
  now: string;
  // Raw counts straight off the reads, for the verification report.
  rowCounts: GrowthData["rowCounts"];
};

// ── output payload ───────────────────────────────────────────────────────────
export type BehaviorPoint = {
  m: string;
  registrations: number | null; // null = series has no data yet this month (not zero)
  newPlayers: number | null;
  totalPlayers: number | null;
  spots: number | null;
};
export type PlayerRow = {
  u: number;
  city: string; // attributed (rule + fallback) — used by churn
  declaredCity: string | null;
  freqCity: string | null;
  field: string; // most-recent-play field label — used by churn
  first: string; // first-play month key
  firstCity: string; // city of the earliest-dated play (play-location)
  firstField: string; // field of the earliest-dated play
  firstMonthIdx: number; // index into playMonths of first play
  firstCityIdx: number; // index into cityIndex
  firstFieldIdx: number; // index into fieldIndex
  // Distinct (monthIdx, cityIdx, fieldIdx) the player was active, flattened in
  // triples. Lets the client compute range-distinct Total players per entity
  // (Total = distinct players with ≥1 match in the range at that entity).
  ev: number[];
  matches: number;
  last: string; // last-play date (YYYY-MM-DD)
  days: number; // days inactive as of now
};
export type ArppPoint = {
  m: string;
  net: number;
  denom: number;
  playedOnly: number;
  subOnly: number;
  both: number;
  arpp: number;
};
// ── ARPP card (v2) ────────────────────────────────────────────────────────────
// Selected-month (cur/prev/same-month-last-year) and annual (yr/yr-1/yr-2) ARPP
// per entity, with deleted-account revenue excluded from the numerator and a
// null (→ em-dash) wherever an entity had no denominator that period. Field-level
// numerator = fin_revenue by canonical venue + membership fees split across each
// member's played fields; members who played nothing that month are held in the
// city-level unallocated bucket (surfaced in the footnote).
export type ArppTriple = { cur: number | null; prev: number | null; py: number | null };
export type ArppEntity = { name: string; city: string | null; cur: number | null; prev: number | null; py: number | null };
export type ArppCard = {
  curMonth: string;
  prevMonth: string;
  pyMonth: string;
  curYear: number;
  prevYear: number;
  pyYear: number;
  monthly: { matchday: ArppTriple; cities: ArppEntity[]; fields: ArppEntity[] };
  annual: { matchday: ArppTriple; cities: ArppEntity[]; fields: ArppEntity[] };
  // current-month membership allocation (subscription fees), for the Field-View footnote.
  membership: { total: number; allocated: number; unallocated: number; zeroMatchMembers: number };
  // current-month denominators, for the "cannot be averaged back" footnote.
  denom: { network: number; citySum: number };
  // verification diagnostics (last 6 revenue months): deleted revenue removed +
  // matchday ARPP before/after; membership totals; not rendered.
  diag: {
    deleted: { m: string; deletedNet: number; arppWith: number | null; arppWithout: number | null }[];
    membership: { m: string; total: number; allocated: number; unallocated: number; zeroMatchMembers: number }[];
  };
};

export type CohortRow = {
  cohort: string; // "2026-01"
  size: number;
  // retention[o] = players active in calendar month cohort+o (o = 0..maxOffset).
  // observable = whether that calendar month has already occurred (else the
  // client renders "no data yet", never 0%). partial = that calendar month is
  // the current (still-running) month, so the % is understated and will climb —
  // the client marks it distinctly so a low partial value isn't read as churn.
  cells: { offset: number; active: number; pct: number; observable: boolean; partial: boolean }[];
};

export type GrowthData = {
  generatedAt: string;
  rowCounts: {
    matchesTotal: number;
    matchesLive: number;
    playersTotal: number;
    playersLive: number;
    fakeLiveRows: number;
    fakeLivePct: number;
    waitingLiveNonFake: number;
    usersTotal: number;
    usersNonFake: number;
    usersFake: number;
    usersCompletedNonFake: number;
    subscriptions: number;
    finRevenue: number;
  };
  floors: { registrations: string; memberships: string; play: string; revenue: string };
  playMonths: string[]; // sorted play-data month keys, index space for PlayerRow.plays
  kpis: {
    downloads: null; // no source — client renders "store sync not connected"
    registrations: number;
    accountsCreated: number;
    onboardingGap: number;
    played1: number;
    played5: number;
  };
  // App-store installs, per platform and NEVER summed into one series (Apple
  // "App Units" and Google "Daily User Installs" are defined differently). Each
  // platform is null until its ingest lands rows (rendered as a dash, never 0).
  downloads: {
    androidByMonth: { m: string; count: number }[];
    android: { earliest: string; latest: string; total: number } | null;
    iosByMonth: { m: string; count: number }[];
    ios: { earliest: string; latest: string; total: number } | null;
  };
  // Per-platform ingest health, so the KPI can distinguish "never configured"
  // from "ran and failed" from "ran, no data" from "synced <date>" for each store.
  // Computed server-side (env + fin_sync_log) and passed through.
  playSync: PlaySyncStatus;
  appleSync: AppleSyncStatus;
  registrationsByMonth: { m: string; count: number }[]; // completed, non-fake, by signup month, 2023+
  // Nested cohort funnel by signup month (additive across months). downloads is
  // not here — it has no per-person source.
  funnelByMonth: { m: string; registrations: number; played1: number; played3: number; played5: number; played10: number }[];
  // The same cohort funnel split by the city declared at registration. Downloads are absent by
  // definition — the stores report country/region, never city.
  funnelByMonthCity: { m: string; city: string; registrations: number; played1: number; played3: number; played5: number; played10: number }[];
  // Registrations in a month with NO usable declared city. The cities therefore do not sum to
  // funnelByMonth, and this is the difference — stated rather than absorbed.
  funnelUnattributed: { m: string; registrations: number }[];
  players: PlayerRow[]; // one row per played player (7,517); powers funnel, churn, data room
  behaviorOverall: BehaviorPoint[];
  behaviorByCity: Record<string, BehaviorPoint[]>;
  behaviorByField: Record<string, { label: string; city: string; points: BehaviorPoint[] }>;
  // Special-event pitches, ranked by spots — rendered as their own section on
  // the Growth field view, never interleaved with the regular pitch ranking.
  eventFields: { label: string; city: string; spots: number; players: number }[];
  // Index spaces the per-player `ev` triples reference. cityIndex is the full
  // market universe (play + declared-only); cityHasMatches[i] marks whether that
  // market has ever run a match.
  cityIndex: string[];
  cityHasMatches: boolean[];
  fieldIndex: { label: string; city: string }[];
  arppOverall: ArppPoint[];
  arppByCity: Record<string, ArppPoint[]>;
  // ARPP numerator diagnostics: deleted-account revenue (overstates ARPP — its
  // players can't be in the denominator) and unattributed membership revenue.
  arppDiagnostics: {
    byMonth: { m: string; totalNet: number; deletedNet: number; unattributedMembership: number }[];
    deletedTotal: number;
    unattributedMembershipTotal: number;
  };
  // v2 ARPP card (cur/prev/py + annual, deleted-excluded, field-level). Optional
  // because computeGrowth (the validation baseline) does not compute it — only the
  // view path (computeGrowthFromViews) does.
  arppCard?: ArppCard;
  cohorts: CohortRow[];
  retentionCurveOverall: { offset: number; pct: number; observable: boolean }[];
  retentionCurveByCity: Record<string, { offset: number; pct: number; observable: boolean }[]>;
  cities: string[]; // canonical cities that actually appear in play data
  reconciliation: {
    // PART 8: DPP ledger vs per-player booking, per month.
    rows: { m: string; dppNet: number; strictBooking: number; gap: number }[];
    dppTotal: number;
    strictTotal: number;
    gapTotal: number;
    deletedAccountRevenue: number;
  };
  attribution: {
    // DECISION 3: both rules side by side.
    declared: { city: string; count: number }[];
    mostFrequent: { city: string; count: number }[];
    disagreeRaw: number; // both known, differ (pre-normalisation labels)
    disagreeNormalized: number; // both known, differ after canonicalising
    fallbackUsed: number; // played players with no declared city
  };
};

const DAY_MS = 86_400_000;

export function computeGrowth(input: RawInput): GrowthData {
  const { matches, players, users, subscriptions, revenue, now } = input;
  const nowDate = new Date(now);
  const nowMonth = monthKey(now);

  // Live match index.
  const liveMatch = new Map<number, RawMatch>();
  for (const m of matches) {
    if (m.deleted_at) continue;
    liveMatch.set(m.api_id, m);
  }

  // ── users: registrations + declared city ──────────────────────────────────
  const nonFakeUsers = users.filter((u) => !u.is_fake_player);
  const completedUsers = nonFakeUsers.filter((u) => u.completed_sign_up_at);
  const declaredByUser = new Map<number, string | null>();
  const rawDeclaredByUser = new Map<number, string | null>();
  for (const u of nonFakeUsers) {
    declaredByUser.set(u.id, normalizeDeclared(u.preferable_city_name));
    rawDeclaredByUser.set(u.id, u.preferable_city_name?.trim() || null);
  }

  // Registrations are bucketed by completed_sign_up_at — the moment a user
  // actually became a registered player — matching the cohort funnel below.
  const regByMonth = new Map<string, number>();
  for (const u of completedUsers) {
    if (!u.completed_sign_up_at) continue;
    const k = monthKey(u.completed_sign_up_at);
    regByMonth.set(k, (regByMonth.get(k) ?? 0) + 1);
  }

  // ── played spots ──────────────────────────────────────────────────────────
  type Play = { u: number; month: string; date: string; city: string; field: string; isEvent: boolean; amount: number };
  const plays: Play[] = [];
  let fakeLiveRows = 0;
  let waitingLiveNonFake = 0;
  let playersLive = 0;
  for (const p of players) {
    if (p.deleted_at) continue;
    playersLive++;
    if (p.user_is_fake_player) {
      fakeLiveRows++;
      continue;
    }
    if (p.paid_status === "WAITING") {
      waitingLiveNonFake++;
      continue;
    }
    if (p.canceled_at) continue;
    if (p.user_id == null || p.match_api_id == null) continue;
    const m = liveMatch.get(p.match_api_id);
    if (!m || m.is_cancelled || !m.start_date) continue;
    plays.push({
      u: p.user_id,
      month: monthKey(m.start_date),
      date: m.start_date.slice(0, 10),
      city: normalizeMatchCity(m.city_identifier),
      // Canonical field identity (retires the raw field_title matcher). Event
      // matches keep their canonical pitch but are flagged so the field ranking
      // can separate them — a tournament at NEMP is an event, NEMP is not.
      field: canonicalVenueName(m.field_title ?? "") || (m.field_id != null ? `Field ${m.field_id}` : "Unknown field"),
      isEvent: venueCategory(m.field_title) === "event",
      amount: Number(p.total_amount ?? 0) / 100, // stored in cents
    });
  }

  const playMonthsSet = new Set(plays.map((p) => p.month));
  const playMonths = [...playMonthsSet].sort();
  const playMonthIdx = new Map(playMonths.map((m, i) => [m, i]));
  const playFloor = playMonths[0] ?? "2026-01";

  // Per-player aggregate.
  type Agg = {
    first: string;
    last: string;
    lastDate: Date;
    lastField: string;
    count: number;
    cityCount: Map<string, number>;
    lastCity: string;
    firstDate: Date;
    firstCity: string; // city of the earliest-dated play
    firstField: string; // field of the earliest-dated play
    // distinct (monthIdx|city|field) the player was active — powers range-distinct
    // Total players and per-entity attribution client-side.
    ev: Set<string>;
  };
  const agg = new Map<number, Agg>();
  for (const p of plays) {
    let a = agg.get(p.u);
    if (!a) {
      a = {
        first: p.month,
        last: p.date,
        lastDate: new Date(p.date),
        lastField: p.field,
        count: 0,
        cityCount: new Map(),
        lastCity: p.city,
        firstDate: new Date(p.date),
        firstCity: p.city,
        firstField: p.field,
        ev: new Set<string>(),
      };
      agg.set(p.u, a);
    }
    a.count++;
    a.cityCount.set(p.city, (a.cityCount.get(p.city) ?? 0) + 1);
    a.ev.add(`${playMonthIdx.get(p.month)!}${p.city}${p.field}`);
    if (p.month < a.first) a.first = p.month;
    const d = new Date(p.date);
    if (d >= a.lastDate) {
      a.lastDate = d;
      a.last = p.date;
      a.lastField = p.field;
      a.lastCity = p.city;
    }
    if (d < a.firstDate) {
      a.firstDate = d;
      a.firstCity = p.city;
      a.firstField = p.field;
    }
  }

  function mostFrequentCity(a: Agg): string {
    let best = a.lastCity;
    let bestN = -1;
    for (const [c, n] of a.cityCount) {
      if (n > bestN || (n === bestN && c === a.lastCity)) {
        bestN = n;
        best = c;
      }
    }
    return best;
  }
  function attributedCity(uid: number, a: Agg): string {
    const declared = declaredByUser.get(uid) ?? null;
    const freq = mostFrequentCity(a);
    if (CITY_ATTRIBUTION_RULE === "declared") return declared ?? freq;
    return freq;
  }

  // ── city + field index universe (play-location + declared markets) ─────────
  // Behaviour breakdowns are play-LOCATION based (a new player / total player /
  // spot belongs to the city & field where the match happened). Registrations are
  // by DECLARED city. The city universe is the union, so markets with sign-ups
  // but no matches yet (El Paso, New York City) still appear (PART 3).
  const declaredCitySet = new Set<string>();
  for (const u of completedUsers) {
    const c = normalizeDeclared(u.preferable_city_name);
    if (c) declaredCitySet.add(c);
  }
  const playLocCitySet = new Set<string>();
  const fieldCityMap = new Map<string, string>();
  for (const p of plays) {
    playLocCitySet.add(p.city);
    if (!fieldCityMap.has(p.field)) fieldCityMap.set(p.field, p.city);
  }
  const cityIndex = (CANONICAL_CITIES as readonly string[]).filter(
    (c) => playLocCitySet.has(c) || declaredCitySet.has(c),
  );
  for (const c of [...playLocCitySet, ...declaredCitySet]) if (!cityIndex.includes(c)) cityIndex.push(c);
  const cityIdxOf = new Map(cityIndex.map((c, i) => [c, i]));
  const cityHasMatches = cityIndex.map((c) => playLocCitySet.has(c));
  const fieldList = [...fieldCityMap.keys()];
  const fieldIdxOf = new Map(fieldList.map((f, i) => [f, i]));
  const fieldIndex = fieldList.map((f) => ({ label: f, city: fieldCityMap.get(f)! }));

  // ── players[] (churn source + client-side range-distinct behaviour) ────────
  const playerRows: PlayerRow[] = [];
  for (const [uid, a] of agg) {
    const days = Math.floor((nowDate.getTime() - a.lastDate.getTime()) / DAY_MS);
    const ev: number[] = [];
    for (const key of a.ev) {
      const [mi, c, f] = key.split("");
      ev.push(Number(mi), cityIdxOf.get(c)!, fieldIdxOf.get(f)!);
    }
    playerRows.push({
      u: uid,
      city: attributedCity(uid, a),
      declaredCity: declaredByUser.get(uid) ?? null,
      freqCity: mostFrequentCity(a),
      field: a.lastField,
      first: a.first,
      firstCity: a.firstCity,
      firstField: a.firstField,
      firstMonthIdx: playMonthIdx.get(a.first) ?? 0,
      firstCityIdx: cityIdxOf.get(a.firstCity)!,
      firstFieldIdx: fieldIdxOf.get(a.firstField)!,
      ev,
      matches: a.count,
      last: a.last,
      days,
    });
  }
  playerRows.sort((x, y) => y.days - x.days);

  const played1 = playerRows.length;
  const played5 = playerRows.filter((p) => p.matches >= 5).length;

  // ── nested cohort funnel ────────────────────────────────────────────────────
  // PART 1: a COHORT funnel, not two independent counts. For the cohort of users
  // whose completed_sign_up_at falls in a month, count how many of THOSE SAME
  // users went on to play ≥1/≥3/≥5/≥10 non-cancelled non-fake matches EVER
  // (lifetime). Each stage is a strict subset of the prior, so summing months
  // (each user belongs to exactly one signup month) can never make a conversion
  // exceed 100%. Downloads has no per-person link and is omitted here (the client
  // renders it as the one non-nested "aggregate ratio" step).
  const lifetimeMatches = new Map<number, number>();
  for (const [u, a] of agg) lifetimeMatches.set(u, a.count);
  const funnelAgg = new Map<string, { registrations: number; played1: number; played3: number; played5: number; played10: number }>();
  for (const u of completedUsers) {
    if (!u.completed_sign_up_at) continue;
    const m = monthKey(u.completed_sign_up_at);
    let row = funnelAgg.get(m);
    if (!row) funnelAgg.set(m, (row = { registrations: 0, played1: 0, played3: 0, played5: 0, played10: 0 }));
    row.registrations++;
    const lm = lifetimeMatches.get(u.id) ?? 0;
    if (lm >= 1) row.played1++;
    if (lm >= 3) row.played3++;
    if (lm >= 5) row.played5++;
    if (lm >= 10) row.played10++;
  }
  const funnelByMonth = [...funnelAgg.entries()]
    .sort()
    .map(([m, r]) => ({ m, ...r }));

  // ── THE SAME COHORT FUNNEL, SPLIT BY CITY ───────────────────────────────────
  // A signup cohort is defined at REGISTRATION, so the city that belongs to it is the one known at
  // registration: preferable_city_name (declaredByUser, already canonicalised by
  // normalizeDeclared). NOT the most-frequent play city — that exists only for users who played,
  // so using it would drop every registration that never converted, which is precisely the
  // population the top of a funnel is about.
  //
  // DOWNLOADS ARE ABSENT HERE ON PURPOSE. Apple and Google report country and region, never city,
  // so there is no per-city download figure to emit and the client renders a dash rather than
  // dividing a city's registrations by a national number.
  //
  // THE UNATTRIBUTED REMAINDER IS COUNTED, NOT HIDDEN. A user with no declared city (or one that
  // does not canonicalise) belongs to no city, so the cities do NOT sum to the national row. That
  // gap is reported as funnelUnattributed rather than being silently absorbed into a city.
  const funnelCityAgg = new Map<string, { registrations: number; played1: number; played3: number; played5: number; played10: number }>();
  const funnelUnattributedAgg = new Map<string, number>();
  for (const u of completedUsers) {
    if (!u.completed_sign_up_at) continue;
    const m = monthKey(u.completed_sign_up_at);
    const city = declaredByUser.get(u.id) ?? null;
    if (!city) {
      funnelUnattributedAgg.set(m, (funnelUnattributedAgg.get(m) ?? 0) + 1);
      continue;
    }
    const key = `${m}\u0000${city}`;
    let row = funnelCityAgg.get(key);
    if (!row) funnelCityAgg.set(key, (row = { registrations: 0, played1: 0, played3: 0, played5: 0, played10: 0 }));
    row.registrations++;
    const lm = lifetimeMatches.get(u.id) ?? 0;
    if (lm >= 1) row.played1++;
    if (lm >= 3) row.played3++;
    if (lm >= 5) row.played5++;
    if (lm >= 10) row.played10++;
  }
  const funnelByMonthCity = [...funnelCityAgg.entries()]
    .sort()
    .map(([k, r]) => { const [m, city] = k.split("\u0000"); return { m, city, ...r }; });
  const funnelUnattributed = [...funnelUnattributedAgg.entries()].sort().map(([m, registrations]) => ({ m, registrations }));
  // Invariant (asserted again on the client before render): nested subsets.
  for (const r of funnelByMonth) {
    if (!(r.registrations >= r.played1 && r.played1 >= r.played3 && r.played3 >= r.played5 && r.played5 >= r.played10)) {
      throw new Error(`funnel cohort not nested for ${r.m}: ${JSON.stringify(r)}`);
    }
  }

  // Cities that actually appear in play data (canonical, ordered).
  const playCitySet = new Set<string>();
  for (const p of playerRows) playCitySet.add(p.city);
  const cities = CANONICAL_CITIES.filter((c) => playCitySet.has(c)) as string[];
  for (const c of playCitySet) if (!cities.includes(c)) cities.push(c); // any stragglers (e.g. NYC)

  // ── behavior series ───────────────────────────────────────────────────────
  // Additive facts by (month, city, field): newPlayers, spots. Distinct facts
  // (totalPlayers) precomputed per grouping because distinct counts don't sum.
  const behaviorAxis = monthRange(
    [...regByMonth.keys()].sort()[0] ?? playFloor,
    [nowMonth, playMonths[playMonths.length - 1] ?? playFloor].sort().pop()!,
  );

  // new player = first-play month.
  const newByMonth = new Map<string, number>();
  const newByCity = new Map<string, Map<string, number>>();
  const newByField = new Map<string, Map<string, number>>();
  for (const p of playerRows) {
    newByMonth.set(p.first, (newByMonth.get(p.first) ?? 0) + 1);
    // New player belongs to the city & field of their FIRST-EVER match (play
    // location), not their attributed home city or most-recent field.
    upsert2(newByCity, p.firstCity, p.first);
    upsert2(newByField, p.firstField, p.first);
  }
  // spots + total(distinct) by month/city/field.
  const spotsByMonth = new Map<string, number>();
  const spotsByCity = new Map<string, Map<string, number>>();
  const spotsByField = new Map<string, Map<string, number>>();
  const activeByMonth = new Map<string, Set<number>>();
  const activeByCity = new Map<string, Map<string, Set<number>>>();
  const activeByField = new Map<string, Map<string, Set<number>>>();
  // Field ranking splits events out: regular spots/players feed the pitch
  // ranking; event spots/players get their own section (a tournament at ATH
  // Pearland must not inflate ATH Pearland's regular ranking). City/month
  // totals stay INCLUSIVE — an event entrant booked a real spot in a real market.
  const eventSpotsByField = new Map<string, Map<string, number>>();
  const eventActiveByField = new Map<string, Map<string, Set<number>>>();
  const fieldCity = new Map<string, string>();
  for (const p of plays) {
    spotsByMonth.set(p.month, (spotsByMonth.get(p.month) ?? 0) + 1);
    inc2(spotsByCity, p.city, p.month);
    addSet(activeByMonth, p.month, p.u);
    addSet2(activeByCity, p.city, p.month, p.u);
    if (p.isEvent) {
      inc2(eventSpotsByField, p.field, p.month);
      addSet2(eventActiveByField, p.field, p.month, p.u);
    } else {
      inc2(spotsByField, p.field, p.month);
      addSet2(activeByField, p.field, p.month, p.u);
    }
    if (!fieldCity.has(p.field)) fieldCity.set(p.field, p.city);
  }
  // Events section: one row per canonical pitch that hosted any event, total
  // spots + distinct players, ranked by spots. Kept out of the regular ranking.
  const eventFields = [...eventSpotsByField.keys()]
    .map((f) => {
      let spots = 0;
      for (const v of eventSpotsByField.get(f)?.values() ?? []) spots += v;
      const players = new Set<number>();
      for (const s of eventActiveByField.get(f)?.values() ?? []) for (const u of s) players.add(u);
      return { label: f, city: fieldCity.get(f) ?? UNKNOWN_CITY, spots, players: players.size };
    })
    .filter((e) => e.spots > 0)
    .sort((a, b) => b.spots - a.spots);

  // registrations by city (declared). Additive. No field dimension.
  const regByMonthCity = new Map<string, Map<string, number>>();
  for (const u of completedUsers) {
    if (!u.completed_sign_up_at) continue;
    const city = normalizeDeclared(u.preferable_city_name);
    if (!city) continue;
    upsert2(regByMonthCity, city, monthKey(u.completed_sign_up_at));
  }

  const behaviorOverall = behaviorAxis.map<BehaviorPoint>((m) => ({
    m,
    registrations: regByMonth.has(m) ? regByMonth.get(m)! : m < playFloor ? 0 : (regByMonth.get(m) ?? 0),
    newPlayers: m < playFloor ? null : newByMonth.get(m) ?? 0,
    totalPlayers: m < playFloor ? null : activeByMonth.get(m)?.size ?? 0,
    spots: m < playFloor ? null : spotsByMonth.get(m) ?? 0,
  }));

  // behaviorByCity spans the whole city universe (play + declared-only markets).
  const regFloorMonth = [...regByMonth.keys()].sort()[0] ?? "2023-03";
  const behaviorByCity: Record<string, BehaviorPoint[]> = {};
  for (const c of cityIndex) {
    behaviorByCity[c] = behaviorAxis.map<BehaviorPoint>((m) => ({
      m,
      registrations: regByMonthCity.get(c)?.get(m) ?? (m < regFloorMonth ? null : 0),
      // A market with no matches has a MEASURED zero play (matches exist globally
      // from playFloor, just not here) — 0, not a dash. Pre-play-floor is unknown.
      newPlayers: m < playFloor ? null : newByCity.get(c)?.get(m) ?? 0,
      totalPlayers: m < playFloor ? null : activeByCity.get(c)?.get(m)?.size ?? 0,
      spots: m < playFloor ? null : spotsByCity.get(c)?.get(m) ?? 0,
    }));
  }

  const behaviorByField: GrowthData["behaviorByField"] = {};
  for (const f of spotsByField.keys()) {
    behaviorByField[f] = {
      label: f,
      city: fieldCity.get(f) ?? UNKNOWN_CITY,
      points: playMonths.map<BehaviorPoint>((m) => ({
        m,
        registrations: null,
        newPlayers: newByField.get(f)?.get(m) ?? 0,
        totalPlayers: activeByField.get(f)?.get(m)?.size ?? 0,
        spots: spotsByField.get(f)?.get(m) ?? 0,
      })),
    };
  }

  // ── ARPP ──────────────────────────────────────────────────────────────────
  // DECISION 2: monthly only. numerator = fin_revenue net that month.
  // denominator = players who PLAYED that month ∪ members ACTIVE that month.
  const netByMonth = new Map<string, number>();
  const netByMonthCity = new Map<string, Map<string, number>>();
  for (const r of revenue) {
    if (!r.month) continue;
    const k = revMonthToKey(r.month);
    if (!k) continue;
    netByMonth.set(k, (netByMonth.get(k) ?? 0) + Number(r.net ?? 0));
    upsert2num(netByMonthCity, normalizeRevenueCity(r.city), k, Number(r.net ?? 0));
  }

  // ARPP diagnostics (PART 7 + city-breakdown 5c):
  // - deletedAccount: fin_revenue tagged to the "Deleted Account Revenue" bucket
  //   is money from hard-deleted players whose rows no longer exist — it is in the
  //   numerator but structurally cannot be in the denominator, so it overstates
  //   ARPP. Quantified per month so the panel can show ARPP with and without it.
  // - unattributedMembership: Membership revenue whose city doesn't map to a real
  //   market. Never dropped, never spread — surfaced as its own "Unattributed" row.
  const deletedByMonth = new Map<string, number>();
  const unattribMembByMonth = new Map<string, number>();
  for (const r of revenue) {
    if (!r.month) continue;
    const k = revMonthToKey(r.month);
    if (!k) continue;
    const cityRaw = (r.city ?? "").trim();
    const net = Number(r.net ?? 0);
    if (cityRaw === "Deleted Account Revenue") deletedByMonth.set(k, (deletedByMonth.get(k) ?? 0) + net);
    else if (r.type === "Membership" && normalizeRevenueCity(r.city) === UNKNOWN_CITY)
      unattribMembByMonth.set(k, (unattribMembByMonth.get(k) ?? 0) + net);
  }

  // members active per month (overall + by subscription city).
  const membersByMonth = new Map<string, Set<number>>();
  const membersByCity = new Map<string, Map<string, Set<number>>>();
  const revMonths = [...netByMonth.keys()].sort();
  const arppMonths = [...new Set([...playMonths, ...revMonths])].sort();
  for (const s of subscriptions) {
    if (s.user_id == null || !s.activation_date) continue;
    const act = monthKey(s.activation_date);
    const cancel = s.canceled_at ? monthKey(s.canceled_at) : null;
    const city = normalizeMatchCity(s.city_identifier);
    for (const m of arppMonths) {
      if (m < act) continue;
      if (cancel && m > cancel) continue; // active through cancel month inclusive
      addSet(membersByMonth, m, s.user_id);
      addSet2(membersByCity, city, m, s.user_id);
    }
  }
  const playedByMonth = activeByMonth; // reuse distinct sets

  function arppSeries(
    net: (m: string) => number,
    played: (m: string) => Set<number> | undefined,
    members: (m: string) => Set<number> | undefined,
  ): ArppPoint[] {
    return arppMonths.map((m) => {
      const pl = played(m) ?? new Set<number>();
      const me = members(m) ?? new Set<number>();
      let both = 0;
      for (const u of pl) if (me.has(u)) both++;
      const playedOnly = pl.size - both;
      const subOnly = me.size - both;
      const denom = playedOnly + subOnly + both;
      const n = net(m);
      return { m, net: n, denom, playedOnly, subOnly, both, arpp: denom ? n / denom : 0 };
    });
  }
  const arppOverall = arppSeries(
    (m) => netByMonth.get(m) ?? 0,
    (m) => playedByMonth.get(m),
    (m) => membersByMonth.get(m),
  );
  const arppByCity: Record<string, ArppPoint[]> = {};
  const arppCitySet = new Set<string>([...cities, ...netByMonthCity.keys(), ...membersByCity.keys()]);
  for (const c of arppCitySet) {
    // played players attributed to city c per month.
    const playedCity = (m: string): Set<number> => {
      const set = new Set<number>();
      for (const p of playerRows) {
        if (p.city !== c) continue;
        for (let i = 0; i < p.ev.length; i += 3) if (playMonths[p.ev[i]] === m) { set.add(p.u); break; }
      }
      return set;
    };
    arppByCity[c] = arppSeries(
      (m) => netByMonthCity.get(c)?.get(m) ?? 0,
      playedCity,
      (m) => membersByCity.get(c)?.get(m),
    );
  }

  const arppDiagnostics = {
    byMonth: arppMonths.map((m) => ({
      m,
      totalNet: netByMonth.get(m) ?? 0,
      deletedNet: deletedByMonth.get(m) ?? 0,
      unattributedMembership: unattribMembByMonth.get(m) ?? 0,
    })),
    deletedTotal: [...deletedByMonth.values()].reduce((a, v) => a + v, 0),
    unattributedMembershipTotal: [...unattribMembByMonth.values()].reduce((a, v) => a + v, 0),
  };

  // ── cohorts + retention ────────────────────────────────────────────────────
  // cohort = first-play month. cell offset o = active in calendar month first+o.
  const cohortMembers = new Map<string, number[]>();
  for (const p of playerRows) {
    if (!cohortMembers.has(p.first)) cohortMembers.set(p.first, []);
    cohortMembers.get(p.first)!.push(p.u);
  }
  // per-player active-month set for fast lookup.
  const activeMonthsByUser = new Map<number, Set<string>>();
  for (const p of plays) {
    if (!activeMonthsByUser.has(p.u)) activeMonthsByUser.set(p.u, new Set());
    activeMonthsByUser.get(p.u)!.add(p.month);
  }
  const MAX_OFFSET = 12;
  const cohortKeys = [...cohortMembers.keys()].sort();
  const cohorts: CohortRow[] = cohortKeys.map((ck) => {
    const members = cohortMembers.get(ck)!;
    const cells: CohortRow["cells"] = [];
    for (let o = 0; o <= MAX_OFFSET; o++) {
      const calMonth = addMonthsToKey(ck, o);
      const observable = monthDiff(calMonth, nowMonth) >= 0;
      const partial = calMonth === nowMonth;
      let active = 0;
      if (observable) for (const u of members) if (activeMonthsByUser.get(u)?.has(calMonth)) active++;
      cells.push({ offset: o, active, pct: members.length ? active / members.length : 0, observable, partial });
    }
    return { cohort: ck, size: members.length, cells };
  });

  // retention curve = pooled across cohorts: at offset o, sum active / sum eligible
  // (only cohorts whose calMonth is observable contribute to the denominator).
  function pooledCurve(memberFilter: (p: PlayerRow) => boolean) {
    const rows = playerRows.filter(memberFilter);
    const byCohort = new Map<string, number[]>();
    for (const p of rows) {
      if (!byCohort.has(p.first)) byCohort.set(p.first, []);
      byCohort.get(p.first)!.push(p.u);
    }
    const curve: { offset: number; pct: number; observable: boolean }[] = [];
    for (let o = 0; o <= MAX_OFFSET; o++) {
      let active = 0;
      let elig = 0;
      let anyObservable = false;
      for (const [ck, members] of byCohort) {
        const calMonth = addMonthsToKey(ck, o);
        if (monthDiff(calMonth, nowMonth) < 0) continue;
        anyObservable = true;
        elig += members.length;
        for (const u of members) if (activeMonthsByUser.get(u)?.has(calMonth)) active++;
      }
      curve.push({ offset: o, pct: elig ? active / elig : 0, observable: anyObservable && elig > 0 });
    }
    return curve;
  }
  const retentionCurveOverall = pooledCurve(() => true);
  const retentionCurveByCity: Record<string, typeof retentionCurveOverall> = {};
  for (const c of cities) retentionCurveByCity[c] = pooledCurve((p) => p.city === c);

  // ── PART 8 reconciliation: DPP net vs strict per-player booking, per month ──
  const dppByMonth = new Map<string, number>();
  let deletedAccountRevenue = 0;
  for (const r of revenue) {
    if (r.type === "DPP" && r.month) {
      const k = revMonthToKey(r.month);
      if (k) dppByMonth.set(k, (dppByMonth.get(k) ?? 0) + Number(r.net ?? 0));
    }
    if ((r.city ?? "").trim() === "Deleted Account Revenue") deletedAccountRevenue += Number(r.net ?? 0);
  }
  const strictBookingByMonth = new Map<string, number>();
  for (const p of plays) strictBookingByMonth.set(p.month, (strictBookingByMonth.get(p.month) ?? 0) + p.amount);
  const recMonths = [...new Set([...dppByMonth.keys(), ...strictBookingByMonth.keys()])].sort();
  let dppTotal = 0;
  let strictTotal = 0;
  const recRows = recMonths.map((m) => {
    const dppNet = dppByMonth.get(m) ?? 0;
    const strictBooking = strictBookingByMonth.get(m) ?? 0;
    dppTotal += dppNet;
    strictTotal += strictBooking;
    return { m, dppNet, strictBooking, gap: dppNet - strictBooking };
  });

  // ── DECISION 3 attribution comparison ──────────────────────────────────────
  const declaredDist = new Map<string, number>();
  const freqDist = new Map<string, number>();
  let disagreeRaw = 0;
  let disagreeNormalized = 0;
  let fallbackUsed = 0;
  for (const [uid, a] of agg) {
    const rawDeclared = rawDeclaredByUser.get(uid) ?? null;
    const declaredNorm = declaredByUser.get(uid) ?? null;
    const freq = mostFrequentCity(a);
    declaredDist.set(declaredNorm ?? "(unset)", (declaredDist.get(declaredNorm ?? "(unset)") ?? 0) + 1);
    freqDist.set(freq, (freqDist.get(freq) ?? 0) + 1);
    if (!declaredNorm) fallbackUsed++;
    if (rawDeclared && freq && rawDeclared !== freq) disagreeRaw++;
    if (declaredNorm && freq && declaredNorm !== freq) disagreeNormalized++;
  }

  // ── downloads (android installs) ────────────────────────────────────────────
  const androidDaily = input.androidDaily ?? [];
  const androidMonthMap = new Map<string, number>();
  let androidEarliest = "";
  let androidLatest = "";
  let androidTotal = 0;
  for (const d of androidDaily) {
    const m = monthKey(d.period_date);
    androidMonthMap.set(m, (androidMonthMap.get(m) ?? 0) + d.count);
    androidTotal += d.count;
    if (!androidEarliest || d.period_date < androidEarliest) androidEarliest = d.period_date;
    if (!androidLatest || d.period_date > androidLatest) androidLatest = d.period_date;
  }
  // ── downloads (iOS app units) — same reduction, separate series ─────────────
  const iosDaily = input.iosDaily ?? [];
  const iosMonthMap = new Map<string, number>();
  let iosEarliest = "";
  let iosLatest = "";
  let iosTotal = 0;
  for (const d of iosDaily) {
    const m = monthKey(d.period_date);
    iosMonthMap.set(m, (iosMonthMap.get(m) ?? 0) + d.count);
    iosTotal += d.count;
    if (!iosEarliest || d.period_date < iosEarliest) iosEarliest = d.period_date;
    if (!iosLatest || d.period_date > iosLatest) iosLatest = d.period_date;
  }
  const downloads: GrowthData["downloads"] = {
    androidByMonth: [...androidMonthMap.entries()].sort().map(([m, count]) => ({ m, count })),
    android: androidDaily.length ? { earliest: androidEarliest, latest: androidLatest, total: androidTotal } : null,
    iosByMonth: [...iosMonthMap.entries()].sort().map(([m, count]) => ({ m, count })),
    ios: iosDaily.length ? { earliest: iosEarliest, latest: iosLatest, total: iosTotal } : null,
  };

  // Finalize per-platform ingest health. The server determines the no-data states
  // (not_configured / never_run / failed / no_data) from env + the latest
  // fin_sync_log row; presence of rows is the ground truth for "synced".
  const playSyncBase: PlaySyncStatus =
    input.playSync ?? { state: "not_configured", lastRunAt: null, error: null, lastSyncedDate: null };
  const playSync: PlaySyncStatus = androidDaily.length
    ? { ...playSyncBase, state: "synced", lastSyncedDate: androidLatest }
    : { ...playSyncBase, lastSyncedDate: null };
  const appleSyncBase: AppleSyncStatus =
    input.appleSync ?? { state: "not_configured", lastRunAt: null, error: null, lastSyncedDate: null };
  const appleSync: AppleSyncStatus = iosDaily.length
    ? { ...appleSyncBase, state: "synced", lastSyncedDate: iosLatest }
    : { ...appleSyncBase, lastSyncedDate: null };

  return {
    generatedAt: now,
    rowCounts: input.rowCounts,
    downloads,
    playSync,
    appleSync,
    floors: {
      registrations: "2023-03",
      memberships: "2024-02",
      play: playFloor,
      revenue: revMonths[0] ?? "2026-01",
    },
    playMonths,
    kpis: {
      downloads: null,
      registrations: completedUsers.length,
      accountsCreated: nonFakeUsers.length,
      onboardingGap: nonFakeUsers.length - completedUsers.length,
      played1,
      played5,
    },
    registrationsByMonth: [...regByMonth.entries()].sort().map(([m, count]) => ({ m, count })),
    funnelByMonth,
    funnelByMonthCity,
    funnelUnattributed,
    players: playerRows,
    behaviorOverall,
    behaviorByCity,
    behaviorByField,
    eventFields,
    cityIndex,
    cityHasMatches,
    fieldIndex,
    arppOverall,
    arppByCity,
    arppDiagnostics,
    cohorts,
    retentionCurveOverall,
    retentionCurveByCity,
    cities,
    reconciliation: {
      rows: recRows,
      dppTotal,
      strictTotal,
      gapTotal: dppTotal - strictTotal,
      deletedAccountRevenue,
    },
    attribution: {
      declared: [...declaredDist.entries()].sort((a, b) => b[1] - a[1]).map(([city, count]) => ({ city, count })),
      mostFrequent: [...freqDist.entries()].sort((a, b) => b[1] - a[1]).map(([city, count]) => ({ city, count })),
      disagreeRaw,
      disagreeNormalized,
      fallbackUsed,
    },
  };
}

// ── tiny nested-map helpers ──────────────────────────────────────────────────
function upsert2(map: Map<string, Map<string, number>>, k1: string, k2: string) {
  let inner = map.get(k1);
  if (!inner) map.set(k1, (inner = new Map()));
  inner.set(k2, (inner.get(k2) ?? 0) + 1);
}
function upsert2num(map: Map<string, Map<string, number>>, k1: string, k2: string, v: number) {
  let inner = map.get(k1);
  if (!inner) map.set(k1, (inner = new Map()));
  inner.set(k2, (inner.get(k2) ?? 0) + v);
}
function inc2(map: Map<string, Map<string, number>>, k1: string, k2: string) {
  upsert2(map, k1, k2);
}
function addSet(map: Map<string, Set<number>>, k: string, v: number) {
  let s = map.get(k);
  if (!s) map.set(k, (s = new Set()));
  s.add(v);
}
function addSet2(map: Map<string, Map<string, Set<number>>>, k1: string, k2: string, v: number) {
  let inner = map.get(k1);
  if (!inner) map.set(k1, (inner = new Map()));
  let s = inner.get(k2);
  if (!s) inner.set(k2, (s = new Set()));
  s.add(v);
}
