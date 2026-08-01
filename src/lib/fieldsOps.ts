// Pure derivation for the Fields (Match Ops → Field Ops) page. No fetching, no
// React — rows in, facts out. The page component and the reconciliation script
// both import this, so a rendered number and its check can never drift.
//
// Every number derives from the match ledger (mdapi_matches + valid
// participation), exactly like the mockup derives everything from one array:
// the sparkline, the typical-fill average, the idle count and the tiles all read
// the same per-field object. A match "happened" iff is_cancelled=false — NEVER
// auto_canceled, which is a policy flag, not an outcome. Attendance counts only
// valid play (non-fake, non-cancelled, user_type=PLAYER); is_absent is not
// tracked in the data (0% populated), so post-match roster count is the best
// attendance signal available and is labelled as such on the page.

// ── thresholds: named once, printed in the footer, used everywhere ──
export const IDLE_DAYS = 45; // no match in this many days and none booked → idle
export const FILL_MIN_MATCH = 3; // below this many matches we won't state a typical fill
export const TRAIL_WEEKS = 8;
export const UPCOMING_DAYS = 7;

export const DAY_MS = 86_400_000;

export type Venue = {
  id: number;
  name: string;
  city: string;
  code: string;
  contactName: string | null;
  contactPhone: string | null;
  minPlayers: number | null;
  maxPlayers: number | null;
  scheduleUrl: string | null;
  address: string | null; // derived from a linked match's field_address
};

// One match instance for a venue. count = attended (played) or signed up
// so far (upcoming) — the SAME field, read at two different times, never added.
export type VenueMatch = { startMs: number; played: boolean; time: string; count: number };

export type Week = { aMs: number; bMs: number };

export function buildWeeks(nowMs: number, weeks = TRAIL_WEEKS): Week[] {
  // Sunday of the week TRAIL_WEEKS-1 back (UTC), matching the mockup's W0.
  const d = new Date(nowMs);
  const sundayThisWeek = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - d.getUTCDay() * DAY_MS;
  const w0 = sundayThisWeek - (weeks - 1) * 7 * DAY_MS;
  const out: Week[] = [];
  for (let i = 0; i < weeks; i++) out.push({ aMs: w0 + i * 7 * DAY_MS, bMs: w0 + i * 7 * DAY_MS + 6 * DAY_MS });
  return out;
}
export function weekIndexOf(ms: number, weeks: Week[]): number {
  if (!weeks.length) return -1;
  const i = Math.floor((ms - weeks[0].aMs) / (7 * DAY_MS));
  return i >= 0 && i < weeks.length ? i : -1;
}

export type FieldRow = {
  venue: Venue;
  wk: { m: number; p: number }[]; // per week: matches played, players attended
  matches: number; // played matches in window
  players: number; // attended players in window
  fill: number | null; // avg attended / played match, null below the floor
  lastMs: number | null;
  idleDays: number | null;
  next: VenueMatch | null;
  nextSignups: number; // == next.count (sign-ups so far), or 0
  upcomingCount: number; // matches in the next UPCOMING_DAYS
  upcomingSignups: number; // sign-ups across those
  playingThisWeek: boolean;
  flags: Flag[];
};

export type FlagKind = "contact" | "idle" | "never" | "fill";
export type Flag = { k: FlagKind; level: "w" | "c"; label?: string; act: string };

export function deriveField(venue: Venue, matches: VenueMatch[], nowMs: number, weeks: Week[]): FieldRow {
  const played = matches.filter((m) => m.played).sort((a, b) => b.startMs - a.startMs);
  const upcoming = matches.filter((m) => !m.played).sort((a, b) => a.startMs - b.startMs);
  const wk = weeks.map(() => ({ m: 0, p: 0 }));
  for (const m of played) {
    const i = weekIndexOf(m.startMs, weeks);
    if (i < 0) continue;
    wk[i].m += 1;
    wk[i].p += m.count;
  }
  const mN = wk.reduce((s, x) => s + x.m, 0);
  const pN = wk.reduce((s, x) => s + x.p, 0);
  const lastMs = played.length ? played[0].startMs : null;
  const idleDays = lastMs != null ? Math.round((nowMs - lastMs) / DAY_MS) : null;
  const lastWeek = weeks.length - 1;
  const thisWeek =
    wk[lastWeek].m + upcoming.filter((m) => weekIndexOf(m.startMs, weeks) === lastWeek).length;
  const upcomingWindow = upcoming.filter((m) => m.startMs >= nowMs && m.startMs <= nowMs + UPCOMING_DAYS * DAY_MS);
  const next = upcomingWindow[0] ?? null;

  const row: FieldRow = {
    venue,
    wk,
    matches: mN,
    players: pN,
    fill: mN >= FILL_MIN_MATCH ? pN / mN : null,
    lastMs,
    idleDays,
    next,
    nextSignups: next?.count ?? 0,
    upcomingCount: upcomingWindow.length,
    upcomingSignups: upcomingWindow.reduce((s, m) => s + m.count, 0),
    playingThisWeek: thisWeek > 0,
    flags: [],
  };
  row.flags = flagsFor(row);
  return row;
}

