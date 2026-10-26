// WHICH FIELDS A CONFINED ACCOUNT MAY SEE AND EDIT. Pure; the routes and the page both ask here.
//
// THE SCOPE IS THE MARKET, NOT THE CITY (Ryan, 2026-10-25): a Warsaw operator sees every field in
// Poland, which is Warsaw today and whichever Polish city opens next (locationScopes.POLAND.cities).
// Matches elsewhere stay scoped to the one city_identifier; fields are the record a new market
// builds its schedule on, and that record is per country for them.
//
// A CONFINED ACCOUNT WITH NO MARKET (a US city_identifier, none exist today) falls back to its own
// city. A confined account whose city does not resolve (isConfined true, confinedCity null) is in
// scope for NOTHING: the safe reading is "confined and showing nothing", never "unconfined".
//
// THE CITY ON A FIELD is MatchDay's own object: { id, abbr, name, country: "Europe", ... } on the
// match payload (mdapi_matches.raw for 20454: abbr "WAW", name "Warsaw"). abbr IS city_identifier,
// so it is the primary test; the name is the fallback for a payload that omits abbr (the field
// list's city object carries id and name). `country` is "Europe" for Warsaw and is never read.

import { locationScopeForCity } from "./locationScopes";
import { cityNameFor } from "./cityScope";

/** What the gate hands a route: whether the account is bounded at all, and to which resolved city. */
export type Bound = { confined: boolean; confinedCity: string | null };

export type FieldCityRef = { abbr?: string | null; name?: string | null } | null | undefined;

export type FieldScope = { marketName: string; abbrs: ReadonlySet<string>; names: ReadonlySet<string> };

/** The cities whose fields this account may see. null means unconfined: no limit. An empty scope
 *  means confined to something unresolvable: nothing is in it. */
export function fieldScopeFor(b: Bound): FieldScope | null {
  if (!b.confined) return null;
  if (!b.confinedCity) return { marketName: "your market", abbrs: new Set(), names: new Set() };
  const market = locationScopeForCity(b.confinedCity);
  if (market) {
    return {
      marketName: market.name,
      abbrs: new Set(market.cities.map((c) => c.abbr)),
      names: new Set(market.cities.map((c) => c.name)),
    };
  }
  const name = cityNameFor(b.confinedCity);
  return { marketName: name ?? b.confinedCity, abbrs: new Set([b.confinedCity]), names: new Set(name ? [name] : []) };
}

/** Is a field in this account's scope, judged by the field's city? Unconfined: always. */
export function fieldCityInScope(b: Bound, city: FieldCityRef): boolean {
  const s = fieldScopeFor(b);
  if (!s) return true;
  const abbr = typeof city?.abbr === "string" ? city.abbr.trim() : "";
  if (abbr) return s.abbrs.has(abbr);
  const name = typeof city?.name === "string" ? city.name.trim() : "";
  return name.length > 0 && s.names.has(name);
}
