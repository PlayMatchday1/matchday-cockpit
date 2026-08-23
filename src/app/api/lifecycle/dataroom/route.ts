// POST /api/lifecycle/dataroom — the Player Data Room pivot + cell drill-down. One
// cached fact table (getFacts) serves both. Body.mode:
//   "pivot"   { config }            → the pivot table + filter/dim metadata
//   "cell"    { config, r, c }      → the distinct players inside one cell
//   "tableCsv"{ config }            → the pivot table as CSV
//   "cellCsv" { config, r, c }      → the cell's players as CSV
// Gated on can_access_lifecycle. Reads only; the fact table is derived from the views.
import { authenticateLifecycle } from "@/lib/lifecycleAuth";
import { getFacts, pivot, cellPlayers, measure, type PivotConfig } from "@/lib/dataRoom";

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
    const F = await getFacts(auth.supabase);

    if (body.mode === "cell" || body.mode === "cellCsv") {
      const players = cellPlayers(F.facts, cfg, String(body.r), String(body.c ?? "__all__"));
      if (body.mode === "cellCsv") {
        const header = "Player ID,City,Field,Cohort,Months active,Spots,Revenue\n";
        const lines = players.map((p) => `${p.id},"${p.city}","${p.field}","${p.cohort}",${p.months},${p.spots},${money(p.revenue)}`).join("\n");
        return new Response(header + lines + "\n", { status: 200, headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="players.csv"` } });
      }
      return Response.json({ players, count: players.length }, { status: 200 });
    }

    const t = pivot(F.facts, cfg);
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
      { ...t, meta: { monthsAvailable: F.monthsAvailable, cities: F.cities, fieldsByCity: F.fieldsByCity } },
      { status: 200, headers: { "Cache-Control": "private, max-age=30" } },
    );
  } catch (e) {
    console.error("[api/lifecycle/dataroom] failed", e);
    return Response.json({ error: "Failed to build the pivot" }, { status: 500 });
  }
}
