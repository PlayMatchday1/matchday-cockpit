// Gameday Ops — the pure board model (Phase 15). No "use client", no "server-only":
// shared by the route, the component, and the tests, so they cannot drift. Every
// derived number here is computed from a raw API match + the current instant; the
// board stores nothing.
//
// GROUNDED IN THE LIVE API (probed on staging), where it CONFLICTS with the mockup
// the API wins — see docs/matchday-api-facts.md "Gameday Ops":
//   • order is by the REAL instant `startDateUtc`, not wall-clock + a per-city
//     offset. The mockup faked time; the API carries the true instant, so no offset
//     math exists here and the mockup's "day offset" auto-cancel bug cannot occur.
//   • the current fake count is OBSERVED (`_count.fakePlayers`), not derived from
//     the ladder. The ladder (`fakeSpotLeft{36,24,12,6,3}h`) drives only the
//     next-release forecast. This resolves the Part-B "do fakes clear?" question:
//     current fakes are whatever the backend reports; the ladder is a forecast.
//   • "cancelled" is `isCancelled` (the derived did-it-happen), NOT `autoCanceled`
//     (a policy flag). See the auto_canceled memory.

export type ApiCount = { players?: number; fakePlayers?: number };
export type ApiMatch = {
  id: number;
  name: string;
  startDate: string;          // wall-clock local time at the field's city
  startDateUtc: string;       // the true kickoff instant (used for ordering)
  isCancelled?: boolean;      // the real did-it-happen flag (READONLY)
  autoCanceledMinutes?: number; // MINUTES before kickoff (spec says hours; spec is wrong)
  minPlayerCount?: number;
  maxPlayerCount?: number | null; // capacity cap; null/0 = special event (no cap)
  registrationPrice?: number; // cents
  fakeSpotLeft36h?: number; fakeSpotLeft24h?: number; fakeSpotLeft12h?: number;
  fakeSpotLeft6h?: number; fakeSpotLeft3h?: number;
  isAutoBump?: boolean;
  category?: string; type?: string;
  _count?: ApiCount;
  field?: { title?: string | null; city?: { id?: number; name?: string | null; timeZone?: { abbr?: string | null; name?: string | null } | null } | null } | null;
  manager?: { firstName?: string; lastName?: string } | null;
  teams?: { teamNumber?: number }[] | null;
};

// Colour thresholds, in HOURS to the auto-cancel DEADLINE (not to kickoff). Named
// so the report can state what fraction of a week they'd colour.
export const CRIT_HOURS = 3;
export const WARN_HOURS = 6;
// Band boundaries, in minutes from now.
export const DONE_MIN = -90;   // more than 90 min past kickoff => finished
export const SOON_MIN = 240;   // within four hours => "next four hours"

export const MARKS: [number, keyof ApiMatch][] = [
  [36, "fakeSpotLeft36h"], [24, "fakeSpotLeft24h"], [12, "fakeSpotLeft12h"],
  [6, "fakeSpotLeft6h"], [3, "fakeSpotLeft3h"],
];

const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export const kickoffMs = (m: ApiMatch): number => Date.parse(m.startDateUtc);
export const minsUntil = (m: ApiMatch, now: number): number => (kickoffMs(m) - now) / 60000;
// `_count.players` is the TOTAL occupied count (real + fake); `_count.fakePlayers` is
// the fakes among them. The REAL count — the number an operator acts on at a field — is
// the difference. A fake is a placeholder, not a player who will show up. (Confirmed on
// production 17325: players 6, fakePlayers 3 => 3 real.) Do NOT collapse this back to
// `players` (that double-counts fakes: it inflates "real" and then openSpots =
// cap-real-fake subtracts the fakes twice).
export const realCount = (m: ApiMatch): number => Math.max(0, n(m._count?.players) - n(m._count?.fakePlayers));
export const filledCount = (m: ApiMatch): number => n(m._count?.players); // total occupied (real + fake)
export const fakeCount = (m: ApiMatch): number => n(m._count?.fakePlayers); // OBSERVED, not ladder-derived
export const capacity = (m: ApiMatch): number | null => {
  const c = m.maxPlayerCount;
  return c == null || c === 0 ? null : c; // null/0 => special event, no cap
};
// real + fake + open === capacity, EXACTLY (open is defined as the remainder, never
// negative). With a real cap this is an identity; assert it as equality, not >=.
export const openSpots = (m: ApiMatch): number | null => {
  const cap = capacity(m);
  return cap == null ? null : Math.max(0, cap - realCount(m) - fakeCount(m));
};

