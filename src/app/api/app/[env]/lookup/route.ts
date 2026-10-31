// Staff app PLAYER LOOKUP, reads (Ryan, 2026-10-31). Every read is the desktop Player Lookup's own
// route, called in process with the caller's token, so its Match Ops gate and city boundary apply:
//
//   ?q=<term>              GET /api/lookup/{env}?q=        search (phone, email, id live; names from
//                          mdapi_users, then each hit reloaded live by id), then MEMBER checked live
//   ?ids=1,2,3             recent lookups: GET /api/lookup/{env}?id= per id (at most 8), live
//   ?id=<n>                GET /api/lookup/{env}?id=       the whole profile
//   ?payments=<n>&email=   GET /api/lookup/{env}/payments  the 10 most recent Stripe charges, read only
//   ?candidates=<n>        the player's city's matches for the next 7 days with an open spot, live
//                          from /admin/matches; a match they are already in is marked, not hidden
//
// MEMBER IS CHECKED LIVE (Ryan: "check membership live for the shown results so the tag is never
// missing for a real member"). The search row's hasMembership is set only when the list row happens
// to carry subscriptions, so each shown result is re-read with GET /admin/players/{id}; that detail
// carries every active subscription, and the profile mapping picks the membership from it.

import { authenticateApp, readRefusal } from "@/lib/appAuth";
import { cityAllowed, mapLimit } from "@/lib/appModel";
import { isEnv } from "@/lib/appLive";
import { apiGet, type MatchdayEnv } from "@/lib/matchdayStageApi";
import { buildProfile } from "@/lib/playerProfile";
import { callDesktop, passThrough } from "@/lib/appCall";
import { GET as lookupGet } from "@/app/api/lookup/[env]/route";
import { GET as paymentsGet } from "@/app/api/lookup/[env]/payments/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Row = Record<string, unknown>;

async function memberLive(env: MatchdayEnv, id: number): Promise<boolean | null> {
  try {
    const raw = await apiGet<Row>(env, `/admin/players/${id}`);
    const p = await buildProfile({ raw, listRow: null, resolveActor: async () => null, mirrorRows: [], charges: null });
    return p.membership != null && !String(p.membership.statusRaw ?? "").toUpperCase().startsWith("CANCEL");
  } catch { return null; }
}

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export async function GET(req: Request, ctx: { params: Promise<{ env: string }> }) {
  const auth = await authenticateApp(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const refused = readRefusal(auth);
  if (refused) return Response.json({ error: refused.error }, { status: refused.status });
  const { env } = await ctx.params;
  if (!isEnv(env)) return Response.json({ error: `unknown environment ${JSON.stringify(env)}` }, { status: 400 });
  const url = new URL(req.url);
  const P = { env };

  try {
    const q = url.searchParams.get("q");
    if (q != null) {
      const c = await callDesktop(req, lookupGet, `/api/lookup/${env}?q=${encodeURIComponent(q)}&page=1`, {}, P);
      if (!c.ok) return passThrough(c);
      const results = ((c.json?.results as Row[]) ?? []).slice(0, 25);
      const members = await mapLimit(results, 6, (r) => memberLive(env, Number(r.id)));
      return Response.json({
        ...c.json,
        results: results.map((r, i) => ({ id: r.id, name: r.name, city: r.city, status: r.status, member: members[i] ?? r.hasMembership === true, memberChecked: members[i] != null })),
      });
    }

    const ids = url.searchParams.get("ids");
    if (ids != null) {
      const list = ids.split(",").map((x) => x.trim()).filter((x) => /^\d+$/.test(x)).slice(0, 8);
      const rows = await mapLimit(list, 4, async (id) => {
        const c = await callDesktop(req, lookupGet, `/api/lookup/${env}?id=${id}`, {}, P);
        if (!c.ok) return { id: Number(id), error: (c.json?.error as string) ?? `HTTP ${c.status}`, status: c.status };
        const pl = (c.json?.player as Row) ?? {};
        return { id: Number(id), name: pl.name, city: pl.city, member: c.json?.membership != null };
      });
      return Response.json({ results: rows });
    }

    const id = url.searchParams.get("id");
    if (id != null) {
      const c = await callDesktop(req, lookupGet, `/api/lookup/${env}?id=${encodeURIComponent(id)}`, {}, P);
      return c.ok ? Response.json({ ...c.json, readAt: new Date().toISOString() }) : passThrough(c);
    }

    const pay = url.searchParams.get("payments");
    if (pay != null) {
      const email = url.searchParams.get("email");
      const c = await callDesktop(req, paymentsGet, `/api/lookup/${env}/payments?id=${encodeURIComponent(pay)}${email ? `&email=${encodeURIComponent(email)}` : ""}`, {}, P);
      return passThrough(c);
    }

    const cand = url.searchParams.get("candidates");
    if (cand != null) {
      // The player first, through the desktop route: it refuses a player outside the caller's city.
      const c = await callDesktop(req, lookupGet, `/api/lookup/${env}?id=${encodeURIComponent(cand)}`, {}, P);
      if (!c.ok) return passThrough(c);
      const city = ((c.json?.player as Row) ?? {}).city as string | null;
      const inIt = new Set(((c.json?.matches as Row[]) ?? []).filter((m) => m.state === "upcoming").map((m) => Number(m.matchId)));
      if (!city) return Response.json({ city: null, matches: [], note: "This player has no home city, so there is no city to list matches for." });
      const now = new Date();
      const from = ymd(now), to = ymd(new Date(now.getTime() + 6 * 86_400_000));
      const out: Row[] = [];
      for (let page = 1; page <= 10; page++) {
        const r = await apiGet<{ data?: Row[]; totalItems?: number }>(env, `/admin/matches`, { fromDate: from, toDate: to, page, limit: 100, sortColumn: "startDate", sortDirection: "asc" });
        const rows = Array.isArray(r) ? (r as Row[]) : (r.data ?? []);
        out.push(...rows);
        if (rows.length < 100) break;
      }
      const matches = out
        .filter((m) => (((m.field as Row | undefined)?.city as Row | undefined)?.name) === city)
        .filter((m) => cityAllowed(auth, auth.scopeCityName, city))
        .filter((m) => m.isCancelled !== true && Date.parse(String(m.startDateUtc)) > now.getTime())
        .map((m) => {
          const cap = Number(m.maxPlayerCount) || 0, taken = Number((m._count as Row | undefined)?.players ?? 0);
          return {
            id: Number(m.id), name: m.name, startDate: m.startDate, startDateUtc: m.startDateUtc,
            field: ((m.field as Row | undefined)?.title as string | undefined)?.trim() ?? null,
            capacity: cap, taken, open: Math.max(0, cap - taken), inIt: inIt.has(Number(m.id)),
          };
        })
        .filter((m) => m.open > 0 || m.inIt);
      return Response.json({ city, from, to, matches });
    }

    return Response.json({ error: "q, ids, id, payments or candidates required" }, { status: 400 });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
