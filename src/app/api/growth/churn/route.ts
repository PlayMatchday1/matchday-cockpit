// GET /api/growth/churn?days=90&city=all|<display>&page=0 — potential-churn list
// from growth_player_profile, server-paginated 100/page, sorted by days-inactive
// desc. ?format=csv streams the FULL filtered set (not built from a client array).
import { authenticateCities } from "@/lib/growthAuth";
import { fetchChurnList, cityAbbrFromDisplay, type ChurnListRow } from "@/lib/growthViews";

export const runtime = "nodejs";
export const maxDuration = 30;
const PAGE_SIZE = 100;

export async function GET(req: Request) {
  const auth = await authenticateCities(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const sp = new URL(req.url).searchParams;
  const days = Number(sp.get("days") ?? 90);
  const city = sp.get("city");
  const abbr = !city || city === "all" ? null : cityAbbrFromDisplay(city);

  try {
    if (sp.get("format") === "csv") {
      // Stream the full filtered set, page by page, straight to CSV.
      const enc = new TextEncoder();
      const sb = auth.supabase;
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue(enc.encode("Player ID,City,Field,Days inactive,Matches played,Last played\n"));
          for (let page = 0; ; page++) {
            const { rows } = await fetchChurnList(sb, { cityAbbr: abbr, days, page, pageSize: 1000 });
            for (const r of rows as ChurnListRow[]) {
              controller.enqueue(enc.encode(`${r.u},"${r.city}","${r.field}",${r.days},${r.matches},${r.last}\n`));
            }
            if (rows.length < 1000) break;
          }
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="potential-churn-${days}d.csv"`,
        },
      });
    }
    const page = Math.max(0, Number(sp.get("page") ?? 0));
    const t0 = Date.now();
    const { counts, total, rows } = await fetchChurnList(auth.supabase, { cityAbbr: abbr, days, page, pageSize: PAGE_SIZE });
    return Response.json(
      { days, page, pageSize: PAGE_SIZE, total, counts, rows },
      { status: 200, headers: { "Server-Timing": `churn;dur=${Date.now() - t0}` } },
    );
  } catch (e) {
    console.error("[api/growth/churn] failed", e);
    return Response.json({ error: "Failed to load churn list" }, { status: 500 });
  }
}