export const teamCount = (m: ApiMatch): number => (Array.isArray(m.teams) ? m.teams.length : 0);
// SHORTFALL BASIS (Q3, flagged): the minimum-to-avoid-auto-cancel is compared against
// REAL players only — a fake won't show up to play. The MatchDay API does not expose
// whether its own auto-cancel counts fakes; if it turns out it does, change realCount ->
// filledCount on these two lines (only). See docs/matchday-api-facts.md.
export const short = (m: ApiMatch): boolean => realCount(m) < n(m.minPlayerCount);
export const shortBy = (m: ApiMatch): number => Math.max(0, n(m.minPlayerCount) - realCount(m));

// ── time / ordering ──────────────────────────────────────────────────────────
// Local wall-clock time-of-day for display, parsed from the STRING (never new Date
// on a wall-clock value — it has no zone). Returns e.g. "6:00 PM".
export function localClock(m: ApiMatch): string {
  const t = /T(\d{2}):(\d{2})/.exec(m.startDate || "");
  if (!t) return "";
  let h = Number(t[1]); const mm = t[2]; const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 === 0 ? 12 : h % 12;
  return `${h}:${mm} ${ap}`;
}
export const tzAbbr = (m: ApiMatch): string => m.field?.city?.timeZone?.abbr?.trim() || "";
// The date the operator files this match under — its LOCAL wall-clock calendar date
// (YYYY-MM-DD), which is exactly how the API's fromDate/toDate filter bounds it.
export const localDate = (m: ApiMatch): string => (m.startDate || "").slice(0, 10);
// Real kickoff order across timezones: sort by the true instant, ascending.
export function byKickoff(a: ApiMatch, b: ApiMatch): number { return kickoffMs(a) - kickoffMs(b); }

export function fmtDur(min: number): string {
  const a = Math.abs(Math.round(min)), h = Math.floor(a / 60), mm = a % 60;
  return h ? `${h}h ${mm}m` : `${mm}m`;
}

// ── bands ────────────────────────────────────────────────────────────────────
export type Band = "live" | "soon" | "later" | "done" | "cx";
export function bandOf(m: ApiMatch, now: number): Band {
  if (m.isCancelled) return "cx";        // cancelled sinks to the bottom whatever the time
  const t = minsUntil(m, now);
  if (t <= DONE_MIN) return "done";
  if (t <= 0) return "live";
  if (t <= SOON_MIN) return "soon";
  return "later";
}
export const BANDS: { k: Band; t: string }[] = [
  { k: "live", t: "KICKED OFF" },
  { k: "soon", t: "NEXT FOUR HOURS" },
  { k: "later", t: "LATER" },
  { k: "done", t: "FINISHED" },
  { k: "cx", t: "CANCELLED" },
];

// ── fake-spot ladder countdown ───────────────────────────────────────────────
// Fakes are clamped by available room: a rung of 8 on a match with 2 spots free is
// 2 fakes. room = cap - real (fakes occupy real spots).
export function clampFakes(m: ApiMatch, rung: number): number {
  const cap = capacity(m);
  const room = cap == null ? rung : Math.max(0, cap - realCount(m));
  return Math.min(Math.max(0, rung), room);
}
// The next mark that actually RELEASES spots: the soonest upcoming mark (largest
// markH still ahead of us) whose clamped rung is below the current fake count.
export type Release = { mark: number; inMin: number; drop: number };
export function nextRelease(m: ApiMatch, now: number): Release | null {
  if (m.isCancelled) return null;
  const h = minsUntil(m, now) / 60;
  if (h <= 0) return null;
  const cur = fakeCount(m);
  for (const [mark, key] of MARKS) {           // 36 → 3 (soonest-upcoming is the largest still ahead)
    if (h > mark) {
      const rung = clampFakes(m, n(m[key] as number));
      const drop = cur - rung;
      if (drop > 0) return { mark, inMin: Math.round((h - mark) * 60), drop };
    }
  }
  return null;
}
// The mark about to fire (soonest upcoming), for highlighting the rung on the tile.
export function nextMark(m: ApiMatch, now: number): number | null {
  const h = minsUntil(m, now) / 60;
  if (h <= 0) return null;
  for (const [mark] of MARKS) if (h > mark) return mark;
  return null;
}

