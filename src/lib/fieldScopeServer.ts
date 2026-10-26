// THE FIELD BOUNDARY ON A REQUEST. Every /api/fields* route that names a field id or a city id calls
// one of these BEFORE acting. A confined account can type a US field id into a request as easily as
// anyone; this is what turns that into a 403 instead of a US field's photos, numbers or record.
//
// ONE API READ, NOT A SWEEP. There is no single-field GET (/admin/fields/{id} is a 404, measured), so
// the field's city comes from the list, one request. An unconfined account costs no request here.
//
// DENY BY DEFAULT. A field the list does not carry cannot be proved in scope, so a confined account is
// refused it with the same words as a field outside the scope. Existence is not confirmed either way.

import { apiGet } from "./matchdayStageApi";
import { CONFINED_CITY_ERROR } from "./cityConfinement";
import { fieldCityInScope, type Bound } from "./fieldScope";

type ListedField = { id: number; city?: { id?: number; abbr?: string | null; name?: string | null } | null };
type ListedCity = { id: number; name?: string | null; abbr?: string | null };

type Verdict = { ok: true } | { ok: false; status: number; error: string };
const refused: Verdict = { ok: false, status: 403, error: CONFINED_CITY_ERROR };

/** Is field `fieldId` inside this account's market? */
export async function assertFieldInScope(b: Bound, fieldId: number): Promise<Verdict> {
  if (!b.confined) return { ok: true };
  let rows: ListedField[];
  try { rows = await apiGet<ListedField[]>("production", "/admin/fields"); }
  catch { return { ok: false, status: 502, error: "Could not read the field list to check the field's city. Nothing was done." }; }
  const field = rows.find((f) => Number(f.id) === Number(fieldId));
  if (!field) return refused;
  return fieldCityInScope(b, field.city) ? { ok: true } : refused;
}

/** Is MatchDay city `cityId` inside this account's market? For create, and for a PUT that moves a
 *  field to another city. */
export async function assertCityInScope(b: Bound, cityId: number): Promise<Verdict> {
  if (!b.confined) return { ok: true };
  let cities: ListedCity[];
  try { cities = await apiGet<ListedCity[]>("production", "/cities"); }
  catch { return { ok: false, status: 502, error: "Could not read the city list to check the city. Nothing was done." }; }
  const city = cities.find((c) => Number(c.id) === Number(cityId));
  if (!city) return refused;
  return fieldCityInScope(b, city) ? { ok: true } : refused;
}
