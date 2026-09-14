// MANUFACTURING AN UNBOUND CONFIRMED CARD, ON THE READ.
//
// These suites were written while 27 cards sat in Confirmed with no field. All 25 that remain are
// now bound, so every one of them died on nonEmpty: "expected at least one confirmed card with no
// field, found none". That is the guard doing its job — an assertion over an empty set proves
// nothing — but a suite that only runs while the feature is UNFINISHED stops testing the moment it
// works, which is the wrong way round.
//
// So the subject is made rather than found: one already-bound card has its venue_id and stage
// rewritten on the way past, which is a READ-side fixture and never a write. Nothing in production
// changes, and clearing the backlog cannot silence these suites again.

/** Pick a card to unbind and say which venue it used to hold, so the caller can avoid that venue. */
export function pickUnbindTarget(cards, opts = {}) {
  const bound = (cards ?? []).filter((c) => c.venue_id != null && c.stage === "confirmed");
  const avoid = new Set(opts.avoid ?? []);
  const hit = bound.find((c) => !avoid.has(c.id)) ?? bound[0];
  return hit ? { cardId: hit.id, title: hit.title, freedVenueId: hit.venue_id } : null;
}

/**
 * Rewrite kanban_cards rows on the way past.
 *   unbind  : card ids to strip venue_id from (and force into Confirmed)
 *   retitle : [{ cardId, title }]
 *   inject  : [{ cardId, venueId }] applied AFTER unbind, so a suite can do both
 */
export function patchCards(rows, { unbind = [], retitle = [], inject = [] } = {}) {
  const un = new Set(unbind);
  for (const c of rows) {
    if (un.has(c.id)) { c.venue_id = null; c.stage = "confirmed"; }
  }
  for (const r of retitle) {
    const t = rows.find((c) => c.id === r.cardId);
    if (t) t.title = r.title;
  }
  for (const i of inject) {
    const t = rows.find((c) => c.id === i.cardId);
    if (t) t.venue_id = i.venueId;
  }
  return rows;
}
