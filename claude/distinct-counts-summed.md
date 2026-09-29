# Summing a distinct count: the Period total that was 87% too high

**Found 2026-09-27, fixed 2026-09-28.** Player Activity (formerly Player Behavior).

## The number

`Total players` and `Returning players` are **distinct counts** — the route computes each bucket as
`activeByWeek.get(w)?.size`, a Set per bucket. The table's `Period total` column summed those Set
sizes, which double-counts everyone who appears in more than one bucket. On this data most players do.

Measured over Apr–Sep 2026, twice, by two independent derivations that agree:

| | |
|---|---|
| sum of the six monthly Set sizes — what the column showed | **15,625** |
| `COUNT(DISTINCT user_id)` over the same range | **8,361** |
| overstated by | **7,264 — 86.9%, a factor of 1.87** |

Per month, for reference: Apr 2,314 · May 2,245 · Jun 2,372 · Jul 3,002 · Aug 2,964 · Sep 2,722.

## Why it survived

**15,625 is 0.9% below the all-time player count of 15,757.** A six-month figure landing within one
percent of the all-time figure reads as "almost everyone who ever played, played this half-year" — a
plausible and flattering story about the business. The true 8,361 is **53% of all time**, which is a
completely different claim. Someone may have repeated the old one.

This is the failure mode this page keeps producing: **a number that is wrong in a way that looks
right.** It is not caught by reading the screen, because nothing on the screen looks wrong.

## Which three metrics, and which were fine

- **Total players** — wrong. Sum of Set sizes.
- **Returning players** — wrong. `totalPlayers − newPlayers` per bucket, then summed, so it inherits it.
- **Returning player %** — **correct by construction.** Rates were explicitly excluded from summing
  long before this, and take the latest value. The rule existed; it just was not applied to counts.
- **Registrations, New players, Spots booked** — correct. Each row belongs to exactly one bucket, so
  they are genuinely additive.

## The rule was already written down

`growthMetricGrid.ts` has said this since it was created:

> `totalPlayers` → a DISTINCT count; summing double-counts anyone active in two months/markets, so it
> is read per group, never summed.

**The Period total column summed it anyway.** Documenting it again would change nothing.

## So the rule is a type, not a comment

```ts
export type AdditiveMetric = Extract<GridMetric, "registrations" | "newPlayers" | "spots">;
export const isAdditive = (m: GridMetric): m is AdditiveMetric => ADDITIVE.has(m);
export function sumAcrossBuckets(m: AdditiveMetric, values: readonly (number | null)[]): number
```

`sumAcrossBuckets` is the only sanctioned summing path and accepts nothing else. Verified inside the
compiled program:

```
error TS2345: Argument of type '"totalPlayers"' is not assignable to parameter of type 'AdditiveMetric'.
```

That proof had to be run from `src/`, not `scripts/` — `scripts/` is outside the tsconfig program, so
a check placed there compiles nothing and reports success.

## The correct figure comes from the route

`GET /api/lifecycle/behavior-weekly?windows=from:to,from:to` returns a distinct count per window,
built from **one Set per window** rather than combined per-bucket Sets — the only way a distinct count
over a range can be right, because per-bucket Sets cannot be merged without knowing who is in two.

One aggregate serves both callers: the Period total over the displayed period, and the day-matched
change over each of two compared windows.

## Sweep: no second instance

Every other consumer of `behaviorOverall` / `behaviorByCity` / `behaviorByField` reads month keys
only (`PlayerFunnel.tsx:103`, `GrowthDataProvider.tsx:78,89`). The Data Room, the cities card, the
membership pages and the exports do not total these.

**One hazard remains, unfixed and deliberate:** `totalPlayers` means two opposite things.

| file | meaning | additive |
|---|---|---|
| `growthAnalytics`, `behavior-weekly` | distinct players in a bucket | **no** |
| `partnerStats.ts:891` | `mdPlayers + guests`, headcount on one match | **yes** |

`partnerStats.ts:962` sums the second kind into a spots total, which is correct.
`partnerDashboardData.ts:130` and `PartnerDashboardView.tsx:217` likewise. The `AdditiveMetric` guard
protects only the growth side, because only that side goes through `GridMetric`.

## Outstanding

Wiring the aggregate into the panel is **parked**. The wrong number is gone; the right one is not on
screen yet, so those two cells show a dash with the reason stated on the page. **That is completeness,
not correctness** — every month column was always right, and only the total was summing something that
must not be summed.

The effect that fetches the aggregate enters with correct parameters and never returns from its first
`await`. Known: `g.authHeaders` is empty by the time the panel runs, and switching the panel's other
fetch to it broke weekly grain — so `getSession()` is not what stalls it either. Both suspects are
eliminated; the next person starts from there rather than from the symptom.
