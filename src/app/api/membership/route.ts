// GET /api/membership — everything the Membership page draws, in one read.
//
// CONFINEMENT IS REFUSED AT THIS ROUTE, on the identity from the database. This page shows player
// COMPOSITION BY CITY, so a confined account naming another city gets a 403 — not a hidden chip.
// A city code is a string; hiding a filter is a shorter menu.
//
// SAY WHAT IS ACTUALLY TRUE TODAY: no confined account reaches this route, because assertConfinedRoute
// inside the capability gate refuses any path outside the six Match Ops pages and /api/membership is
// not one of them. So the page is confined today by being CLOSED, not by being scoped.
//
// The scope check is here anyway and is not decoration: the moment the gate widens — a Membership
// grant for a city manager is an obvious next ask — this route is already correct, and the failure
// mode of adding the grant first and the scoping later is another city's player composition on
// screen. assertScope REFUSES a confined account naming another city rather than silently
// re-pointing it, which is the rule the Player Finder learned by turning confinement into an
// intersection and losing nine Warsaw signups.

import { authenticateCapability } from "@/lib/capabilityAuth";
import { includedLinks } from "@/lib/venueLinkFilter";
import { assertScope } from "@/lib/cityConfinement";
import { countActiveMembers } from "@/lib/membershipStats";
import { makeServerClient } from "@/lib/supabaseServer";
import { fetchLegacyMatchRegistrations, loadMembershipWindowsByUserId } from "@/lib/mdapiMatchesRead";
import { classify, CHURN_DAYS, type SpotRow } from "@/lib/membershipModel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const monthKey = (iso: string) => {
  const d = new Date(iso);
  return `${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};
/** N months ending at `end` inclusive, oldest first. */
function monthsBack(endIso: string, n: number): string[] {
  const d = new Date(endIso); const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
    out.push(`${MON[x.getUTCMonth()]} ${x.getUTCFullYear()}`);
  }
  return out;
}

export async function GET(req: Request) {
  /* THE CAPABILITY GATE, NOT THE ADMIN ONE. matchops-auth-test caught this: authenticateAdmin
   * guards the User access screen and the Fields admin, and every route it holds is under /admin/.
   * Using it here would have refused anyone who holds can_access_membership WITHOUT is_admin —
   * which is the entire population this page was split out for on 2026-08-02. The census failing
   * was the check behaving exactly as designed. */
  const auth = await authenticateCapability(req, "membership");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const url = new URL(req.url);
  const askedCity = url.searchParams.get("city");
  const confined = auth.confinedCity;
  /* assertScope REFUSES a confined account naming another city rather than silently re-pointing
   * it — the rule the Player Finder learned the hard way when forcing the value turned confinement
   * into an intersection. */
  const sc = assertScope(confined, askedCity === "all" ? null : askedCity, confined !== null);
  if (!sc.ok) return Response.json({ error: sc.error }, { status: sc.status });
  /* SCOPE IS A CITY CODE. EVERY CONSUMER BELOW EXPECTS ONE — the mdapi_subscriptions filter is
   * `.eq("city_identifier", …)` and that column holds ATX / DFW / HOU, and the two display-name
   * conversions further down are written as code -> display. But the CITY DROPDOWN emits the
   * DISPLAY name, because it is built from fin_venues.city ("Dallas", "St. Louis"). So a picked
   * city arrived here as "Dallas", was compared against "DFW", and matched nothing.
   *
   * EVERY CITY WAS BROKEN, not just Dallas — Austin returned 0 too. The single exception was OKC,
   * where the display name and the code are the same five characters, which is exactly the kind of
   * coincidence that makes a bug look like it works.
   *
   * THIS WAS NOT VISIBLE BEFORE the tiles moved onto the live count: the all-time chart reads the
   * snapshot's by_city map, whose lookup ends in `?? scopeCity` and so landed on the display name
   * it needed by accident. The chart kept plotting Dallas while every live figure beside it read
   * zero — which is why the fix is ONE line here and not a patch at each reader. */
  const scopeCity = cityCodeOf(confined ?? (askedCity && askedCity !== "all" ? askedCity : null));
  const fieldId = Number(url.searchParams.get("field") ?? "") || null;

  const sb = makeServerClient();
  try {
    const endIso = new Date().toISOString();
    const months = monthsBack(endIso, 4);
    const from = new Date(Date.UTC(new Date(endIso).getUTCFullYear(), new Date(endIso).getUTCMonth() - 3, 1));

    const [venuesRes, linksRes, subsWin] = await Promise.all([
      sb.from("fin_venues").select("id,venue_name,city"),
      // `*` and the shared filter: 0155 added excluded_from_venue, code deploys before migrations
      // apply, and an excluded field must not count toward its venue here either.
      sb.from("fin_venue_fields").select("*"),
      loadMembershipWindowsByUserId(sb),
    ]);
    const venues = venuesRes.data ?? [];
    const links = includedLinks(linksRes.data);  // an excluded field does not count toward its venue
    const vById = new Map(venues.map((v) => [v.id, v]));
    const venueOfField = new Map(links.map((l) => [l.mdapi_field_id, l.fin_venue_id]));
    const fieldName = new Map(links.map((l) => [l.mdapi_field_id, l.field_title_at_link]));

    const regs = await fetchLegacyMatchRegistrations(
      sb, { fromDate: from.toISOString().slice(0, 10), toDate: endIso.slice(0, 10) }, subsWin,
    );

    // City for a registration comes from the venue its field is linked to — the same mapping the
    // finance surfaces use, never an ILIKE on a title.
    const rows: SpotRow[] = [];
    const days: { day: string; cls: ReturnType<typeof classify> }[] = [];
    for (const r of regs) {
      if (r.match_canceled) continue;
      const vid = r.field_id != null ? venueOfField.get(r.field_id) : undefined;
      const city = vid != null ? (vById.get(vid)?.city ?? null) : null;
      if (scopeCity && cityCodeOf(city) !== scopeCity) continue;
      if (fieldId && r.field_id !== fieldId) continue;
      rows.push({
        month: monthKey(r.match_start), cls: classify(r.payment_type),
        city, fieldId: r.field_id ?? null, amount: Number(r.match_price_paid ?? 0) || 0,
        userId: r.user_id != null ? String(r.user_id) : null,
        matchApiId: r.match_api_id ?? null,
      });
      /* THE DAY GRAIN, for the 100% stacked mix. match_start is LOCAL WALL CLOCK wearing a Z — the
       * day is read off the string, never through new Date(), which would re-shift it and move a
       * 7pm match into the next day. */
      days.push({ day: String(r.match_start).slice(0, 10), cls: classify(r.payment_type) });
    }

    // ACTIVE MEMBERS — mdapi_subscriptions.status = 'ACTIVE'. Two values exist in production
    // (ACTIVE 451 / CANCELED 2,225) despite the schema comment claiming nine.
    /* PAGED. A bare select caps at 1,000 rows and there are 2,676 subscriptions — the first cut
     * of this returned 217 active where the truth is 451, and 217 is a plausible-looking number,
     * which is the worst kind of wrong. */
    const subs: { status: string | null }[] = [];
    for (let off = 0; ; off += 1000) {
      let q = sb.from("mdapi_subscriptions")
        .select("membership_id,city_identifier,status,price,member_email,activation_date,canceled_at")
        .order("membership_id").range(off, off + 999);
      if (scopeCity) q = q.eq("city_identifier", scopeCity);
      const { data, error } = await q;
      if (error) throw new Error(`mdapi_subscriptions read failed: ${error.message}`);
      subs.push(...(data ?? []));
      if ((data ?? []).length < 1000) break;
    }
    /* TWO NUMBERS FROM ONE FETCH, and they are DIFFERENT QUESTIONS said out loud:
     *
     *   activeMembers      — every row with status ACTIVE. 455 today. A denominator: it includes
     *                        64 subscriptions priced at 0 and 40 @playmatchday.com staff accounts.
     *                        The chart line says so; it is not the headline.
     *   activeMembersPaid  — paying, external, activated. 387 today. THE headline, and the same
     *                        function the Home tile now calls (membershipStats.countActiveMembers)
     *                        and the same predicate members_monthly_snapshots.active_count is
     *                        built from.
     *
     * THE TILE READS THE LIVE ONE, NOT THE SNAPSHOT ROW IT USED TO. The snapshot for the current
     * month is recomputed nightly, so the tile was showing last night's recomputation while Home
     * showed this second — one number in name and two in practice, on top of the predicate gap.
     * The monthly BARS still read the snapshot series; those are history and should not move. */
    const activeMembers = subs.filter((s) => s.status === "ACTIVE").length;
    const activeMembersPaid = countActiveMembers(subs, new Date());
    /* THE FIELD FILTER CANNOT REACH THIS NUMBER, and that is a property of the data, not a bug to
     * fix here: mdapi_subscriptions has city_identifier and NO field column. A membership is
     * bought from a city, not from a pitch. `fieldId` is applied to the match/spot rows above
     * (which do carry field_id) and legitimately scopes every chart on this page; it is silently
     * ignored by the member count, which is a DIFFERENT defect from the city one — an absent
     * filter rather than a wrong one, and one no filter can supply.
     *
     * So the count stays CITY-scoped and says so, rather than being quietly presented as if it
     * were the members of one field. */
    const membersScope: "network" | "city" = scopeCity ? "city" : "network";

    // MEMBERSHIP REVENUE — AN EXPLICIT CATEGORY, never a residual. fin_revenue.type='Membership'.
    let revQ = sb.from("fin_revenue").select("month,city,net,type").eq("type", "Membership");
    const rev = (await revQ).data ?? [];
    const revByMonth = new Map<string, number>();
    for (const r of rev) {
      if (scopeCity && cityCodeOf(r.city as string) !== scopeCity) continue;
      revByMonth.set(String(r.month), (revByMonth.get(String(r.month)) ?? 0) + Number(r.net ?? 0));
    }

    // ALL-TIME ACTIVE SERIES — the existing captured series, unchanged.
    /* THE EXISTING CAPTURED SERIES, UNCHANGED — same table, same column, same meaning. The columns
     * are `month` and `active_count`; the first cut of this ordered by `month_start` and selected
     * `active_members`, neither of which exists, so the query errored and the chart drew nothing.
     * An empty chart and a broken query look identical. */
    // The churn source, paged — 30k+ players and a bare select caps at 1,000.
    const profiles: { last_match_date: string | null; last_match_city: string | null }[] = [];
    for (let off = 0; ; off += 1000) {
      let q = sb.from("growth_player_profile").select("last_match_date,last_match_city").order("user_id").range(off, off + 999);
      if (scopeCity) q = q.eq("last_match_city", Object.keys(CODE).find((k) => CODE[k] === scopeCity) ?? scopeCity);
      const { data, error } = await q;
      if (error) throw new Error(`growth_player_profile read failed: ${error.message}`);
      profiles.push(...(data ?? []));
      if ((data ?? []).length < 1000) break;
    }

    const snapRes = await sb.from("members_monthly_snapshots")
      .select("month,active_count,by_city,avg_matches_per_member").order("month");
    if (snapRes.error) throw new Error(`members_monthly_snapshots read failed: ${snapRes.error.message}`);
    const snaps = (snapRes.data ?? []).map((r) => {
      // A city-scoped view reads that city's own captured count, never the estate's.
      const byCity = (r.by_city ?? {}) as Record<string, { active?: number }>;
      const cityDisplay = scopeCity ? Object.keys(CODE).find((k) => CODE[k] === scopeCity) ?? scopeCity : null;
      const value = cityDisplay ? Number(byCity[cityDisplay]?.active ?? 0) : Number(r.active_count ?? 0);
      return { month: String(r.month).slice(0, 10), value, avgMatches: r.avg_matches_per_member };
    });

    /* THE BREAKDOWN'S THREE VIEWS. Computed server-side over the same rows the charts draw, so the
     * toggle cannot show a different population from the bars above it. */
    const newest = months[months.length - 1];
    const groupBy = (pick: (r: SpotRow) => string | null) => {
      const m = new Map<string, { member: number; daily: number; promo: number }>();
      for (const r of rows) {
        if (r.month !== newest) continue;
        const k = pick(r); if (!k) continue;
        const g = m.get(k) ?? { member: 0, daily: 0, promo: 0 };
        if (r.cls === "MEMBER") g.member++; else if (r.cls === "DAILY PAID") g.daily++; else if (r.cls === "PROMOCODE") g.promo++;
        m.set(k, g);
      }
      return [...m].map(([name, v]) => ({ name, ...v })).sort((a, b) => (b.member + b.daily + b.promo) - (a.member + a.daily + a.promo));
    };

    const dayMix = (() => {
      const m = new Map<string, { member: number; daily: number; promo: number }>();
      for (const d of days) {
        if (!d.day.startsWith(monthIsoPrefix(newest))) continue;
        const g = m.get(d.day) ?? { member: 0, daily: 0, promo: 0 };
        if (d.cls === "MEMBER") g.member++; else if (d.cls === "DAILY PAID") g.daily++; else if (d.cls === "PROMOCODE") g.promo++;
        m.set(d.day, g);
      }
      return [...m].sort().map(([day, v]) => ({ day, ...v, total: v.member + v.daily + v.promo }));
    })();

    /* CHURNED PLAYERS — the SAME measure /api/lifecycle/churn already uses: days since
     * last_match_date, with the 90-day floor that route defaults to. Counted at the end of the
     * newest month and at the end of the one before, so the MoM figure compares two like windows.
     *
     * IT IS A PLAYER MEASURE, NOT A MEMBERSHIP STATUS. A member who stops playing while still
     * paying is churned here and active on the tile beside it. Both are true; they are not the
     * same question, and the tile says so rather than letting the two numbers look like one.
     *
     * A count of ZERO is reported as zero. It is the ABSENCE of a prior month that makes the MoM
     * null — the same rule the all-time line's first point follows. */
    const churnAt = (endIso: string): number => {
      const cut = Date.parse(endIso) - CHURN_DAYS * 86400000;
      let n = 0;
      for (const p of profiles) {
        const lm = p.last_match_date ? Date.parse(String(p.last_match_date)) : NaN;
        if (!Number.isFinite(lm)) continue;          // never played is not churned
        if (lm > Date.parse(endIso)) continue;       // had not happened yet at that point
        if (lm <= cut) n++;
      }
      return n;
    };
    const endOfNewest = monthEndIso(newest);
    const endOfPrior = monthEndIso(months[months.length - 2] ?? newest);
    const churnedNow = churnAt(endOfNewest);
    const churnedPrior = months.length > 1 ? churnAt(endOfPrior) : 0;

    /* ACTIVE MEMBERS PER MONTH, FROM THE SNAPSHOT — the SAME source the all-time chart reads.
     *
     * The first cut sent one number, the LIVE mdapi_subscriptions count, and the page repeated it
     * across every month: 451 for May, June, July and August alike. Two charts on one page then
     * gave two answers for August — 451 on the bars, 383 on the line — and the avg-matches series
     * was a numerator that moved over a denominator that did not, which renders as a trend and is
     * an artifact. */
    const activeByMonth: Record<string, number> = {};
    for (const sn of snaps) activeByMonth[monthLabelFromIso(sn.month)] = sn.value;

    /* PARTIAL PERIODS MUST SAY SO. August is 26 of 31 days; avg matches per member "falling" from
     * 6.1 to 4.0 is mostly days that have not happened yet. A partial period rendered identically
     * to a complete one reads as a collapse. */
    const now = new Date();
    const nowLabel = `${MON[now.getUTCMonth()]} ${now.getUTCFullYear()}`;
    const daysInMonth = (key: string) => {
      const [mon, yr] = key.split(" ");
      return new Date(Date.UTC(Number(yr), MON.indexOf(mon) + 1, 0)).getUTCDate();
    };
    const partial: Record<string, { elapsed: number; total: number }> = {};
    for (const m of months) {
      const total = daysInMonth(m);
      partial[m] = m === nowLabel ? { elapsed: now.getUTCDate(), total } : { elapsed: total, total };
    }

    return Response.json({
      activeByMonth, partial, currentMonth: nowLabel,
      churnedNow, churnedPrior, hasPriorMonth: months.length > 1,
      months,
      rows,
      dayMix,
      byCity: groupBy((r) => r.city),
      byField: groupBy((r) => (r.fieldId != null ? (fieldName.get(r.fieldId) ?? String(r.fieldId)) : null)),
      activeMembers,
      activeMembersPaid, membersScope, fieldScoped: fieldId != null,
      revenueByMonth: Object.fromEntries(revByMonth),
      snapshots: snaps,
      churnDays: CHURN_DAYS,
      scope: scopeCity, confined: confined !== null,
      cities: [...new Set(venues.map((v) => v.city).filter(Boolean))].sort(),
      fields: [...venueOfField.keys()]
        .filter((fid) => {
          if (!scopeCity) return true;
          const vid = venueOfField.get(fid)!;
          return cityCodeOf(vById.get(vid)?.city ?? null) === scopeCity;
        })
        .map((fid) => ({ fieldId: fid, name: fieldName.get(fid) ?? String(fid) }))
        .sort((a, b) => String(a.name).localeCompare(String(b.name))),
    });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message.slice(0, 200) : "read failed" }, { status: 500 });
  }
}

/** fin_venues stores DISPLAY names ("Austin"); confinement uses codes ("ATX"). One mapping. */
const CODE: Record<string, string> = {
  Austin: "ATX", Dallas: "DFW", Houston: "HOU", "San Antonio": "SATX",
  Atlanta: "ATL", OKC: "OKC", "St. Louis": "STL", Warsaw: "WAW",
};
const cityCodeOf = (display: string | null): string | null => (display ? CODE[display] ?? display : null);

/** "2026-08-01" -> "Aug 2026". String surgery; a captured month is a label, not an instant. */
const monthLabelFromIso = (ymd: string) => `${MON[Number(ymd.slice(5, 7)) - 1]} ${ymd.slice(0, 4)}`;

/** "Aug 2026" -> the last instant of that month, as an ISO day. */
function monthEndIso(key: string): string {
  const [mon, yr] = key.split(" ");
  const y = Number(yr), m = MON.indexOf(mon) + 1;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${String(m).padStart(2, "0")}-${String(last).padStart(2, "0")}T23:59:59.999Z`;
}

/** "Aug 2026" -> "2026-08". String maths on the label; no Date parsing, so no wall-clock re-shift. */
function monthIsoPrefix(key: string): string {
  const [mon, yr] = key.split(" ");
  return `${yr}-${String(MON.indexOf(mon) + 1).padStart(2, "0")}`;
}
