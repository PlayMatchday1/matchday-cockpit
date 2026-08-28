/* SALES TAX — the rates, and the one conversion that uses them.
 *
 * THE ESTATE KEEPS TWO REVENUE BASES ON PURPOSE, and neither ever appears inside a single figure
 * with the other:
 *
 *   TAX-INCLUSIVE   fin_revenue as recorded. Revenue and Cities are tax-inclusive pages.
 *   PRE-TAX         roster-derived money (mdapi_match_players.amount) — Slate Review's DPP,
 *                   Match P&L, Cost. Membership joined to any of those must be pre-taxed first,
 *                   or one figure carries two bases.
 *
 * fin_revenue IS NOT TOUCHED. It stays the tax-inclusive ledger it is; only what a report divides
 * changes.
 *
 * ── THE RATES ARE READ, NEVER MEASURED ────────────────────────────────────────────────────────
 * GET /cities serves stripeTaxRateValue per city. Read 2026-08-28:
 *
 *     ATX 8.25   HOU 8.25   SATX 8.25   DFW 8.25   ELP 8.25
 *     ATL 8.9    STL 9.68   NYC 8.875   OKC 8.625  WAW 0
 *
 * Reading beat inferring on two of the ten. I had measured OKC at 8.65 from the ratio of
 * total_amount to amount; it is 8.625. And WARSAW IS ZERO — Poland is not a US sales-tax
 * jurisdiction, so dividing it by 1.0825 would have invented an 8% reduction out of nothing.
 * A rate is a fact the API holds, not a number to fit to data.
 *
 * ── GROSS, NEVER NET ──────────────────────────────────────────────────────────────────────────
 * pre-tax = gross / (1 + rate), EXACT because gross is pre-fee. Dividing NET by (1 + rate) would
 * shrink the Stripe fees by the tax rate too, which is not a thing that happened to them.
 *
 * ── AN UNKNOWN CITY THROWS ────────────────────────────────────────────────────────────────────
 * Not "assume 0%". A 0% default would leave tax sitting inside a number labelled pre-tax, which is
 * the exact failure this module exists to end. A new market must arrive in this table before its
 * revenue can be reported pre-tax, and the throw is what makes that non-optional.
 */

/** Keyed by the DISPLAY city name as fin_revenue.city holds it — "Dallas", not "Dallas / Fort
 *  Worth"; "OKC", not "Oklahoma City". Sourced from GET /cities stripeTaxRateValue. */
export const CITY_TAX_RATE: Readonly<Record<string, number>> = {
  Austin: 0.0825,
  Houston: 0.0825,
  "San Antonio": 0.0825,
  Dallas: 0.0825,
  "El Paso": 0.0825,
  Atlanta: 0.089,
  "St. Louis": 0.0968,
  "New York City": 0.08875,
  OKC: 0.08625,
  Warsaw: 0,
};

export class UnknownTaxCityError extends Error {
  constructor(city: string) {
    super(
      `No sales-tax rate for ${JSON.stringify(city)}. Rates come from GET /cities ` +
      `(stripeTaxRateValue) and must be added to CITY_TAX_RATE before revenue for this city can ` +
      `be reported pre-tax. Defaulting to 0% would leave tax inside a pre-tax figure.`,
    );
    this.name = "UnknownTaxCityError";
  }
}

/** True when we hold a rate — including Warsaw, whose rate is a real 0 rather than a missing one. */
export const hasTaxRate = (city: string | null | undefined): boolean =>
  city != null && Object.prototype.hasOwnProperty.call(CITY_TAX_RATE, city);

export function taxRateFor(city: string | null | undefined): number {
  if (!hasTaxRate(city)) throw new UnknownTaxCityError(String(city));
  return CITY_TAX_RATE[city as string];
}

/** GROSS -> PRE-TAX. Throws on a city with no rate; see the header. */
export function preTaxOf(grossDollars: number, city: string | null | undefined): number {
  const rate = taxRateFor(city);
  return rate === 0 ? grossDollars : grossDollars / (1 + rate);
}

/** The tax removed, for reporting movement. Zero for Warsaw, because its rate is zero. */
export const taxPortionOf = (grossDollars: number, city: string | null | undefined): number =>
  grossDollars - preTaxOf(grossDollars, city);

/** Names appearing in `cities` that we hold no rate for — the guard asserts these are only ever
 *  pseudo-cities like "Deleted Account Revenue", never a real market. */
export const citiesWithoutRate = (cities: Iterable<string>): string[] =>
  [...new Set([...cities].filter((c) => !hasTaxRate(c)))].sort();
