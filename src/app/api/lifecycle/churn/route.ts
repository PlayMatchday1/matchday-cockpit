// GET /api/lifecycle/churn — potential-churn list from growth_player_profile, ranked
// by MATCHES PLAYED desc (days-inactive breaks ties). Filters: city, field (canonical),
// days (inactive floor 30/60/90/120), after (last-played-after ceiling). ?format=csv
// streams the FULL filtered set (both bounds), not the visible page.
import { authenticateLifecycle } from "@/lib/lifecycleAuth";
import { fetchChurnList, cityAbbrFromDisplay, type ChurnListRow } from "@/lib/growthViews";
import { DEFAULT_HEAVY, DEFAULT_WINDOW, clampHeavy, effectiveStart, emailDisplay, TIERS, type Tier, type WindowKind } from "@/lib/churnModel";

export const runtime = "nodejs";
export const maxDuration = 30;
const PAGE_SIZE = 12;

function parse(req: Request) {
  const sp = new URL(req.url).searchParams;
  const city = sp.get("city");
  const field = sp.get("field");
  /* THE WINDOW DEFAULTS TO THIS YEAR. It defaulted to all time, which is how a player last seen in
   * September 2024 — 704 days gone — sat beside someone who lapsed in May. Measured at the 90-day
   * floor: all time 9,427 · 12 months 4,719 · this year 3,166. The date box overrides the buttons;
   * effectiveStart is the one place that precedence lives. */
  const win = (sp.get("win") ?? DEFAULT_WINDOW) as WindowKind;
  const today = new Date().toISOString().slice(0, 10);
  const tierParam = sp.get("tier");
  return {
    days: Number(sp.get("days") ?? 90),
    cityAbbr: !city || city === "all" ? null : cityAbbrFromDisplay(city),
    field: field && field !== "all" ? field : null,
    after: sp.get("after"),
    start: effectiveStart(win === "ytd" || win === "12m" || win === "all" ? win : DEFAULT_WINDOW, sp.get("after"), today),
    win,
    heavy: clampHeavy(Number(sp.get("threshold") ?? DEFAULT_HEAVY)),
    tier: (TIERS as string[]).includes(String(tierParam)) ? (tierParam as Tier) : null,
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
          // THE EXPORT CARRIES WHAT THE PAGE IS FOR. A CSV of ids is the same unusable list in a
          // different file. A relay address is labelled here too, never pasted as a token.
          controller.enqueue(enc.encode("Player ID,Name,Email,Phone,Member,City,Field,Days inactive,Matches played,Spent,Last played\n"));
          for (const r of res.rows as ChurnListRow[]) {
            const e = emailDisplay(r);
            controller.enqueue(enc.encode(
              `${r.u},"${r.name ?? ""}","${e.kind === "address" ? e.text : e.text}","${r.phone ?? ""}",${r.isMember ? "yes" : "no"},` +
              `"${r.city}","${r.field}",${r.days},${r.matches},${r.spent.toFixed(2)},${r.last}\n`));
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
      { ...r, page: p.page, pageSize: PAGE_SIZE, days: p.days, win: p.win, tier: p.tier },
      { status: 200, headers: { "Server-Timing": `churn;dur=${Date.now() - t0}` } },
    );
  } catch (e) {
    console.error("[api/lifecycle/churn] failed", e);
    return Response.json({ error: "Failed to load churn list" }, { status: 500 });
  }
}
