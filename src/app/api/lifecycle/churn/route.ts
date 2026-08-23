// GET /api/lifecycle/churn — potential-churn list from growth_player_profile, ranked
// by MATCHES PLAYED desc (days-inactive breaks ties). Filters: city, field (canonical),
// days (inactive floor 30/60/90/120), after (last-played-after ceiling). ?format=csv
// streams the FULL filtered set (both bounds), not the visible page.
import { authenticateLifecycle } from "@/lib/lifecycleAuth";
import { fetchChurnList, cityAbbrFromDisplay, type ChurnListRow } from "@/lib/growthViews";

export const runtime = "nodejs";
export const maxDuration = 30;
const PAGE_SIZE = 12;

function parse(req: Request) {
  const sp = new URL(req.url).searchParams;
  const city = sp.get("city");
  const field = sp.get("field");
  return {
    days: Number(sp.get("days") ?? 90),
    cityAbbr: !city || city === "all" ? null : cityAbbrFromDisplay(city),
    field: field && field !== "all" ? field : null,
    after: sp.get("after"),
    heavyOnly: sp.get("heavy") === "1",
    page: Math.max(0, Number(sp.get("page") ?? 0)),
  };
}

export async function GET(req: Request) {
  const auth = await authenticateLifecycle(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const p = parse(req);
  const sp = new URL(req.url).searchParams;

  try {
    if (sp.get("format") === "csv") {
      const res = await fetchChurnList(auth.supabase, { ...p, pageSize: PAGE_SIZE, all: true });
      const enc = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(enc.encode("Player ID,City,Field,Days inactive,Matches played,Last played\n"));
          for (const r of res.rows as ChurnListRow[]) {
            controller.enqueue(enc.encode(`${r.u},"${r.city}","${r.field}",${r.days},${r.matches},${r.last}\n`));
          }
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="potential-churn-${p.days}d.csv"`,
        },
      });
    }

    const t0 = Date.now();
    const r = await fetchChurnList(auth.supabase, { ...p, pageSize: PAGE_SIZE });
    return Response.json(
      { ...r, page: p.page, pageSize: PAGE_SIZE, days: p.days },
      { status: 200, headers: { "Server-Timing": `churn;dur=${Date.now() - t0}` } },
    );
  } catch (e) {
    console.error("[api/lifecycle/churn] failed", e);
    return Response.json({ error: "Failed to load churn list" }, { status: 500 });
  }
}
