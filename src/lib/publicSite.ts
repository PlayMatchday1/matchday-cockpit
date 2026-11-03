// THE PUBLIC WEBSITE FEED — the pure half of /api/public/site.json. Server half: publicSiteServer.ts.
//
// playmatchday.com (WordPress) reads this instead of hand-typed lists. Everything here is already
// public in the app: field names, addresses, cover photos, kickoff times, prices, capacity. NOTHING
// PERSONAL ever enters this module — no roster, no player, no payment, no manager. The inputs are
// the match rows' schedule columns, the API's field and city records, and aggregate counts.
//
// ── TWO CLOCKS, HANDLED APART ─────────────────────────────────────────────────────────────────
//   start_date      LOCAL WALL CLOCK wearing a Z it does not mean. Only ever SLICED as a string
//                   (wallYmd / wallHm): calendar date, kickoff time, weekday. Never handed to Date.
//   start_date_utc  TRUE UTC INSTANT. The only column compared with `now` ("has it kicked off").
// "Today" per city is the city's IANA zone applied to the real instant `now` (localYmd).
//
// ── THE RULE (Ryan, 2026-11-03) ───────────────────────────────────────────────────────────────
// A match COUNTS if it is scheduled (alive), not cancelled, and its local date is within 30 days
// either side of the city's today. The SCHEDULE decides, not fin_venues: Westlake's fin_venues row
// says schedule_end_date 2026-09-30, and it is running again with players booked (Ryan: "the
// schedule is correct, the fin_venues end date is stale").
//   venue   live      >= 1 counting match that has kicked off
//           upcoming  counting matches, all still in the future -> first_match_date
//           (absent)  no counting match
//   city    live      >= 1 live venue
//           launching venues, all upcoming
//           coming_soon  in GET /cities, no match ever recorded
//           (OMITTED) a match in history, none counting — El Paso, New York today. The site does
//                     not mention them (Ryan, 2026-11-03, replacing the earlier "paused").
//   Warsaw (WAW) is a licensee, not a MatchDay market: excluded from everything, counts included.
//
// ── THE UNIT IS THE VENUE ─────────────────────────────────────────────────────────────────────
// MatchDay keeps several field records at one place (NEMP Tournaments / NEMP Discounted, Crossbar
// Rowlett / Crossbar Rowlett Discount). One website entry per place, grouped by venueUnits'
// groupIntoUnits — the same grouping the Locations page uses. A field with no fin_venue_fields
// link joins a linked field of the SAME city at the IDENTICAL coordinates (same place, same pin);
// otherwise it stands alone under its own title.

import { groupIntoUnits, type VenueLink } from "./venueUnits";

export const SCHEMA_VERSION = 1;
export const WINDOW_DAYS = 30;
export const SCHEDULE_DAYS = 14;
export const EXCLUDED_CITY_ABBRS: ReadonlySet<string> = new Set(["WAW"]);

/* The site's own URL slugs, read off https://www.playmatchday.com/page-sitemap.xml on 2026-11-03
 * (pickup-soccer-in-austin, -dallas, -oklahoma-city, -st-louis, ...). Philadelphia per Ryan. A city
 * not listed slugs its API name. */
const CITY_SLUGS: Record<string, string> = {
  ATX: "austin", HOU: "houston", SATX: "san-antonio", DFW: "dallas", ATL: "atlanta",
  STL: "st-louis", OKC: "oklahoma-city", PHL: "philadelphia", NYC: "new-york", ELP: "el-paso",
};

export type ApiCityRow = { id: number; name: string; abbr?: string | null; state?: { name?: string | null; abbr?: string | null } | null; timeZone?: { name?: string | null } | null };
export type ApiFieldRow = { id: number; title?: string | null; address?: string | null; zipcode?: string | number | null; lat?: number | string | null; lng?: number | string | null; cityId?: number | null; cover?: string | null; deletedAt?: string | null };
export type MatchRow = {
  api_id: number; field_id: number; city_identifier: string | null;
  start_date: string; start_date_utc: string;
  registration_price: number | string | null; max_player_count: number | null;
  team_count: number | null;
};
export type CityTotals = { matchesAllTime: number; playersAllTime: number; everHadMatch: boolean };

