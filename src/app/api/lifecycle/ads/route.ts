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
  buildAdsOverview, type AcqRow, type DimRow, type FlatRow, type GeoRow,
} from "@/lib/adsOverview";

export const runtime = "nodejs";
export const maxDuration = 60;

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: Request) {
  const auth = await authenticateLifecycle(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const url = new URL(req.url);
  const q = (k: string) => { const v = url.searchParams.get(k); return v && YMD.test(v) ? v : null; };
  /* THE FLOOR IS THE DEFAULT AND ALSO THE CLAMP. The ad-set tables start at 2026-08-01 because the
   * campaign structure was rebuilt then; a window reaching earlier is not empty, it is a DIFFERENT
   * ACCOUNT, and returning its rows beside these would put two structures under one heading. */
  const since = (() => { const s = q("since"); return s && s > META_ADSET_FLOOR_YMD ? s : META_ADSET_FLOOR_YMD; })();
  const until = q("until") ?? new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });

  if (until < since) return Response.json({ error: "until is before since" }, { status: 400 });

  try {
    const sb = auth.supabase;
    const [geo, flat, dim, acq] = await Promise.all([
      selectAll<GeoRow>(() => sb.from("fin_meta_adset_market_daily")
        .select("spend_date, adset_id, market_raw, market_key, spend_cents, clicks")
        .gte("spend_date", since).lte("spend_date", until).order("spend_date")),
      selectAll<FlatRow>(() => sb.from("fin_meta_adset_daily")
        .select("spend_date, adset_id, spend_cents, installs, clicks, registrations")
        .gte("spend_date", since).lte("spend_date", until).order("spend_date")),
      selectAll<DimRow>(() => sb.from("fin_meta_adset")
        .select("adset_id, adset_name, campaign_name, market_key, market_raw, market_confidence")
        .order("adset_id")),
      /* THE PLAYER SIDE IS ALREADY ON AMERICA/CHICAGO (0185), which is the same wall clock as
       * Meta's America/Bogota from March to November and one hour off the rest of the year. On UTC
       * it would be five to six hours out, and 24.9% of signups fall on a different day. */
      selectAll<AcqRow>(() => sb.from("growth_acquisition_daily")
        .select("signup_date, declared_city_raw, registrations, became_players, played_within_7d, played_within_30d")
        .gte("signup_date", since).lte("signup_date", until).order("signup_date")),
    ]);

    const payload = buildAdsOverview({ geo, flat, dim, acq });
    return Response.json({ since, until, ...payload, generatedAt: new Date().toISOString() }, {
      status: 200,
      headers: { "Cache-Control": "private, max-age=60, stale-while-revalidate=300" },
    });
  } catch (e) {
    console.error("[api/lifecycle/ads] failed", e);
    return Response.json({ error: "Failed to build the ads overview" }, { status: 500 });
  }
}
