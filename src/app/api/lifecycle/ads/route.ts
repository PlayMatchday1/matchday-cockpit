/* GET /api/lifecycle/ads?since=YYYY-MM-DD&until=YYYY-MM-DD
 *
 * The Ads Overview payload. A SERVER ROUTE AND NOT A CLIENT READ, because every table it touches is
 * granted to service_role only — fin_meta_adset*, fin_meta_install_observations and
 * growth_acquisition_daily are all `revoke all from anon, authenticated` (0184, 0185, 0187). A
 * browser holding the publishable key gets nothing from any of them, by design.
 *
 * Gated on can_access_lifecycle via authenticateLifecycle, the same as every other page in this
 * section. Read-only: this route never writes.
 */

import { authenticateLifecycle } from "@/lib/lifecycleAuth";
import { selectAll } from "@/lib/supabasePagination";
import { META_ADSET_FLOOR_YMD } from "@/lib/metaAdSpend";
import {
  buildAdsOverview, DECLARED_CITY_TO_KEY, META_REG_FROM, PAID_MARKETS, type AcqRow, type DimRow, type FlatRow, type GeoRow,
} from "@/lib/adsOverview";

export const runtime = "nodejs";
export const maxDuration = 60;

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: Request) {
  const auth = await authenticateLifecycle(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const url = new URL(req.url);
  const q = (k: string) => { const v = url.searchParams.get(k); return v && YMD.test(v) ? v : null; };
  /* THE FLOOR CLAMPS META, NOT US (Acquisition page, Ryan 2026-10-04). The ad-set tables start at
   * 2026-08-01 because the campaign structure was rebuilt then; a window reaching earlier is not
   * empty, it is a DIFFERENT ACCOUNT, so Meta's columns never reach before it. Our own counts do:
   *   main   Meta + our counts over metaSince..until (cost per new player divides like by like)
   *          — null when the whole range is before the rebuild
   *   ours   All registrations and New players per market over the WHOLE requested range
   *   reg    Meta's registrations and the spend beside them from Sep 12, when the range starts
   *          earlier — shown labelled "since Sep 12" instead of a dash */
  const requested = q("since") ?? META_ADSET_FLOOR_YMD;
  const until = q("until") ?? new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  const since = requested > META_ADSET_FLOOR_YMD ? requested : META_ADSET_FLOOR_YMD;   // Meta's window
  const metaCovered = until >= since;

  if (until < requested) return Response.json({ error: "until is before since" }, { status: 400 });

  try {
    const sb = auth.supabase;
    const none = <T,>() => Promise.resolve([] as T[]);
    const [geo, flat, dim, acqAll] = await Promise.all([
      !metaCovered ? none<GeoRow>() : selectAll<GeoRow>(() => sb.from("fin_meta_adset_market_daily")
        .select("spend_date, adset_id, market_raw, market_key, spend_cents, clicks")
        .gte("spend_date", since).lte("spend_date", until).order("spend_date")),
      !metaCovered ? none<FlatRow>() : selectAll<FlatRow>(() => sb.from("fin_meta_adset_daily")
        .select("spend_date, adset_id, spend_cents, installs, clicks, registrations")
        .gte("spend_date", since).lte("spend_date", until).order("spend_date")),
      selectAll<DimRow>(() => sb.from("fin_meta_adset")
        /* optimization_goal IDENTIFIES A REGISTRATION-OPTIMIZED AD SET (with the date rule in
         * registrationRebuildStart); attribution_spec is shown in the expansion because the
         * Atlanta Android ad set carries three windows where its six neighbours carry one, so its
         * cost per registration sits on a looser basis and must not be read like theirs. */
        .select("adset_id, adset_name, campaign_name, market_key, market_raw, market_confidence, optimization_goal, attribution_spec")
        .order("adset_id")),
      /* THE PLAYER SIDE IS ALREADY ON AMERICA/CHICAGO (0185), which is the same wall clock as
       * Meta's America/Bogota from March to November and one hour off the rest of the year. On UTC
       * it would be five to six hours out, and 24.9% of signups fall on a different day. */
      selectAll<AcqRow>(() => sb.from("growth_acquisition_daily")
        .select("signup_date, declared_city_raw, registrations, became_players, played_within_7d, played_within_30d")
        .gte("signup_date", requested).lte("signup_date", until).order("signup_date")),
    ]);

    const acq = acqAll.filter((r) => r.signup_date >= since);
    const payload = metaCovered ? buildAdsOverview({ geo, flat, dim, acq }) : null;
    const ours: Record<string, { registrations: number; becamePlayers: number }> = Object.fromEntries(PAID_MARKETS.map((m) => [m, { registrations: 0, becamePlayers: 0 }]));
    for (const r of acqAll) {
      const k = r.declared_city_raw ? DECLARED_CITY_TO_KEY[r.declared_city_raw] : undefined;
      if (!k || !ours[k]) continue;
      ours[k].registrations += Number(r.registrations); ours[k].becamePlayers += Number(r.became_players);
    }
    const regSince = since < META_REG_FROM && until >= META_REG_FROM ? META_REG_FROM : null;
    const reg = regSince ? Object.fromEntries(buildAdsOverview({
      geo: geo.filter((g) => g.spend_date >= regSince), flat: flat.filter((f) => f.spend_date >= regSince), dim,
      acq: acq.filter((a) => a.signup_date >= regSince),
    }).rows.map((r) => [r.marketKey, { metaRegistrations: r.metaRegistrations, spendCents: r.spendCents }])) : null;
    return Response.json({
      requestedSince: requested, since, until, metaCovered, ...(payload ?? {}),
      ours, regSince, reg, generatedAt: new Date().toISOString(),
    }, {
      status: 200,
      headers: { "Cache-Control": "private, max-age=60, stale-while-revalidate=300" },
    });
  } catch (e) {
    console.error("[api/lifecycle/ads] failed", e);
    return Response.json({ error: "Failed to build the ads overview" }, { status: 500 });
  }
}