export type SiteMatch = { date: string; weekday: string; kickoff: string; kickoff_label: string; format: string | null; price_cents: number | null; spots_total: number | null };
export type SiteField = {
  slug: string; name: string; neighborhood: string | null;
  address: { street: string | null; city: string; state: string | null; zip: string | null };
  lat: number | null; lng: number | null; cover_photo_url: string | null;
  formats: string[]; weekdays: string[];
  status: "live" | "upcoming"; first_match_date: string | null;
  matches_last_30_days: number;
  next_14_days: SiteMatch[];
  mdapi_field_ids: number[];
};
export type SiteCity = {
  slug: string; name: string; state: string | null; state_name: string | null;
  status: "live" | "launching" | "coming_soon"; time_zone: string | null;
  first_match_date: string | null;
  price_per_match_cents: { min: number; max: number } | null;
  membership_monthly_cents: number | null;
  counts: { matches_last_30_days: number; matches_all_time: number; players_all_time: number };
  fields: SiteField[];
};
export type SitePayload = {
  schema_version: number; generated_at: string;
  window: { days_back: number; days_ahead: number; schedule_days: number };
  definitions: Record<string, string>;
  totals: { live_cities: number; launching_cities: number; live_fields: number; upcoming_fields: number; matches_all_time: number; players_all_time: number };
  cities: SiteCity[];
};

