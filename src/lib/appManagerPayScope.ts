// THE MANAGERS WEEK, SCOPED TO ONE CITY, for a city-confined staff-app account (Ryan, 2026-11-06).
//
// WHY THE CITY FILTER WAS NOT ENOUGH. The desktop week puts each manager in ONE row under the city
// where they ran most of their matches that week (managerPayCompute.ts, dominantCity), and that row
// carries EVERY match they ran, in every city, with its pay. Filtering cities to the viewer's
// therefore (a) showed an Austin city manager a two-city manager's Houston matches and pay when
// Austin was that person's main city, and (b) dropped their Austin matches altogether when it was
// not. Measured on production 2026-11-06: no manager in the six weeks 2026-09-28 to 2026-11-02
// ran matches in two cities, so nobody was affected yet; the rule closes it before someone is.
//
// THE RULE HERE. Every manager row from every city is cut down to the viewer's city's matches, and
// kept when any are left (or when it is a manual add for this city). Match pay is recomputed from
// those matches. The week's adjustment is one amount per person with no city of its own, so it stays
// only on the row whose main city is the viewer's, as on the desktop.
//
// ATTENTION ("needs a look") was counted across every city. Recomputed from the scoped section, by
// the desktop's own definitions: unassigned matches, rows with no payroll email, adjustments with no
// reason.
//
// PURE: the route and the suite call it.

import type { CitySection, ManagerPayAttention, ManagerPayWeekPayload, ManagerRow } from "./managerPayCompute";

export function scopeRowToCity(r: ManagerRow, city: string): ManagerRow | null {
  const matches = r.matches.filter((m) => m.cityIdentifier === city);
  const home = r.cityIdentifier === city;
  if (!matches.length && !(home && (r.addedManually || r.adjustment !== 0))) return null;
  const baseTotal = matches.reduce((s, m) => s + m.payAmount, 0);
  const adjustment = home ? r.adjustment : 0;
  return {
    ...r, cityIdentifier: city, matches, matchCount: matches.length, baseTotal, adjustment,
    adjustmentNotes: home ? r.adjustmentNotes : null, adjustmentAt: home ? r.adjustmentAt : null,
    adjustmentId: home ? r.adjustmentId : null, total: baseTotal + adjustment,
  };
}

export function attentionOf(section: CitySection | null, isAdmin: boolean): ManagerPayAttention {
  if (!section) return { count: 0, unassigned: 0, noEmail: 0, bareAdjustment: 0 };
  const unassigned = section.matches.filter((m) => !m.isCancelled && !m.primaryManagerName && !m.secondManagerName).length;
  let noEmail = 0, bareAdjustment = 0;
  for (const r of section.managers) {
    if (r.addedManually) continue; // the desktop counts matched rows only
    // Emails are on the rows only when the week was computed for an admin view; otherwise unknown, not missing.
    if (isAdmin && !r.managerEmail) noEmail++;
    else if (r.adjustment !== 0 && !r.adjustmentNotes) bareAdjustment++;
  }
  return { unassigned, noEmail, bareAdjustment, count: unassigned + noEmail + bareAdjustment };
}

export function scopeWeekToCity(payload: ManagerPayWeekPayload, city: string): ManagerPayWeekPayload {
  const rows = payload.cities.flatMap((c) => c.managers).map((r) => scopeRowToCity(r, city)).filter((r): r is ManagerRow => r !== null)
    .sort((a, b) => a.managerName.localeCompare(b.managerName));
  const base = payload.cities.find((c) => c.cityIdentifier === city);
  const section: CitySection | null = base || rows.length ? {
    cityIdentifier: city,
    managers: rows,
    matches: base?.matches ?? [],
    matchCount: rows.reduce((s, r) => s + r.matchCount, 0),
    baseTotal: rows.reduce((s, r) => s + r.baseTotal, 0),
    adjustment: rows.reduce((s, r) => s + r.adjustment, 0),
    total: rows.reduce((s, r) => s + r.total, 0),
  } : null;
  return {
    ...payload,
    cities: section ? [section] : [],
    network: { matchCount: section?.matchCount ?? 0, managerCount: rows.length, baseTotal: section?.baseTotal ?? 0, adjustment: section?.adjustment ?? 0, total: section?.total ?? 0 },
    attention: attentionOf(section, payload.isAdmin),
  };
}