export function flagsFor(r: FieldRow): Flag[] {
  const out: Flag[] = [];
  if (!r.venue.contactPhone)
    out.push({ k: "contact", level: r.next ? "c" : "w", label: "No contact", act: "Add contact" });
  if (r.idleDays != null && r.idleDays >= IDLE_DAYS && !r.next)
    out.push({ k: "idle", level: "w", label: `Idle ${r.idleDays}d`, act: "Review booking" });
  if (r.matches === 0) out.push({ k: "never", level: "w", label: "Never used", act: "Review booking" });
  if (r.fill != null && r.venue.minPlayers != null && r.fill < r.venue.minPlayers)
    out.push({ k: "fill", level: "w", label: "Under minimum", act: "Adjust minimum" });
  return out;
}

// urgency: contact-with-a-match-booked > idle/never > under-minimum > contact
const RANK: Record<string, number> = { contact_now: 0, idle: 1, never: 1, fill: 2, contact: 3 };
export function rankKey(r: FieldRow, f: Flag): string {
  return f.k === "contact" && r.next ? "contact_now" : f.k;
}
export function leadFlag(r: FieldRow): Flag | null {
  if (!r.flags.length) return null;
  return [...r.flags].sort((a, b) => RANK[rankKey(r, a)] - RANK[rankKey(r, b)])[0];
}
// which lead-flag bucket a flagged field counts under (so the tile breakdown
// sums to fields, not flags). "contact_now" folds back into "contact".
export function leadBucket(r: FieldRow): FlagKind | null {
  const lead = leadFlag(r);
  return lead ? lead.k : null;
}

export type Tiles = {
  total: number;
  playingThisWeek: number;
  upcomingMatches: number;
  upcomingFields: number;
  upcomingSignups: number;
  needsLook: number;
  breakdown: { k: FlagKind; n: number }[]; // ordered by urgency
};

export function computeTiles(rows: FieldRow[]): Tiles {
  const total = rows.length;
  const playing = rows.filter((r) => r.playingThisWeek).length;
  const upFields = rows.filter((r) => r.upcomingCount > 0);
  const upcomingMatches = rows.reduce((s, r) => s + r.upcomingCount, 0);
  const upcomingSignups = rows.reduce((s, r) => s + r.upcomingSignups, 0);
  const flagged = rows.filter((r) => r.flags.length > 0);
  const byKind = new Map<FlagKind, number>();
  for (const r of flagged) {
    const k = leadBucket(r)!;
    byKind.set(k, (byKind.get(k) ?? 0) + 1);
  }
  const order: FlagKind[] = ["contact", "idle", "never", "fill"]; // display order (contact_now folds into contact, rank 0/3)
  const breakdown = order.filter((k) => byKind.has(k)).map((k) => ({ k, n: byKind.get(k)! }));
  return {
    total,
    playingThisWeek: playing,
    upcomingMatches,
    upcomingFields: upFields.length,
    upcomingSignups,
    needsLook: flagged.length,
    breakdown,
  };
}

export const FLAG_NOUN: Record<FlagKind, string> = {
  contact: "with no contact",
  idle: "sitting idle",
  never: "never used",
  fill: "under their minimum",
};

// view predicates (shared by the segment counts and the visible list)
export function inView(r: FieldRow, view: string): boolean {
  if (view === "week") return r.playingThisWeek;
  if (view === "attn") return r.flags.length > 0;
  if (view === "idle") return r.flags.some((f) => f.k === "idle" || f.k === "never");
  return true;
}
