// WHERE THEY PLAY, AND HOW RECENTLY — pure, shared by the server (which computes it) and the
// Locations page (which renders it). Ryan, 2026-10-08.
//
// A PLAY is a VALID PLAY (src/lib/playerActivity.ts: not cancelled, not a fake player, user_type
// PLAYER, on a match that is not cancelled and not deleted) that has STARTED (true instant at or
// before now) — "where they have actually played", so an upcoming booking is not a play here.
// Fields are the match's own field (mdapi_matches.field_id); a field that is no longer active on the
// map is still listed, marked closed.

import { milesBetween } from "./playerAreaModel";

export type Play = { fieldId: number; ms: number; day: string };
/** Every field a play happened at: its own record from the match, active or not. */
export type PlayField = { id: number; title: string; cityId: number | null; lat: number | null; lng: number | null; closed: boolean };

/** One "Where they play" line. `fieldId` is a VENUE UNIT id when grouped (venueUnits.ts); `parts` are
 *  the MatchDay field records inside that venue, shown as smaller lines under it. */
export type FieldPlays = { fieldId: number; matches: number; players: number; mi: number | null; parts?: FieldPlays[] };
export type BubblePlays = {
  /** Every field played at, most matches first. */
  fields: FieldPlays[];
  matches: number;
  /** The median, over every match, of the straight-line distance from the bubble to its field. */
  medianMi: number | null;
  /** The most recent match's local calendar day (YYYY-MM-DD). */
  lastDay: string | null;
  /** Players in the bubble, and how many of them have played at all. */
  players: number;
  playersPlayed: number;
};

/* ── ACTIVITY: WHEN A PLAYER LAST PLAYED ──────────────────────────────────────────────────────────── */
export type Activity = "d30" | "m6" | "y1" | "older" | "never";
export const ACTIVITIES: Activity[] = ["d30", "m6", "y1", "older", "never"];
export const ACTIVITY_LABEL: Record<Activity, string> = {
  d30: "Played in the last 30 days", m6: "31 days to 6 months ago", y1: "6 months to 1 year ago",
  older: "More than 1 year ago", never: "Never played",
};
export const ACTIVITY_SHORT: Record<Activity, string> = { d30: "30 days", m6: "6 months", y1: "1 year", older: "Over a year", never: "Never" };
/* COLOURS THAT ALSO DIFFER IN LIGHTNESS, so they read without hue: dark green, light yellow, mid
 * orange, mid-dark red, light grey. Text inside a bubble is white on the dark two, ink on the rest. */
export const ACTIVITY_FILL: Record<Activity, string> = { d30: "#0a6b48", m6: "#f2d24b", y1: "#ee8f2f", older: "#c0392b", never: "#c9cfcb" };
export const ACTIVITY_INK: Record<Activity, string> = { d30: "#ffffff", m6: "#3b2f00", y1: "#3a1d00", older: "#ffffff", never: "#33403a" };

const DAY_MS = 86_400_000;
export function activityOf(lastPlayMs: number | null, nowMs: number): Activity {
  if (lastPlayMs == null) return "never";
  const days = (nowMs - lastPlayMs) / DAY_MS;
  if (days <= 30) return "d30";
  if (days <= 183) return "m6";
  if (days <= 365) return "y1";
  return "older";
}
export const emptyActivity = (): Record<Activity, number> => ({ d30: 0, m6: 0, y1: 0, older: 0, never: 0 });

/** One bubble (or one player): its members' plays, counted by field, with distances from `origin`
 *  (the bubble's EXACT average position, or the player's exact position). */
export function summarizePlays(
  memberPlays: Play[][], origin: { lat: number; lng: number } | null, fieldById: Map<number, PlayField>,
  /** Group field records into venues (venueUnits.unitIdOf). fieldById must then also hold the units. */
  unitOf?: (fieldId: number) => number,
): BubblePlays {
  const byField = new Map<number, { matches: number; players: Set<number> }>();
  const dists: number[] = [];
  let lastMs = -Infinity, lastDay: string | null = null, matches = 0, playersPlayed = 0;
  memberPlays.forEach((plays, i) => {
    if (plays.length) playersPlayed++;
    for (const p of plays) {
      matches++;
      const g = byField.get(p.fieldId) ?? { matches: 0, players: new Set<number>() };
      g.matches++; g.players.add(i);
      byField.set(p.fieldId, g);
      const f = fieldById.get(p.fieldId);
      if (origin && f && f.lat != null && f.lng != null) dists.push(milesBetween(origin.lat, origin.lng, f.lat, f.lng));
      if (p.ms > lastMs) { lastMs = p.ms; lastDay = p.day; }
    }
  });
  const miTo = (id: number) => {
    const f = fieldById.get(id);
    return origin && f && f.lat != null && f.lng != null ? r1(milesBetween(origin.lat, origin.lng, f.lat, f.lng)) : null;
  };
  const line = (fieldId: number, g: { matches: number; players: Set<number> }): FieldPlays => ({ fieldId, matches: g.matches, players: g.players.size, mi: miTo(fieldId) });
  const order = (a: FieldPlays, b: FieldPlays) => b.matches - a.matches || a.fieldId - b.fieldId;
  let fields: FieldPlays[];
  if (!unitOf) fields = [...byField].map(([id, g]) => line(id, g)).sort(order);
  else {
    // VENUE TOTALS: matches summed, players DISTINCT across the venue's fields (not summed).
    const units = new Map<number, { matches: number; players: Set<number>; parts: FieldPlays[] }>();
    for (const [id, g] of byField) {
      const u = units.get(unitOf(id)) ?? { matches: 0, players: new Set<number>(), parts: [] };
      u.matches += g.matches; for (const p of g.players) u.players.add(p);
      u.parts.push(line(id, g));
      units.set(unitOf(id), u);
    }
    fields = [...units].map(([uid, u]) => ({ ...line(uid, u), parts: u.parts.sort(order) })).sort(order);
  }
  return { fields, matches, medianMi: dists.length ? r1(median(dists)) : null, lastDay, players: memberPlays.length, playersPlayed };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const r1 = (n: number) => Math.round(n * 10) / 10;

/** The VENUE entries for "Where they play": one PlayField per venue unit that any played field belongs
 *  to, named after the venue, at the mean of its fields' known positions. CLOSED only if none of its
 *  fields is active (a venue is active if any of its fields is). Unmapped fields need no entry: their
 *  unit id is their own id. */
export function venuePlayFields(played: Iterable<PlayField>, unitOf: (fieldId: number) => number, venueName: (unitId: number) => string | null): PlayField[] {
  const g = new Map<number, PlayField[]>();
  for (const f of played) { const u = unitOf(f.id); if (u !== f.id) g.set(u, [...(g.get(u) ?? []), f]); }
  return [...g].map(([id, fs]) => {
    const pos = fs.filter((f) => f.lat != null && f.lng != null);
    const cities = fs.map((f) => f.cityId).filter((c): c is number => c != null);
    return {
      id, title: venueName(id) ?? fs[0].title,
      cityId: cities.length ? cities.sort((a, b) => cities.filter((x) => x === b).length - cities.filter((x) => x === a).length)[0] : null,
      lat: pos.length ? pos.reduce((s, f) => s + (f.lat as number), 0) / pos.length : null,
      lng: pos.length ? pos.reduce((s, f) => s + (f.lng as number), 0) / pos.length : null,
      closed: fs.every((f) => f.closed),
    };
  });
}
