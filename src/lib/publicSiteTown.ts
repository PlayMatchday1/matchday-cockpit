// A VENUE'S TOWN for the public site feed (Ryan, 2026-11-04): "street, town, ST ZIP" on playmatchday.com.
//
// MatchDay's field records carry one free-text address line and a ZIP. The line sometimes names the town ("2029 Pecan
// Ln, Katy", "200 Noblewood Dr San Antonio, Texas"), often does not ("1280 S Bagdad Rd"), and sometimes ends with the
// state, ZIP or country. address.city in the feed is MatchDay's market name ("Austin" for a Leander venue), so it is
// not a town.
//
// The rule, in order:
//   1. Strip a trailing country, ZIP, state code or state name.
//   2. The street's own town wins when it has one: a trailing comma segment with no digits ("…, Saginaw"), or the
//      street ending with the ZIP table's town ("200 Noblewood Dr San Antonio"). Saginaw shows why: its ZIP, 76131, is
//      "Fort Worth" in the table.
//   3. Else the town for the ZIP from the bundled GeoNames table (src/lib/data/us-zip-towns.json, CC BY 4.0), only when
//      the table's state is the venue's state.
//   4. Else no town (null). Never a guess.
// "Saint X" from the table prints as "St. X" ("St. Louis", the name MatchDay and the street lines use).
import zipTowns from "./data/us-zip-towns.json";

const TABLE = zipTowns as Record<string, string>;
export type TownSource = "street" | "zip" | null;
export type VenueTown = { street_line: string | null; town: string | null; town_source: TownSource };

const STATE_NAMES: Record<string, string> = { TX: "Texas", GA: "Georgia", MO: "Missouri", OK: "Oklahoma", PA: "Pennsylvania", CO: "Colorado", NY: "New York", IL: "Illinois", FL: "Florida", CA: "California", AZ: "Arizona", NC: "North Carolina", TN: "Tennessee", NJ: "New Jersey" };

/** A segment that names a road or a place inside the venue, not a town ("N White Chapel Blvd", "Suite 190"). */
const STREETISH = /\b(st|street|rd|road|blvd|boulevard|ave|avenue|dr|drive|ln|lane|way|pkwy|parkway|fwy|freeway|hwy|highway|trl|trail|ct|court|cir|circle|pl|place|ter|terrace|loop|pike|suite|ste|unit|bldg|fields?|park|complex|school|stadium)\.?$/i;
const tidyTown = (t: string) => t.replace(/^Saint\s+/i, "St. ").replace(/\s+/g, " ").trim();
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The ZIP table's town for a ZIP, when its state is the venue's state. */
export function zipTown(zip: string | null, state: string | null): string | null {
  if (!zip || !/^\d{5}$/.test(zip)) return null;
  const hit = TABLE[zip]; if (!hit) return null;
  const [place, st] = hit.split("|");
  return state && st !== state ? null : tidyTown(place);
}

export function venueTown(street: string | null, state: string | null, zip: string | null): VenueTown {
  const fromZip = zipTown(zip, state);
  if (!street || !street.trim()) return { street_line: null, town: fromZip, town_source: fromZip ? "zip" : null };
  const stName = state ? STATE_NAMES[state] : undefined;
  // 1. trailing country / ZIP / state, repeatedly ("…, Round Rock, TX 78664, United States")
  let s = street.replace(/\s+/g, " ").trim();
  for (let i = 0; i < 4; i++) {
    const before = s;
    s = s.replace(/,?\s*(United States|USA|US)\.?$/i, "").trim();
    if (zip) s = s.replace(new RegExp(`,?\\s*${esc(zip)}$`), "").trim();
    if (state) s = s.replace(new RegExp(`,?\\s*${esc(state)}$`), "").trim();
    if (stName) s = s.replace(new RegExp(`,?\\s*${esc(stName)}$`, "i"), "").trim();
    s = s.replace(/,\s*$/, "").trim();
    if (s === before) break;
  }
  // 2a. trailing comma segment with no digits is the street's own town
  const parts = s.split(",").map((p) => p.trim()).filter(Boolean);
  const last = parts[parts.length - 1] ?? "";
  if (parts.length >= 2 && !/\d/.test(last) && !STREETISH.test(last)) {
    return { street_line: parts.slice(0, -1).join(", "), town: tidyTown(parts[parts.length - 1]), town_source: "street" };
  }
  // 2b. the street ends with the table's town without a comma ("200 Noblewood Dr San Antonio")
  if (fromZip) {
    const names = [fromZip, fromZip.replace(/^St\. /, "Saint "), fromZip.replace(/^St\. /, "St ")];
    for (const n of names) {
      const m = s.match(new RegExp(`^(.*\\d.*?)[\\s,]+${esc(n)}$`, "i"));
      if (m) return { street_line: m[1].replace(/,\s*$/, "").trim(), town: fromZip, town_source: "street" };
    }
  }
  // 3 / 4
  return { street_line: s || null, town: fromZip, town_source: fromZip ? "zip" : null };
}
