/* GET /api/lifecycle/churn — the Churn page (rebuilt 2026-11-09). READ ONLY.
 *
 * Query: days (30|60|90|120|180, 180 = 180+), since (YYYY-MM-DD, default Jan 1 this year), city (short code or
 * "all"), field (venue key or "all"), tier (all|heavy|regular|tried), sort (churnModel SORT_KEYS), dir (asc|desc),
 * page. ?format=csv streams every row of the filtered tier with the SAME columns as the table (churnModel.columns).
 *
 * The rules (what a match is, what spent is, what the sentence means) are in churnModel.ts; the reads and the
 * caching in churnLoad.ts. Former staff and deleted accounts are left out before anything is counted, and the
 * response says how many. */
import { authenticateLifecycle } from "@/lib/lifecycleAuth";
import {
  DAYS_OPTIONS, DEFAULT_DAYS, DEFAULT_SORT, SORT_KEYS, TIERS, applyFilter, columns, defaultSince, sortShown, tierCounts, toCsv,
  type Display, type SortDir, type SortKey, type Tier,
} from "@/lib/churnModel";
import { formerStaff, liveVenueKeys, loadBase, winbacks } from "@/lib/churnLoad";

export const runtime = "nodejs";
export const maxDuration = 60;
const PAGE_SIZE = 12;

const chicagoToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());

export async function GET(req: Request) {
  const auth = await authenticateLifecycle(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const sp = new URL(req.url).searchParams;
  const today = chicagoToday();
  const daysRaw = Number(sp.get("days") ?? DEFAULT_DAYS);
  const days = (DAYS_OPTIONS as readonly number[]).includes(daysRaw) ? daysRaw : DEFAULT_DAYS;
  const sinceRaw = sp.get("since");
  const since = sinceRaw && /^\d{4}-\d{2}-\d{2}$/.test(sinceRaw) ? sinceRaw : defaultSince(today);
  const cityRaw = sp.get("city");
  const fieldRaw = sp.get("field");
  const tierRaw = sp.get("tier");
  const tier: Tier | null = (TIERS as string[]).includes(String(tierRaw)) ? (tierRaw as Tier) : null;
  const sortRaw = sp.get("sort");
  const sort: SortKey = (SORT_KEYS as readonly string[]).includes(String(sortRaw)) ? (sortRaw as SortKey) : DEFAULT_SORT.key;
  const dir: SortDir = sp.get("dir") === "asc" ? "asc" : sp.get("dir") === "desc" ? "desc" : DEFAULT_SORT.dir;
  const page = Math.max(0, Number(sp.get("page") ?? 0) || 0);

  try {
    const [base, staff, live] = await Promise.all([loadBase(auth.supabase, sp.get("fresh") === "1"), formerStaff(auth.supabase), liveVenueKeys(auth.supabase)]);
    const cityName = (c: string | null) => base.cities.find((x) => x.code === c)?.name ?? (c ?? "");
    const people = base.people.filter((p) => !staff.has(p.id) && !base.contact.get(p.id)?.scrubbed);
    const staffPeople = base.people.filter((p) => staff.has(p.id));
    const deletedPeople = base.people.filter((p) => !staff.has(p.id) && base.contact.get(p.id)?.scrubbed);

    const city = cityRaw && cityRaw !== "all" && base.cities.some((c) => c.code === cityRaw) ? cityRaw : null;
    // Everyone in range in this city, before the field: the field list and its counts come from this set.
    const inCity = applyFilter(people, { days, since, city, field: null, today });
    const fieldNum = fieldRaw && fieldRaw !== "all" && /^-?\d+$/.test(fieldRaw) ? Number(fieldRaw) : null;
    const field = fieldNum != null && inCity.some((r) => r.fieldKey === fieldNum) ? fieldNum : null;
    const scoped = field == null ? inCity : applyFilter(people, { days, since, city, field, today });

    // Cities: the Daily Matches list, and Philadelphia (or any other) only when it has players in range.
    const inRangeAll = applyFilter(people, { days, since, city: null, field: null, today });
    const cityCount = new Map<string, number>();
    for (const r of inRangeAll) if (r.city) cityCount.set(r.city, (cityCount.get(r.city) ?? 0) + 1);
    const cities = base.cities.filter((c) => c.code !== "PHL" || (cityCount.get(c.code) ?? 0) > 0)
      .map((c) => ({ code: c.code, name: c.name, players: cityCount.get(c.code) ?? 0 }));

    // Fields: usual fields in range here, live ones only (the retired duplicates are already folded into
    // their real venue by churn_player_field).
    const fieldMap = new Map<number, { key: number; label: string; players: number }>();
    for (const r of inCity) {
      if (live && !live.has(r.fieldKey)) continue;
      const e = fieldMap.get(r.fieldKey) ?? fieldMap.set(r.fieldKey, { key: r.fieldKey, label: r.field, players: 0 }).get(r.fieldKey)!;
      e.players++;
    }
    const fields = [...fieldMap.values()].sort((a, b) => a.label.localeCompare(b.label));

    const counts = tierCounts(scoped);
    // Who the same filter would have listed but is left out, so the page can say so.
    const sameFilter = { days, since, city, field, today };
    const staffOut = applyFilter(staffPeople, sameFilter).length;
    const deleted = applyFilter(deletedPeople, sameFilter).length;
    const inTier = tier ? scoped.filter((r) => r.tier === tier) : scoped;
    const named = inTier.map((r) => ({ ...r, name: base.contact.get(r.id)?.name ?? null }));
    const sorted = sortShown(named, sort, dir);
    const fieldScoped = field != null;

    const pick = sp.get("format") === "csv" ? sorted : sorted.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
    const wb = await winbacks(auth.supabase, pick.map((r) => r.id));
    const rows: Display[] = pick.map((r) => ({ ...r, phone: base.contact.get(r.id)?.phone ?? null, winback: wb.get(r.id) ?? { state: "none" } }));

    if (sp.get("format") === "csv") {
      return new Response(toCsv(rows, fieldScoped, cityName), {
        status: 200,
        headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="churn-${days}d-since-${since}.csv"` },
      });
    }
    return Response.json({
      today, refreshedAt: base.refreshedAt,
      filter: { days, since, city, field, tier, sort, dir },
      cities, fields, liveFieldsKnown: live != null,
      counts, total: inTier.length, page, pageSize: PAGE_SIZE,
      columns: columns(fieldScoped).map((c) => ({ key: c.key, label: c.label })),
      rows: rows.map((r) => ({ ...r, cityName: cityName(r.city) })),
      excluded: { formerStaff: staffOut, deleted },
    });
  } catch (e) {
    console.error("[api/lifecycle/churn] failed", e);
    return Response.json({ error: e instanceof Error ? e.message : "Failed to load churn" }, { status: 500 });
  }
}