// ── auto-cancel drives the tile ──────────────────────────────────────────────
// The deadline is autoCanceledMinutes BEFORE kickoff. Distance to the DEADLINE (not
// kickoff) decides the colour. Because kickoff is a real instant, this needs no day
// offset — the mockup's "tomorrow coloured a day early" bug cannot occur here.
export const deadlineMs = (m: ApiMatch): number => kickoffMs(m) - n(m.autoCanceledMinutes) * 60000;
export const minsToDeadline = (m: ApiMatch, now: number): number => (deadlineMs(m) - now) / 60000;
export type AcLevel = "" | "warn" | "crit";
export function acLevel(m: ApiMatch, now: number): AcLevel {
  if (m.isCancelled || minsUntil(m, now) <= 0 || !short(m) || capacity(m) == null) return "";
  const h = minsToDeadline(m, now) / 60;       // a passed deadline is h <= 0 => crit
  if (h <= CRIT_HOURS) return "crit";
  if (h <= WARN_HOURS) return "warn";
  return "";
}

// ── risk tier (Snapshot view) ────────────────────────────────────────────────
// Three states from ONE function, on the SAME short()/minsToDeadline() the rest of the
// board uses. Distinct from acLevel (the card's 3h/6h crit/warn tint): the snapshot's
// red is a single 2-hour "cancel call is imminent" threshold.
export const CANCEL_SOON_MINUTES = 120;
export type RiskTier = "green" | "amber" | "red";
export function riskTier(m: ApiMatch, now: number): RiskTier {
  // GREEN when the minimum is met — OR the match carries no live cancel risk (cancelled,
  // finished, or uncapped). RED needs BOTH short AND the cancel call within 2h; a full
  // match close to its deadline stays green.
  if (m.isCancelled || minsUntil(m, now) <= 0 || capacity(m) == null || !short(m)) return "green";
  return minsToDeadline(m, now) <= CANCEL_SOON_MINUTES ? "red" : "amber";
}

// ── the minimum, marked on the bar ───────────────────────────────────────────
// All as percentages of capacity, so the marker sits at its own number and the
// hatched band's width IS the shortfall.
export type Fill = { realPct: number; fakePct: number; minPct: number; gapPct: number; hit: boolean; cleared: boolean };
export function fill(m: ApiMatch): Fill | null {
  const cap = capacity(m); if (cap == null) return null;
  const pct = (x: number) => (x / cap) * 100;
  return {
    realPct: pct(realCount(m)), fakePct: pct(fakeCount(m)),
    minPct: pct(n(m.minPlayerCount)), gapPct: pct(shortBy(m)),
    hit: !short(m), cleared: !short(m),
  };
}

// ── flags & attention ────────────────────────────────────────────────────────
export type Flag = { k: "bad" | "warn" | "info"; t: string };
export function flags(m: ApiMatch, now: number): Flag[] {
  const out: Flag[] = [];
  if (m.isCancelled || minsUntil(m, now) <= 0) return out;
  if (!m.manager) out.push({ k: "bad", t: "NO MANAGER" });
  const f = fakeCount(m), open = openSpots(m), cap = capacity(m);
  if (cap != null && f > 0 && open === 0) out.push({ k: "warn", t: `FULL ONLY BECAUSE OF ${f} FAKE` });
  if (f > realCount(m)) out.push({ k: "warn", t: "MORE FAKE THAN REAL" });
  if (cap != null && minsUntil(m, now) < 180 && (open ?? 0) > 6) out.push({ k: "warn", t: `${open} SPOTS UNSOLD, ${fmtDur(minsUntil(m, now))} OUT` });
  if (m.isAutoBump) out.push({ k: "info", t: "AUTO-BUMP TO TOURNAMENT" });
  return out;
}
export function attention(m: ApiMatch, now: number): boolean {
  return !m.isCancelled && minsUntil(m, now) > 0 &&
    (acLevel(m, now) !== "" || flags(m, now).some((f) => f.k === "bad" || f.k === "warn"));
}

// ── selection / filtering (drives BOTH the grid and the stats) ────────────────
export type BoardFilter = "all" | "att" | "upc";
export function passesFilter(m: ApiMatch, now: number, filter: BoardFilter): boolean {
  return filter === "all" ? true : filter === "att" ? attention(m, now) : minsUntil(m, now) > 0;
}
export function inCities(m: ApiMatch, cities: Set<string>): boolean {
  return cities.size === 0 || cities.has(m.field?.city?.name ?? "");
}