// ── clock helpers (string surgery on the wall clock; Intl on the true instant) ──────────────
export const wallYmd = (wall: string) => wall.slice(0, 10);
export const wallHm = (wall: string) => wall.slice(11, 16);
export function localYmd(now: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
const ymdParts = (ymd: string) => ymd.split("-").map(Number) as [number, number, number];
/** Calendar arithmetic on a bare date. Date.UTC on the parts is calendar maths, not a clock read. */
export function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymdParts(ymd);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export function weekdayOf(ymd: string): string { const [y, m, d] = ymdParts(ymd); return WD[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]; }
export function kickoffLabel(hm: string): string {
  const [h, mi] = hm.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(mi).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** "9v9": capacity over team count. maxPlayerCount is the TOTAL (facts: the capacity landmine); the
 *  team count is the match's own teams[]. Null when it does not divide — never a fractional side. */
export function formatOf(m: Pick<MatchRow, "max_player_count" | "team_count">): string | null {
  const cap = Number(m.max_player_count), teams = Number(m.team_count) || 2;
  if (!Number.isFinite(cap) || cap <= 0 || cap % teams !== 0) return null;
  const per = cap / teams;
  return `${per}v${per}`;
}
const formatSort = (a: string, b: string) => parseInt(a) - parseInt(b);

export const slugify = (s: string) =>
  s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** GET /admin/fields serves zipcode as a NUMBER (78746), which drops a leading zero; a US zip is five digits. */
const zipOf = (z: unknown): string | null => { const s = String(z ?? "").trim(); return !s ? null : /^\d{1,4}$/.test(s) ? s.padStart(5, "0") : s; };
const num = (v: unknown): number | null => { const n = Number(v); return v == null || v === "" || !Number.isFinite(n) ? null : n; };
/** A coordinate pair is only published when it is a plausible one. Field 992 stores lat -90.49 / lng 38.70 (swapped). */
export function validLatLng(lat: unknown, lng: unknown): { lat: number; lng: number } | null {
  const a = num(lat), b = num(lng);
  if (a == null || b == null || Math.abs(a) > 90 || Math.abs(b) > 180 || (a === 0 && b === 0)) return null;
  return { lat: a, lng: b };
}

/** Unlinked fields borrow the link of a linked field in the same city at the identical position. */
export function extendLinksByPosition(fields: ApiFieldRow[], links: ReadonlyMap<number, VenueLink>): Map<number, VenueLink> {
  const out = new Map(links);
  const key = (f: ApiFieldRow) => { const ll = validLatLng(f.lat, f.lng); return ll ? `${f.cityId}|${ll.lat}|${ll.lng}` : null; };
  const byPos = new Map<string, VenueLink>();
  for (const f of fields) { const k = key(f), l = links.get(Number(f.id)); if (k && l && !byPos.has(k)) byPos.set(k, l); }
  for (const f of fields) { if (out.has(Number(f.id))) continue; const k = key(f); const l = k ? byPos.get(k) : undefined; if (l) out.set(Number(f.id), l); }
  return out;
}

export type BuildInput = {
  now: Date;
  cities: ApiCityRow[];
  fields: ApiFieldRow[];
  /** Alive, non-cancelled matches whose wall-clock date is near the window (the builder applies the exact per-city window). */
  matches: MatchRow[];
  links: ReadonlyMap<number, VenueLink>;
  /** By city abbr. */
  cityTotals: ReadonlyMap<string, CityTotals>;
  playersAllTime: number;
  membershipMonthlyCents?: ReadonlyMap<string, number>;
};

export function buildSitePayload(inp: BuildInput): SitePayload {
  const nowMs = inp.now.getTime();
  const fieldById = new Map(inp.fields.filter((f) => !f.deletedAt).map((f) => [Number(f.id), f]));
  const links = extendLinksByPosition([...fieldById.values()], inp.links);
  const cities: SiteCity[] = [];

  for (const c of inp.cities) {
    const abbr = (c.abbr ?? "").trim();
    if (!abbr || EXCLUDED_CITY_ABBRS.has(abbr)) continue;
    const tz = c.timeZone?.name && /^[A-Za-z]+\/[A-Za-z_]+/.test(c.timeZone.name) ? c.timeZone.name : null;
    const today = localYmd(inp.now, tz ?? "America/Chicago");
    const lo = addDays(today, -WINDOW_DAYS), hi = addDays(today, WINDOW_DAYS), schedHi = addDays(today, SCHEDULE_DAYS - 1);
    const cityFields = [...fieldById.values()].filter((f) => Number(f.cityId) === Number(c.id));
    const cityFieldIds = new Set(cityFields.map((f) => Number(f.id)));
    // Counting matches: on one of this city's fields, inside the window by the wall-clock date.
    const counting = inp.matches.filter((m) => cityFieldIds.has(Number(m.field_id)) && wallYmd(m.start_date) >= lo && wallYmd(m.start_date) <= hi);
    const byField = new Map<number, MatchRow[]>();
    for (const m of counting) byField.set(Number(m.field_id), [...(byField.get(Number(m.field_id)) ?? []), m]);

    const activeFields = cityFields.filter((f) => byField.has(Number(f.id)));
    const units = groupIntoUnits(
      activeFields.map((f) => ({ id: Number(f.id), title: (f.title ?? "").trim() || `Field ${f.id}`, cityId: Number(f.cityId), lat: num(f.lat) ?? 0, lng: num(f.lng) ?? 0 })),
      links,
    );
    const usedSlugs = new Set<string>();
    const siteFields: SiteField[] = units.map((u) => {
      const ms = u.fields.flatMap((uf) => byField.get(uf.id) ?? []).sort((a, b) => a.start_date_utc.localeCompare(b.start_date_utc));
      // The representative field record: the busiest in the window. Its address, pin and cover are the venue's.
      const rep = [...u.fields].sort((a, b) => (byField.get(b.id)?.length ?? 0) - (byField.get(a.id)?.length ?? 0) || a.id - b.id)
        .map((uf) => fieldById.get(uf.id)!).find((f) => f.cover) ?? fieldById.get(u.fields[0].id)!;
      const kicked = ms.filter((m) => Date.parse(m.start_date_utc) <= nowMs);
      const future = ms.filter((m) => Date.parse(m.start_date_utc) > nowMs);
      const status: SiteField["status"] = kicked.length > 0 ? "live" : "upcoming";
      /* THE PUBLIC NAME. One field record: the app's own title, which is what a player sees ("The Hattrick L.",
       * "Zipp Family Sports Park"); fin_venues names are internal ("Hattrick", "New Braunfels", "KISC (Katy Intl)").
       * Several records: the venue name, because the records are product listings ("Tourney at Soccer Central",
       * "NEMP Discounted") and none of them names the place. */
      const name = u.fields.length === 1 ? ((fieldById.get(u.fields[0].id)!.title ?? "").trim() || u.title) : u.title;
      let slug = slugify(name) || `field-${u.fields[0].id}`;
      if (usedSlugs.has(slug)) slug = `${slug}-${u.fields[0].id}`;
      usedSlugs.add(slug);
      const ll = validLatLng(rep.lat, rep.lng);
      return {
        slug, name, neighborhood: null,
        address: { street: String(rep.address ?? "").trim() || null, city: c.name, state: c.state?.abbr ?? null, zip: zipOf(rep.zipcode) },
        lat: ll?.lat ?? null, lng: ll?.lng ?? null,
        cover_photo_url: rep.cover || null,
        formats: [...new Set(ms.map(formatOf).filter((x): x is string => !!x))].sort(formatSort),
        weekdays: WD.filter((d) => ms.some((m) => weekdayOf(wallYmd(m.start_date)) === d)),
        status,
        first_match_date: status === "upcoming" ? wallYmd(future[0].start_date) : null,
        matches_last_30_days: kicked.length,
        next_14_days: future.filter((m) => wallYmd(m.start_date) <= schedHi).map((m) => ({
          date: wallYmd(m.start_date), weekday: weekdayOf(wallYmd(m.start_date)),
          kickoff: wallHm(m.start_date), kickoff_label: kickoffLabel(wallHm(m.start_date)),
          format: formatOf(m), price_cents: num(m.registration_price), spots_total: num(m.max_player_count),
        })),
        mdapi_field_ids: u.fields.map((f) => f.id).sort((a, b) => a - b),
      };
    }).sort((a, b) => (a.status === b.status ? 0 : a.status === "live" ? -1 : 1) || b.matches_last_30_days - a.matches_last_30_days || a.name.localeCompare(b.name));

    const totals = inp.cityTotals.get(abbr) ?? { matchesAllTime: 0, playersAllTime: 0, everHadMatch: false };
    let status: SiteCity["status"];
    if (siteFields.some((f) => f.status === "live")) status = "live";
    else if (siteFields.length > 0) status = "launching";
    else if (!totals.everHadMatch) status = "coming_soon";
    else continue; // history, nothing counting: omitted (El Paso, New York today).

    const prices = counting.map((m) => num(m.registration_price)).filter((p): p is number => p != null && p > 0);
    const upcomingDates = siteFields.filter((f) => f.first_match_date).map((f) => f.first_match_date!).sort();
    cities.push({
      slug: CITY_SLUGS[abbr] ?? slugify(c.name), name: c.name,
      state: c.state?.abbr ?? null, state_name: c.state?.name ?? null,
      status, time_zone: tz,
      first_match_date: status === "launching" ? upcomingDates[0] ?? null : null,
      price_per_match_cents: prices.length ? { min: Math.min(...prices), max: Math.max(...prices) } : null,
      membership_monthly_cents: inp.membershipMonthlyCents?.get(abbr) ?? null,
      counts: {
        matches_last_30_days: siteFields.reduce((s, f) => s + f.matches_last_30_days, 0),
        matches_all_time: totals.matchesAllTime,
        players_all_time: totals.playersAllTime,
      },
      fields: siteFields,
    });
  }
  const order = { live: 0, launching: 1, coming_soon: 2 } as const;
  cities.sort((a, b) => order[a.status] - order[b.status] || b.counts.matches_all_time - a.counts.matches_all_time || a.name.localeCompare(b.name));

  return {
    schema_version: SCHEMA_VERSION,
    generated_at: inp.now.toISOString(),
    window: { days_back: WINDOW_DAYS, days_ahead: WINDOW_DAYS, schedule_days: SCHEDULE_DAYS },
    definitions: {
      counting_match: "Scheduled, not cancelled, local date within 30 days before or after today in the city's time zone.",
      field: "One entry per venue (a place can hold several MatchDay field records, e.g. a discounted or tournament listing). Named as the app names it when the venue has one record, by the venue when it has several.",
      matches_all_time: "Matches that have kicked off and were not cancelled, Warsaw excluded.",
      players_all_time: "Distinct people who have played at least one match (staff, test and fake accounts excluded; a re-registered person counted once), Warsaw excluded.",
      price_per_match_cents: "Lowest and highest public per-match price among counting matches, in cents.",
      membership_monthly_cents: "Not yet known per city; null.",
      neighborhood: "Not stored by MatchDay; null.",
    },
    totals: {
      live_cities: cities.filter((c) => c.status === "live").length,
      launching_cities: cities.filter((c) => c.status === "launching").length,
      live_fields: cities.reduce((s, c) => s + c.fields.filter((f) => f.status === "live").length, 0),
      upcoming_fields: cities.reduce((s, c) => s + c.fields.filter((f) => f.status === "upcoming").length, 0),
      matches_all_time: [...inp.cityTotals].filter(([a]) => !EXCLUDED_CITY_ABBRS.has(a)).reduce((s, [, t]) => s + t.matchesAllTime, 0),
      players_all_time: inp.playersAllTime,
    },
    cities,
  };
}
