// POST /api/lifecycle/dataroom — the Player Data Room pivot + cell drill-down. One
// cached fact table (getFacts) serves both. Body.mode:
//   "pivot"   { config }            → the pivot table + filter/dim metadata
//   "cell"    { config, r, c }      → the distinct players inside one cell
//   "tableCsv"{ config }            → the pivot table as CSV
//   "cellCsv" { config, r, c }      → the cell's players as CSV
// Gated on can_access_lifecycle. Reads only; the fact table is derived from the views.
import { authenticateLifecycle } from "@/lib/lifecycleAuth";
import { getFacts, pivotCached, cellPlayers, measure, totalHeader, factCacheStats, type PivotConfig } from "@/lib/dataRoom";

export const runtime = "nodejs";
export const maxDuration = 60;

const money = (n: number) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const cell = (r: (number | null)[] | number[]) => r;
void cell;

export async function POST(req: Request) {
  const auth = await authenticateLifecycle(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const body = (await req.json().catch(() => ({}))) as { mode?: string; config?: PivotConfig; r?: string; c?: string };
  const cfg = body.config;
  if (!cfg || !Array.isArray(cfg.rows) || !cfg.rows.length) return Response.json({ error: "config.rows required" }, { status: 400 });

  try {
    /* COLD OR WARM, ON EVERY RESPONSE. `getFacts` caches per warm instance; whether a given visit
     * paid for a rebuild was invisible, which is why "what fraction of visits hit a cold instance"
     * had no answer. `wasCold` is decided by whether the build counter moved across this call. */
    const buildsBefore = factCacheStats(false).coldBuilds;
    const factT0 = Date.now();
    const F = await getFacts(auth.supabase);
    const factMs = Date.now() - factT0;
    const stats = factCacheStats(factCacheStats(false).coldBuilds > buildsBefore);

    /* CLAMP THE WINDOW TO THE MONTHS THAT EXIST, BEFORE ANYTHING READS IT.
     *
     * The client sends a sentinel window ("1900-01".."2999-12") on its very first request, because
     * it does not learn the real bounds until this response arrives. That sentinel then reached the
     * total column's header and it rendered "Jan 1900 – Dec 2999" — a window naming itself
     * truthfully and being absurd, which is the same class of defect as the total that named no
     * window at all. Clamping here means the header can only ever name months the data has, and it
     * makes the figure and the label come from one clamped value rather than two. */
    const lo = F.monthsAvailable[0] ?? cfg.filters.from;
    const hi = F.monthsAvailable[F.monthsAvailable.length - 1] ?? cfg.filters.to;
    const clamp = (m: string, d: string) => (!m || m < lo ? lo : m > hi ? hi : m) || d;
    cfg.filters = { ...cfg.filters, from: clamp(cfg.filters.from, lo), to: clamp(cfg.filters.to, hi) };

    if (body.mode === "cell" || body.mode === "cellCsv") {
      const base = cellPlayers(F.facts, cfg, String(body.r), String(body.c ?? "__all__"));
      /* NAME AND PHONE FOR THE DRAWER. The fact table carries a user_id and nothing else — it is
       * built for arithmetic, not for identity — so a drill-down that only printed "ID 60019" was
       * a list nobody could act on. They come from the MIRROR (mdapi_users), in ONE query over the
       * ids already in the cell, so the cost is bounded by the cell and not by the table.
       *
       * ONLY on the drill-down. The pivot itself never carries a name or a phone; there is no
       * reason for 30,000 phone numbers to cross the wire so a grid of counts can render. */
      const ids = base.map((p) => p.id);
      const who = new Map<number, { name: string | null; phone: string | null }>();
      for (let i = 0; i < ids.length; i += 500) {
        const { data } = await auth.supabase.from("mdapi_users")
          .select("id,first_name,last_name,phone_number").in("id", ids.slice(i, i + 500));
        for (const u of data ?? []) {
          const r = u as { id: number; first_name: string | null; last_name: string | null; phone_number: string | null };
          who.set(Number(r.id), {
            name: [r.first_name, r.last_name].map((x) => String(x ?? "").trim()).filter(Boolean).join(" ") || null,
            phone: r.phone_number ?? null,
          });
        }
      }
      const players = base.map((p) => ({ ...p, name: who.get(p.id)?.name ?? null, phone: who.get(p.id)?.phone ?? null }));
      if (body.mode === "cellCsv") {
        const header = "Player ID,Name,Phone,City,Field,Cohort,Months active,Spots,Revenue\n";
        const lines = players.map((p) => `${p.id},"${p.name ?? ""}","${p.phone ?? ""}","${p.city}","${p.field}","${p.cohort}",${p.months},${p.spots},${money(p.revenue)}`).join("\n");
        return new Response(header + lines + "\n", { status: 200, headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="players.csv"` } });
      }
      return Response.json({ players, count: players.length }, { status: 200 });
    }

    /* MEMOISED PER CONFIG. The full cross-tab was rebuilt on every keystroke of the builder;
     * measured on production (151,559 facts) a 42-column cube costs 684 ms and an 8-column one
     * 164 ms, while the same cube served from the cache costs 0 ms. A SWAP is the same facts read
     * the other way round, so it should never cost a recompute twice. Keyed on the fact table's own
     * cache key as well as the config, so a fresh fact table cannot be served a stale cube. */
    const { table: t, hit } = pivotCached(F.facts, cfg, F.key);
    if (body.mode === "tableCsv") {
      const showV = (v: number | null, vi: number) => (v == null ? "" : cfg.vals[vi].metric === "Revenue" ? money(v) : String(v));
      const head = [cfg.rows.join(" · "), ...(t.hasCols ? t.colKeys : [""]).flatMap((c) => cfg.vals.map((vv) => `${vv.agg} of ${vv.metric}${t.hasCols ? ` (${c})` : ""}`)), ...(t.hasCols ? cfg.vals.map((vv) => `${vv.agg} of ${vv.metric} (Total)`) : [])];
      const rows = t.rowKeys.map((r) => [
        `"${r}"`,
        ...t.colKeys.flatMap((c) => t.cells[r][c].map((v, vi) => showV(v, vi))),
        ...(t.hasCols ? t.rowTotals[r].map((v, vi) => showV(v, vi)) : []),
      ].join(","));
      const grand = ["Grand total", ...t.colTotals.flatMap((cv) => cv.map((v, vi) => showV(v, vi))), ...(t.hasCols ? t.grandTotal.map((v, vi) => showV(v, vi)) : [])].join(",");
      return new Response([head.join(","), ...rows, grand].join("\n") + "\n", { status: 200, headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="data-room.csv"` } });
    }

    // default: pivot + metadata for the builder
    return Response.json(
      {
        ...t,
        /* THE TOTAL COLUMN NAMES THE WINDOW IT COVERS. The bug was a total over Apr 2023 – Sep 2026
         * beside columns showing Feb – Sep 2026 — 7,450 against 6,712 of visible cells. The label
         * and the figure now come from the same `filters`, so they cannot drift without the header
         * being visibly wrong. `kind` says whether the column is a SUM or a DISTINCT COUNT: for
         * Players a "total" is not the sum of the cells and must not be labelled as one. */
        totalCol: totalHeader(cfg.filters.from, cfg.filters.to, cfg.vals[0]?.metric ?? "Players"),
        cached: hit,
        // THE COUNTER, ON THE WIRE. A week of logs answers the cold-hit fraction exactly.
        facts: { ...stats, factMs },
        meta: { monthsAvailable: F.monthsAvailable, cities: F.cities, fieldsByCity: F.fieldsByCity } },
      {
        status: 200,
        headers: {
          "Cache-Control": "private, max-age=30",
          // Readable in the network panel and in Vercel's logs without parsing a body.
          "Server-Timing": `facts;dur=${factMs};desc="${stats.cold ? "cold" : "warm"}", cube;desc="${hit ? "cached" : "built"}"`,
        },
      },
    );
  } catch (e) {
    console.error("[api/lifecycle/dataroom] failed", e);
    return Response.json({ error: "Failed to build the pivot" }, { status: 500 });
  }
}
