import "server-only";
// CITY PHOTOS for the public site feed (Ryan, 2026-11-03). The Clubhouse has no city photo field, so a city's photo
// comes from, in order:
//   1. CITY_PHOTO_OVERRIDES, keyed by city_identifier: the skyline images the website's Cities page already used
//      (recovered from its pre-change copy, playmatchday.com backups/stage2/before-cities-6435.json). No credit.
//   2. The city's Wikipedia lead image ("{City}, {State}"): pageimages, then the file's imageinfo with extmetadata,
//      a ~1200px rendition, and ONLY Public domain, CC0, CC BY or CC BY-SA (no NC, no ND, no fair use). The credit is
//      the author and licence in plain text. Cached for a week per city (unstable_cache); a failed lookup throws, so
//      it is not cached and is retried on the next build.
//   3. null.
import { unstable_cache } from "next/cache";

export type CityPhoto = { url: string; credit: string | null; source: "override" | "wikipedia" };

export const CITY_PHOTO_OVERRIDES: Readonly<Record<string, string>> = {
  ATX: "https://www.playmatchday.com/wp-content/uploads/2026/04/Website-Picture-8-3.png",
  HOU: "https://www.playmatchday.com/wp-content/uploads/2026/04/Website-Picture-9-3.png",
  SATX: "https://www.playmatchday.com/wp-content/uploads/2026/04/Website-Picture-10-3.png",
  DFW: "https://www.playmatchday.com/wp-content/uploads/2026/04/Website-Picture-13.png",
  ATL: "https://www.playmatchday.com/wp-content/uploads/2026/04/Website-Picture-12-3.png",
  STL: "https://www.playmatchday.com/wp-content/uploads/2026/04/Website-Picture-11.png",
  OKC: "https://www.playmatchday.com/wp-content/uploads/2026/04/Website-Picture-15.png",
};

const UA = "MatchDayClubhouse/1.0 (https://www.playmatchday.com; public site feed city photos)";
const API = "https://en.wikipedia.org/w/api.php";

/** Public domain, CC0, CC BY, CC BY-SA. Anything with NC or ND, or fair use, is refused. */
export function acceptedLicense(code: string, shortName: string): boolean {
  const c = code.toLowerCase(), s = shortName.toLowerCase();
  if (/\b(nc|nd)\b|non-?commercial|no-?deriv|fair use/.test(`${c} ${s}`)) return false;
  return /^(pd|public domain|cc0|cc-zero)/.test(c) || /^(public domain|cc0)/.test(s)
    || /^cc-by(-sa)?-\d/.test(c) || /^cc by(-sa)? \d/.test(s);
}

/** "<a href=...>Jane Doe</a>" -> "Jane Doe". */
export const plainText = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/\s+/g, " ").trim();

async function getJson(params: Record<string, string>): Promise<any> {
  const u = new URL(API);
  for (const [k, v] of Object.entries({ ...params, format: "json", formatversion: "2" })) u.searchParams.set(k, v);
  const r = await fetch(u, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(5000), cache: "no-store" });
  if (!r.ok) throw new Error(`wikipedia ${r.status}`);
  return r.json();
}

/** One uncached lookup. Throws on a network or API failure (so the cache does not keep it); null means "no usable image". */
export async function lookupWikipediaPhoto(title: string): Promise<CityPhoto | null> {
  const pi = await getJson({ action: "query", titles: title, prop: "pageimages", piprop: "name", redirects: "1" });
  const file = pi?.query?.pages?.[0]?.pageimage as string | undefined;
  if (!file) return null;
  const ii = await getJson({ action: "query", titles: `File:${file}`, prop: "imageinfo", iiprop: "url|extmetadata", iiurlwidth: "1200",
    iiextmetadatafilter: "LicenseShortName|License|Artist|Credit" });
  const info = ii?.query?.pages?.[0]?.imageinfo?.[0];
  if (!info?.thumburl) return null;
  const meta = info.extmetadata ?? {};
  const code = String(meta.License?.value ?? ""), shortName = String(meta.LicenseShortName?.value ?? "");
  if (!acceptedLicense(code, shortName)) return null;
  const author = plainText(String(meta.Artist?.value ?? "")) || "Unknown author";
  const url = String(info.thumburl).split("?")[0];
  return { url, credit: `Photo: ${author}, ${shortName || code} (Wikimedia Commons)`, source: "wikipedia" };
}

const cachedLookup = (title: string) => unstable_cache(() => lookupWikipediaPhoto(title), ["public-site-city-photo", title], { revalidate: 7 * 24 * 3600 })();

/** The photo for a city, by the order above. Never throws. */
export async function cityPhoto(abbr: string, cityName: string, stateName: string | null): Promise<CityPhoto | null> {
  const o = CITY_PHOTO_OVERRIDES[abbr];
  if (o) return { url: o, credit: null, source: "override" };
  if (!stateName) return null;
  try {
    return await cachedLookup(`${cityName}, ${stateName}`);
  } catch (e) {
    console.error(`[public-site] city photo lookup failed for ${cityName}: ${(e as Error).message}`);
    return null;
  }
}
