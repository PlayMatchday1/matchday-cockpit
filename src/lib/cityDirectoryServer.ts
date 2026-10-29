// Reads the city directory from MatchDay. Two GETs — /cities and /admin/fields — the same two the
// Fields page has always made. The shaping is in cityDirectory.ts, where it can be tested.
import { apiGet, type MatchdayEnv } from "./matchdayStageApi";
import { buildCityDirectory, type ApiCity, type ApiFieldRef, type DirectoryCity } from "./cityDirectory";

export async function fetchCityDirectory(env: MatchdayEnv): Promise<DirectoryCity[]> {
  const [cities, fields] = await Promise.all([
    apiGet<ApiCity[]>(env, "/cities"),
    apiGet<ApiFieldRef[]>(env, "/admin/fields"),
  ]);
  return buildCityDirectory(Array.isArray(cities) ? cities : [], Array.isArray(fields) ? fields : []);
}
