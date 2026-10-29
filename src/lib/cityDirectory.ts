/* THE CITY DIRECTORY — which cities exist, and which have somewhere to play.
 *
 * ONE SOURCE, READ FROM MATCHDAY. `GET /cities` is the list of cities and `GET /admin/fields` says
 * which of them has a field. Both are the API's own records; nothing here is a list somebody typed.
 * Measured 2026-10-28 on production: /cities returns 11 (ATX HOU SATX ATL STL NYC DFW OKC ELP WAW
 * PHL), /admin/fields puts at least one field in 9 of them — every city but NYC and ELP.
 *
 * TWO QUESTIONS, ONE LIST, TWO FILTERS:
 *   "where can a field go"     every city — the New field form. A city with no field must be
 *                              offered, or its first field could never be made.
 *   "where can a match go"     cities with >= 1 field — the Master Schedule chips. A city appears
 *                              there the moment it has a field, with no code change and no row in
 *                              veo_camera_count.
 *
 * THE DISPLAY NAME. Master Schedule speaks CITY_CODE_TO_DISPLAY ("Dallas", "OKC"), not the API's
 * "Dallas / Fort Worth" / "Oklahoma City", and veo_camera_count, veo_codes and the slot keys are all
 * keyed by it. So a city the map knows uses its spelling; a city it does not know uses the API's
 * own name — which is how a new market renders correctly before anyone edits the map.
 *
 * Pure: no fetch here. cityDirectoryServer.ts reads the two endpoints. */

import { CITY_CODE_TO_DISPLAY } from "./scheduleReconcile";

export type ApiCity = { id: number; name: string; abbr?: string | null; timeZone?: { name?: string | null } | null };
export type ApiFieldRef = { id: number; title?: string | null; cityId?: number | null; city?: { id?: number | null } | null };

export type DirectoryField = { id: number; title: string };
export type DirectoryCity = {
  id: number;
  /** The API's own name ("Dallas / Fort Worth"). */
  name: string;
  /** city_identifier ("DFW"). Null only if the API ever serves a city without one. */
  abbr: string | null;
  /** The Master Schedule spelling ("Dallas"). */
  display: string;
  /** IANA zone from the city's own timeZone row, when it is a real IANA name. */
  timeZone: string | null;
  fields: DirectoryField[];
};

export function displayCityName(abbr: string | null | undefined, apiName: string | null | undefined): string | null {
  return (abbr ? CITY_CODE_TO_DISPLAY[abbr] : undefined) ?? (apiName?.trim() || null);
}

/* /time-zones carries rows named "EDT" and "CDT" beside the IANA ones (ids 2 and 3), so a name is
 * only trusted as a zone if it has the Area/Location shape. */
const isIana = (z: string | null | undefined): z is string => !!z && /^[A-Za-z]+\/[A-Za-z_]+/.test(z);

export function buildCityDirectory(cities: ApiCity[], fields: ApiFieldRef[]): DirectoryCity[] {
  const byCity = new Map<number, DirectoryField[]>();
  for (const f of fields) {
    const cid = Number(f.cityId ?? f.city?.id);
    if (!Number.isFinite(cid)) continue;
    const list = byCity.get(cid) ?? byCity.set(cid, []).get(cid)!;
    list.push({ id: Number(f.id), title: (f.title ?? "").trim() || `Field ${f.id}` });
  }
  return cities
    .map((c) => {
      const abbr = c.abbr?.trim() || null;
      return {
        id: Number(c.id),
        name: c.name,
        abbr,
        display: displayCityName(abbr, c.name) ?? `City ${c.id}`,
        timeZone: isIana(c.timeZone?.name) ? c.timeZone!.name! : null,
        fields: (byCity.get(Number(c.id)) ?? []).sort((a, b) => a.title.localeCompare(b.title)),
      };
    })
    .sort((a, b) => a.display.localeCompare(b.display));
}

/* CITIES THAT RUN ON THEIR OWN RULES, OFF BOTH LISTS (Ryan, 2026-10-28: "I don't want El Paso … I
 * also don't want New York … they have their own rules"). Neither has a field today, so the
 * ">= 1 field" rule already keeps them off Master Schedule; this keeps them off when one gets a
 * field, and off the New field dropdown, where they appeared because that list is every city.
 *
 * WARSAW IS NOT HERE, ON PURPOSE. It is already on Master Schedule (veo_camera_count row, migration
 * 0138) and on the New field form, and the Warsaw operator's confined tier depends on both. Leaving
 * it out of this set changes nothing about it. */
export const EXCLUDED_CITY_ABBRS: ReadonlySet<string> = new Set(["ELP", "NYC"]);
export const isExcludedCity = (c: Pick<DirectoryCity, "abbr">): boolean => !!c.abbr && EXCLUDED_CITY_ABBRS.has(c.abbr);

/** The New field form's cities: every city, less the excluded ones. */
export const fieldFormCities = (d: DirectoryCity[]): DirectoryCity[] => d.filter((c) => !isExcludedCity(c));

/** The Master Schedule's cities: every city with somewhere to play, less the excluded ones. */
export const citiesWithFields = (d: DirectoryCity[]): DirectoryCity[] =>
  d.filter((c) => c.fields.length > 0 && !isExcludedCity(c));
