import "server-only"; // no-op under --conditions=react-server
// The server side of /admin/fields: the expensive mdapi aggregate, its cache,
// and the join onto the mapping tables. It lives here rather than in route.ts
// because BOTH routes need it — the read route renders it and the assign route
// invalidates it — and a Next route module may only export HTTP handlers.
//
// TWO HALVES, CACHED DIFFERENTLY, ON PURPOSE:
//
//   · the mdapi AGGREGATE (per-field counts, dates, money) is a ~100-page read
//     and changes only when the match sync runs — cached in-process.
//   · the MAPPING (fin_venue_fields + fin_venues) is cheap and is what this
//     page WRITES — never cached, always re-read.
//
// So an assignment is visible the instant it lands rather than a TTL later, and
// a stale cache can never make a mapping look unwritten.

import { COMBINE_BY_NAME } from "./venueGroups";
import {
  buildFieldIdIndex,
  type FieldIdRow,
  type FieldsPayload,
  type MatchAggInput,
  type PlayerAggInput,
  type VenueOption,
} from "./fieldIdAdmin";
import { isExcludedLink } from "./venueLinkFilter";
import type { SupabaseClient } from "@supabase/supabase-js";

const AGGREGATE_TTL_MS = 10 * 60 * 1000;
const PAGE = 1000; // PostgREST caps a page at 1000 whatever we ask for — stated, not assumed.

export type FieldAggregate = {
  builtAt: number;
  index: Map<number, Omit<FieldIdRow, "mapping">>;
  matchRows: number;
  playerRows: number;
};

let cached: FieldAggregate | null = null;
let inFlight: Promise<FieldAggregate> | null = null;

/** Force the next read to rebuild. Called by the assign route so a newly created
 *  venue's own totals are right immediately. */
export function invalidateFieldAggregate(): void {
  cached = null;
}

const MATCH_COLS =
  "api_id, field_id, field_title, field_address, field_zipcode, city_name, city_identifier, start_date, start_date_utc, is_cancelled";
const PLAYER_COLS = "api_id, match_api_id, amount, user_email, user_is_fake_player, is_absent";

/**
 * KEYSET PAGING, NOT OFFSET. `range(from, to)` over a table the match sync is
 * concurrently inserting into can skip or repeat a row between pages. Paging on
 * `api_id > last` cannot: inserts land above the cursor and are either seen
 * once or not at all.
 */
async function buildAggregate(sb: SupabaseClient): Promise<FieldAggregate> {
  const matches: (MatchAggInput & { api_id: number })[] = [];
  for (let last = 0; ; ) {
    const { data, error } = await sb
      .from("mdapi_matches")
      .select(MATCH_COLS)
      // deleted_at IS NULL — the phantom-match tombstone (migration 0059). A
      // deleted match is not evidence a field is in use.
      .is("deleted_at", null)
      .gt("api_id", last)
      .order("api_id")
      .limit(PAGE);
    if (error) throw new Error(`mdapi_matches: ${error.message}`);
    const rows = (data ?? []) as unknown as (MatchAggInput & { api_id: number })[];
    if (rows.length === 0) break;
    matches.push(...rows);
    last = rows[rows.length - 1].api_id;
    if (rows.length < PAGE) break;
  }

  const players: (PlayerAggInput & { api_id: number })[] = [];
  for (let last = 0; ; ) {
    const { data, error } = await sb
      .from("mdapi_match_players")
      .select(PLAYER_COLS)
      // DAILY PAID only: paid_status = 'PAID' with no promocode. A promo
      // redemption is a free spot; WAITING is a checkout that never settled.
      .eq("paid_status", "PAID")
      .is("promocode_id", null)
      .gt("api_id", last)
      .order("api_id")
      .limit(PAGE);
    if (error) throw new Error(`mdapi_match_players: ${error.message}`);
    const rows = (data ?? []) as unknown as (PlayerAggInput & { api_id: number })[];
    if (rows.length === 0) break;
    players.push(...rows);
    last = rows[rows.length - 1].api_id;
    if (rows.length < PAGE) break;
  }

  return {
    builtAt: Date.now(),
    index: buildFieldIdIndex(matches, players, Date.now()),
    matchRows: matches.length,
    playerRows: players.length,
  };
}

