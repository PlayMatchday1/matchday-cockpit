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

export type FieldPlays = { fieldId: number; matches: number; players: number; mi: number | null };
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
  const fields: FieldPlays[] = [...byField].map(([fieldId, g]) => {
    const f = fieldById.get(fieldId);
    const mi = origin && f && f.lat != null && f.lng != null ? r1(milesBetween(origin.lat, origin.lng, f.lat, f.lng)) : null;
    return { fieldId, matches: g.matches, players: g.players.size, mi };
  }).sort((a, b) => b.matches - a.matches || a.fieldId - b.fieldId);
  return { fields, matches, medianMi: dists.length ? r1(median(dists)) : null, lastDay, players: memberPlays.length, playersPlayed };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const r1 = (n: number) => Math.round(n * 10) / 10;
