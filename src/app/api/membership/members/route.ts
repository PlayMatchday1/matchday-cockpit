// THE MEMBERS PAGE — list, search, CSV and city settings, all reads.
//
//   GET ?env=production|staging&city=ATX&tab=current&page=1      one page of one tab, with counts
//   GET ?env=…&q=garcia&city=ATX                                  search: EVERY city, EVERY status
//   GET ?env=…&city=ATX&tab=current&format=csv                    the current filter, every page
//
// THE GATE IS THE MEMBERSHIP CAPABILITY, the same one /api/membership uses: anyone who can open the
// Membership section can read members. Writes are separate routes with their own grants.
//
// SEARCH NEVER REACHES MATCHDAY. It runs in memory over rows this route already loaded (production:
// our mirror). MatchDay's list endpoint pastes `email` into raw SQL (subscriptions.repository.ts:53-54
// at backend 8965437), so the search text is never sent to it — not on production, not on staging.
//
// A CONFINED ACCOUNT sees its own city only: the picker is pinned, and search is narrowed to that
// city. Frame 6 says "every city"; confinement wins over the design.
import { authenticateCapability } from "@/lib/capabilityAuth";
import { assertScope } from "@/lib/cityConfinement";
import { resolveCityScope, cityNameFor, CITY_SCOPES } from "@/lib/cityScope";
import { makeServerClient } from "@/lib/supabaseServer";
import { countActiveMembers } from "@/lib/membershipStats";
import { loadMemberRows, loadRowStripe, readCitySettings } from "@/lib/membersPageData";
import {
  TABS, tabCounts, tabRows, pageOf, searchMembers, searchSummary, membersCsv, nextCell, statusChip,
  listPriceLabel, daysSince, type Tab, type MemberRow, type RowStripe,
} from "@/lib/membersPageModel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const isEnv = (x: string | null): x is "production" | "staging" => x === "production" || x === "staging";
const isTab = (x: string | null): x is Tab => TABS.some((t) => t.tab === x);

export async function GET(req: Request) {
  const auth = await authenticateCapability(req, "membership");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const url = new URL(req.url);
  const env = url.searchParams.get("env");
  if (!isEnv(env)) return Response.json({ error: "env must be production or staging" }, { status: 400 });

  const confined = auth.confinedCity;
  const askedCity = url.searchParams.get("city");
  const sc = assertScope(confined, askedCity, confined !== null);
  if (!sc.ok) return Response.json({ error: sc.error }, { status: sc.status });
  const city = confined ?? resolveCityScope(askedCity)?.identifier ?? null;
  if (!city) return Response.json({ error: "Pick a city." }, { status: 400 });

  const sb = makeServerClient();
  const now = Date.now();
  try {
    const { rows: all, syncedAt, source } = await loadMemberRows(env, sb, url.searchParams.get("fresh") === "1");
    const settings = url.searchParams.get("settings") === "0" ? null : await readCitySettings(env, city);
    const planCents = settings?.planCents ?? null;

    const view = (rows: readonly MemberRow[], stripe: Map<number, RowStripe>, plan: (c: string) => number | null) =>
      rows.map((r) => ({
        ...r,
        name: [r.firstName, r.lastName].filter(Boolean).join(" ") || "(no name)",
        cityName: cityNameFor(r.city) ?? r.city,
        chip: statusChip(r, now, plan(r.city)),
        next: nextCell(r, stripe.get(r.membershipId), now, plan(r.city)),
        days: daysSince(r.activationDate, now),
        listPrice: listPriceLabel(r, plan(r.city)),
        hasComment: !!(r.comment ?? "").trim(),
        stripe: stripe.get(r.membershipId) ?? null,
      }));

    /* ── SEARCH ───────────────────────────────────────────────────────────────────────────── */
    const q = (url.searchParams.get("q") ?? "").trim();
    if (q) {
      const pool = confined ? all.filter((r) => r.city === confined) : all;
      const hits = searchMembers(pool, q);
      const stripe = await loadRowStripe(sb, env, hits.map((h) => h.membershipId));
      /* The plan price of a result's OWN city is only known for the picked one; other cities show
       * whole dollars (and no Custom price chip) rather than a guess. */
      const plan = (c: string) => (c === city ? planCents : null);
      return Response.json({
        mode: "search", env, source, syncedAt, q, city,
        summary: searchSummary(hits, cityNameFor(city) ?? city),
        confinedTo: confined, rows: view(hits, stripe, plan),
      });
    }

    /* ── ONE TAB OF ONE CITY ──────────────────────────────────────────────────────────────── */
    const tabParam = url.searchParams.get("tab");
    const tab: Tab = isTab(tabParam) ? tabParam : "current";
    const cityRows = all.filter((r) => r.city === city);
    const counts = tabCounts(cityRows, now);
    const inTab = tabRows(all, city, tab, now);

    if (url.searchParams.get("format") === "csv") {
      const stripe = await loadRowStripe(sb, env, inTab.map((r) => r.membershipId));
      const body = membersCsv(inTab, stripe, now, planCents);
      const stamp = new Date().toISOString().slice(0, 10);
      return new Response(body, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="members-${city}-${tab}-${stamp}.csv"`,
          "Cache-Control": "no-store",
        },
      });
    }

    const pg = pageOf(inTab, Number(url.searchParams.get("page") ?? 1));
    const stripe = await loadRowStripe(sb, env, pg.rows.map((r) => r.membershipId));
    return Response.json({
      mode: "list", env, source, syncedAt, city, tab, counts, confinedTo: confined,
      cities: confined ? CITY_SCOPES.filter((c) => c.identifier === confined) : CITY_SCOPES,
      settings: settings && { ...settings, payingCount: countActiveMembers(cityMirrorShape(cityRows), new Date(now)) },
      page: pg.page, pages: pg.pages, total: pg.total,
      rows: view(pg.rows, stripe, () => planCents),
    });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

/** countActiveMembers takes the mirror's own field names; this maps a normalised row back. */
function cityMirrorShape(rows: readonly MemberRow[]) {
  return rows.map((r) => ({
    status: r.status, price: r.priceDollars, member_email: r.email,
    activation_date: r.activationDate, canceled_at: r.canceledAt, city_identifier: r.city,
  }));
}
