# Disclosed palette deviations

Places where the UI deliberately departs from the house palette / colour rules,
with the reason each is safe. Add an entry whenever you knowingly break a rule.

> Note: this file was created on 2026-08-02 when the fourth deviation below was
> logged; earlier deviations predate a central log and live in their component
> comments. New deviations go here.

## 4. Cancel Patterns chronic scale — categorical multi-hue, not sequential

**Where:** `src/app/(internal)/match-ops/slate-review/SlateReviewView.tsx` (`RAMP`).

**Deviation:** the n-of-4-weeks chronic scale is categorical multi-hue and is
**not monotonic in lightness** — 3-of-4 (`#8b2c17`) is darker than 4-of-4
(`#d62015`).

**Permitted because** the exact `n/4` count is printed on every chip, so colour
reinforces the count and is never the sole encoding.

**Colours & contrast (text on background, all ≥ 4.5:1):**

| step | background | text | border | contrast |
|------|------------|------|--------|----------|
| 1 of 4 | `#f0ece3` | `#12241d` | `#e2ddd0` (1px) | 13.7:1 |
| 2 of 4 | `#eda01e` | `#12241d` | none | 7.4:1 |
| 3 of 4 | `#8b2c17` | `#ffffff` | none | 8.5:1 |
| 4 of 4 | `#d62015` | `#ffffff` | none | 5.2:1 |

The 1-of-4 border is required: `#f0ece3` sits too close to the day-cell
background (`--slot-bg #f8f3e7`) and the chip would lose its shape without it.
