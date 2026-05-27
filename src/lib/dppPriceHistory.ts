// Per-venue DPP price-change detection from match_registrations
// history. Pure aggregation — caller fetches and resolves
// registrations to venues, this just walks the time series and
// surfaces shifts that hold ≥2 consecutive observations at the new
// modal.
//
// Why "≥2 consecutive" and not "every change": one-off discounts on
// a single match (manager-set $5 for a beginner clinic) are noise,
// not price changes. The Slate Review context wants real shifts.
// A single-week outlier sandwiched between same-modal weeks is
// classified as noise; the cursor doesn't advance.
//
// Reconstruction caveats baked into the algorithm:
//   - Buckets with zero DAILY PAID registrations (members-only
//     weeks, fully-comp'd matches) contribute no data and create
//     calendar gaps. The "consecutive weeks" rule is enforced on
//     consecutive BUCKETS WITH DATA, not consecutive calendar
//     weeks. A venue that runs once every 3 weeks and shifts to
//     a new modal will register the change after 2 observations
//     at the new modal, even if those span 6+ calendar weeks.
//     Acceptable trade-off for sparse venues — better than missing
//     the change entirely.
//   - Tournament-leg venues (Soccer Central $60 vs $120) resolve
//     to distinct venueIds via the existing buildFieldIdToVenueIdMap
//     + Soccer Central tournament special-casing. Each leg gets its
//     own modal sequence, so $60→$120 alternation between legs
//     doesn't appear as a price change on either leg.

export type DppRegistration = {
  // Match start in local time (Date object).
  matchStart: Date;
  // Resolved venue (post buildFieldIdToVenueIdMap). Null venueId
  // means the registration's field didn't map to a fin_venue — drop
  // it upstream; this lib expects resolved rows.
  venueId: number;
  // Display name of the venue (for rendering).
  venueName: string;
  // City the venue belongs to (display name). Caller scopes the
  // input set to one city; this lib just trusts the caller's filter.
  city: string;
  // Dollars (price the player actually paid, in dollars).
  amountDollars: number;
};

export type DppPriceChange = {
  venueId: number;
  venueName: string;
  city: string;
  prevPriceDollars: number;
  newPriceDollars: number;
  // Monday of the week the new modal was first observed (local
  // midnight). The actual change happened SOMETIME between the
  // previous bucket's week and this one — we can't pin the day
  // exactly without an audit log.
  changeWeekStart: Date;
  // Pre-computed at call time so the UI doesn't need to redo it.
  // Computed against the `now` passed in; if you re-call later
  // with a different now you get refreshed values.
  weeksAgo: number;
  daysAgo: number;
};

// Monday-of-week local-time bucket. Mirrors getMonday in weekWindow.ts
// without importing it to keep this file framework-agnostic.
function mondayOfLocal(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = x.getDay();
  const offset = dow === 0 ? -6 : 1 - dow;
  x.setDate(x.getDate() + offset);
  return x;
}

function isoOf(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

// Modal of a number array. Ties broken by the LARGER value — a
// $9/$12 split-week is more likely an in-progress price bump than
// a legacy holdover, so the larger value is the better "what the
// price is becoming" signal. With single-element arrays this just
// returns the element.
function modal(values: number[]): number {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let bestValue = values[0];
  let bestCount = 0;
  for (const [v, n] of counts) {
    if (n > bestCount || (n === bestCount && v > bestValue)) {
      bestValue = v;
      bestCount = n;
    }
  }
  return bestValue;
}

export type DetectDppPriceShiftsOpts = {
  // Reference time for "weeks ago" / "days ago" computation.
  now: Date;
  // Buckets (venue × week) with fewer DAILY PAID registrations
  // than this threshold are discarded as too-noisy-to-trust.
  // Default 2 — a single registration's price could be any one-off.
  minRegistrationsPerBucket?: number;
};

export function detectDppPriceShifts(
  regs: DppRegistration[],
  opts: DetectDppPriceShiftsOpts,
): DppPriceChange[] {
  const minRegs = opts.minRegistrationsPerBucket ?? 2;

  // Group amounts by (venueId, weekStart ISO).
  type BucketKey = string; // `${venueId}|${weekISO}`
  const buckets = new Map<BucketKey, number[]>();
  const venueMeta = new Map<number, { name: string; city: string }>();
  for (const r of regs) {
    const week = mondayOfLocal(r.matchStart);
    const key = `${r.venueId}|${isoOf(week)}`;
    const arr = buckets.get(key);
    if (arr) arr.push(r.amountDollars);
    else buckets.set(key, [r.amountDollars]);
    if (!venueMeta.has(r.venueId)) {
      venueMeta.set(r.venueId, { name: r.venueName, city: r.city });
    }
  }

  // Pivot to per-venue weekly sequence: [{week, modal, n}] sorted.
  type WeekObs = { week: Date; weekIso: string; modal: number; n: number };
  const byVenue = new Map<number, WeekObs[]>();
  for (const [key, amounts] of buckets) {
    if (amounts.length < minRegs) continue;
    const [venueIdStr, weekIso] = key.split("|");
    const venueId = Number(venueIdStr);
    const week = new Date(weekIso + "T00:00:00");
    const arr = byVenue.get(venueId) ?? [];
    arr.push({ week, weekIso, modal: modal(amounts), n: amounts.length });
    byVenue.set(venueId, arr);
  }
  for (const arr of byVenue.values()) {
    arr.sort((a, b) => a.weekIso.localeCompare(b.weekIso));
  }

  // Walk each venue's sequence. Change confirmed when a new modal
  // appears AND the next observation also has that modal. Cursor
  // skips noise (single-week deviation that immediately reverts).
  const out: DppPriceChange[] = [];
  for (const [venueId, weeks] of byVenue) {
    if (weeks.length < 3) continue; // need at minimum: old + new + new-confirm
    const meta = venueMeta.get(venueId);
    if (!meta) continue;
    let cursor = weeks[0].modal;
    for (let i = 1; i < weeks.length; i++) {
      if (weeks[i].modal === cursor) continue;
      const candidate = weeks[i].modal;
      // Look at the next observation. If it matches candidate, the
      // shift is confirmed; the change date estimate is week i's
      // Monday (the first observation at the new modal).
      if (i + 1 < weeks.length && weeks[i + 1].modal === candidate) {
        const changeWeek = weeks[i].week;
        const msAgo = opts.now.getTime() - changeWeek.getTime();
        const daysAgo = Math.max(0, Math.floor(msAgo / 86_400_000));
        const weeksAgo = Math.floor(daysAgo / 7);
        out.push({
          venueId,
          venueName: meta.name,
          city: meta.city,
          prevPriceDollars: cursor,
          newPriceDollars: candidate,
          changeWeekStart: changeWeek,
          weeksAgo,
          daysAgo,
        });
        cursor = candidate;
      }
      // else: blip, skip without advancing cursor.
    }
  }

  // Sort by most recent change first (largest changeWeekStart).
  out.sort(
    (a, b) => b.changeWeekStart.getTime() - a.changeWeekStart.getTime(),
  );
  return out;
}
