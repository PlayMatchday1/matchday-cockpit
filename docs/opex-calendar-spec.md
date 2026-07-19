# OpEx Calendar — Blend Redesign Spec (decisions locked)

**Visual reference:** `opex-blend.html` (v3, collapsible) is the finished front-end — port its markup/styles. Its `<style>` block is the token source of truth.

**Illustrative-numbers warning:** every dollar figure and every per-venue field-cost date/cadence in the mock is a placeholder to show layout. Wire real sources; do not hardcode.

---

## Decisions locked (Phase 0 + design review)

1. **Wire in Match Manager Pay and Field Costs** from their real screens (not `fin_opex_entries`). Confirmed.
2. **City Manager Pay source:** switch from the hardcoded `checkIns` roster to **`fin_expenses` category 'City Manager'** so it agrees with Cash Flow. ⚠ Verify the two produce the same total for the current month *before* flipping, so the displayed number doesn't silently change.
3. **Match Manager Pay:** aggregated weekly total. Collapsed header shows a chip per Thursday pay date; expand → per-city rows (from the `/managers` compute already written to `fin_expenses` as category 'Match Manager Pay'; read it, don't recompute live).
4. **Field Costs:** per-venue **dated** rows. Reason: some venues bill monthly, some quarterly, some are large lumps — the point is seeing *when* they hit. Collapsed header shows aggregated per-day chips (incl. quarterly lumps); expand → per-venue rows. Flows into Daily Total + Cumulative like everything else.
5. **Categories are collapsible** (see below).

---

## Open dependency — blocks the Field Costs build

Field-cost **timing** must exist to place venues on real dates. Confirm:

- Does the venue / field-cost data carry a **billing cadence** (monthly / quarterly / annual) *and* a **due date** per venue — or only a monthly amount via `buildFieldCostRows`?
- **If yes:** place each venue on its real hit-date.
- **If no:** capture it first (add cadence + due-date to the venue/field-cost config; `fin_opex_entries.recurrence` already models `monthly`/`quarterly`/`annually`). Do NOT default all venues to day 1.

Regardless of dating, the **Field Costs subtotal must equal the Field Costs tab's own total** (`buildFieldCostRows(data, month)` sum = $26,535 for Jul 2026) — no third total. Note the known, pre-existing $5,520 gap vs the Cash Flow venue line ($32,055) is out of scope here.

---

## Data wiring (target)

| Category | Source (real) | Dating | Row shape (collapsed → expanded) |
|---|---|---|---|
| City Manager Pay | `fin_expenses` cat 'City Manager' (was `checkIns`) | pay dates (1st/15th) | per-day chips → per-manager rows |
| Match Manager Pay | `fin_expenses` cat 'Match Manager Pay' (written by `/managers` sync) | weekly Thursday | per-Thursday chips → per-city rows |
| Field Costs | `buildFieldCostRows` (financeCosts.ts) + per-venue cadence/date | per-venue hit dates | per-day chips → per-venue rows (monthly/quarterly tags) |
| Marketing / Personnel / Equipment / Other | `fin_opex_entries` via + Add Expense | `scheduled_date` + recurrence | itemized; all four collapse to one line when empty |

---

## Collapse behavior

- Each category is a collapsible group (click header, or Expand all / Collapse all).
- **Collapsed:** header row = chevron + name + subtotal + **aggregated per-day chips** (preserves the "when it hits" read).
- **Expanded:** header hides its chips; per-manager / per-venue line-item rows appear with their own dated chips.
- **Defaults:** City Manager expanded, Match Manager collapsed, Field Costs collapsed (keeps ~15 venues from crowding). Persist per-user expand state in the real app.

---

## Totals & reconciliation (changed from earlier draft)

- Everything is now dated, so **Daily Total and Cumulative sum every dated outflow, including field costs** — the old "field costs as a monthly reconciliation lump" model is gone.
- **Cumulative = sparkline** across the day columns (stepped area, `vector-effect:non-scaling-stroke`, end value labeled). No per-day numbers — that was the squish problem. It should visibly jump on big hit days.
- Sanity checks: sum of category subtotals = month total; Field Costs subtotal = Field Costs tab total.

---

## Layout & tokens (port from `opex-blend.html` v3)

- **Summary layer:** KPI tiles (Total outflow · Top category % · Biggest hit day · Categories with spend) + "Where the money goes" horizontal magnitude bars (single green hue, sorted desc, source sublabel, empties muted).
- **Calendar layer:** sticky first column + sticky dark-green header (day # + weekday initial); **today = brand-green column** (not red); faint weekend tint; collapsible category groups; Daily Total row; Cumulative sparkline.
- **Tokens:** cream `#f2ebdd`; deep green `#123d2c`; bright green `#2fbf6c`; tint `#e6f4ec`; today `#d7f0e0`/head `#33c46f`; quarterly accent amber `#fbeede`/`#b5701f`. Money = tabular, right-aligned, bold. Match the Manager Pay table's density/header so the screens read as one system.

---

## Acceptance criteria

- Match Manager Pay + Field Costs appear, sourced from their real screens; no hardcoded values, no third total.
- Field Costs subtotal = Field Costs tab; venues placed on real cadence/dates (once timing confirmed).
- City Manager Pay reads from `fin_expenses`, parity verified before switch.
- Categories collapse/expand; Field Costs defaults collapsed; collapsed header still shows timing chips.
- Cumulative renders as a sparkline and jumps on big hit days.
- Empty categories collapse to one line; today highlight brand-green; month nav + Add expense intact; sticky col/header scroll works.

Build behind your normal flag/branch; don't touch the live tab until the field-cost timing dependency above is resolved.