export async function fieldAggregate(sb: SupabaseClient, refresh = false): Promise<FieldAggregate> {
  if (!refresh && cached && Date.now() - cached.builtAt < AGGREGATE_TTL_MS) return cached;
  // Single-flight: two admins landing on the page together must not both run
  // the 100-page read.
  if (!inFlight) {
    inFlight = buildAggregate(sb)
      .then((a) => {
        cached = a;
        return a;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

type LinkRow = {
  fin_venue_id: number;
  mdapi_field_id: number;
  field_title_at_link: string | null;
  counts_as_regular_play: boolean;
  /** 0155. Optional because the read is select("*") and the column may not exist yet. */
  excluded_from_venue?: unknown;
};
type VenueRow = {
  id: number;
  venue_name: string;
  city: string | null;
  is_active: boolean | null;
  billing_type: string | null;
  per_match_rate: number | null;
  cost_per_match: number | null;
  charge_on_cancel: boolean | null;
  bills_per_reservation: boolean | null;
};

const VENUE_COLS =
  "id, venue_name, city, is_active, billing_type, per_match_rate, cost_per_match, charge_on_cancel, bills_per_reservation";

/** Join the (cached) aggregate to a FRESH read of the mapping tables. */
export async function fieldsPayload(sb: SupabaseClient, agg: FieldAggregate): Promise<FieldsPayload> {
  /* `*`, NOT A COLUMN LIST. 0155 added excluded_from_venue and code deploys before migrations
   * apply; a named column that does not exist yet 400s this whole page. isExcludedLink treats a
   * missing column as false, which is the column's default and today's behaviour. */
  const links = await sb
    .from("fin_venue_fields")
    .select("*")
    .order("mdapi_field_id");
  if (links.error) throw new Error(`fin_venue_fields: ${links.error.message}`);
  const venueRows = await sb.from("fin_venues").select(VENUE_COLS).order("venue_name");
  if (venueRows.error) throw new Error(`fin_venues: ${venueRows.error.message}`);

  const linkList = (links.data ?? []) as unknown as LinkRow[];
  const venueList = (venueRows.data ?? []) as unknown as VenueRow[];
  const venueById = new Map(venueList.map((v) => [v.id, v]));
  const linkByField = new Map(linkList.map((l) => [Number(l.mdapi_field_id), l]));

  const fields: FieldIdRow[] = [...agg.index.values()].map((f) => {
    const l = linkByField.get(f.fieldId);
    const v = l ? venueById.get(l.fin_venue_id) : undefined;
    return {
      ...f,
      mapping: l
        ? {
            venueId: l.fin_venue_id,
            // A link whose venue row is gone is a real state and says so rather
            // than rendering as UNMAPPED, which would invite a second link.
            venueName: v?.venue_name ?? `#${l.fin_venue_id} — venue row missing`,
            venueCity: v?.city ?? null,
            venueIsActive: v?.is_active === true,
            countsAsRegularPlay: l.counts_as_regular_play === true,
            // STILL LINKED, just not counted. The row keeps its venue and stays in the list.
            excludedFromVenue: isExcludedLink(l),
            titleAtLink: l.field_title_at_link ?? null,
          }
        : null,
    };
  });

  // Each venue's CURRENT totals, summed over the field IDs already linked to it,
  // so the preview shows before → after rather than only a delta.
  const totals = new Map<number, { fields: number; live: number; revenue: number }>();
  for (const l of linkList) {
    const f = agg.index.get(Number(l.mdapi_field_id));
    const t = totals.get(l.fin_venue_id) ?? { fields: 0, live: 0, revenue: 0 };
    t.fields += 1;
    t.live += f?.liveMatches ?? 0;
    t.revenue += f?.dppRevenue ?? 0;
    totals.set(l.fin_venue_id, t);
  }

  const byRawName = new Map(venueList.map((v) => [`${v.venue_name}|${v.city ?? ""}`, v]));
  const venues: VenueOption[] = venueList.map((v) => {
    const t = totals.get(v.id) ?? { fields: 0, live: 0, revenue: 0 };
    // The split-rate pairs come from venueGroups, never from a copy here.
    // Comparison is on the RAW venue_name, which is what COMBINE_BY_NAME holds.
    const cfg = COMBINE_BY_NAME.find((c) => c.primary === v.venue_name || c.secondary === v.venue_name);
    let split: VenueOption["split"] = null;
    if (cfg) {
      const partnerName = cfg.primary === v.venue_name ? cfg.secondary : cfg.primary;
      const partner = byRawName.get(`${partnerName}|${v.city ?? ""}`);
      split = {
        kind: cfg.primary === "Soccer Central" ? "capacity" : "sunday",
        partnerName,
        partnerRate: partner?.per_match_rate ?? null,
      };
    }
    return {
      id: v.id,
      venueName: v.venue_name,
      city: v.city,
      isActive: v.is_active === true,
      billingType: v.billing_type,
      perMatchRate: v.per_match_rate,
      costPerMatch: v.cost_per_match,
      chargeOnCancel: v.charge_on_cancel === true,
      billsPerReservation: v.bills_per_reservation === true,
      fieldCount: t.fields,
      liveMatches: t.live,
      dppRevenue: Math.round(t.revenue * 100) / 100,
      split,
    };
  });

  return {
    fields,
    venues,
    aggregateAt: new Date(agg.builtAt).toISOString(),
    matchRows: agg.matchRows,
    playerRows: agg.playerRows,
  };
}
