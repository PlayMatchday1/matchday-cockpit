"use client";

// Promo Codes (Phase 18b). Search-first over 6,260 production codes with no server sort — so
// browsing opens on the server's (heap) order, honestly labelled, and search is the workflow.
// Two tables split by END DATE the way the server splits them (LIVE = endDateMin, PAST =
// endDateMax); state is a per-row badge derived from the row's own dates + deletedAt, never a
// server filter (there is none). CAP is on the list; REDEEMED/LEFT are on the detail drawer
// only (usageCount is detail-only — no N+1). All times are TRUE UTC shown in America/Chicago
// (promoTz) — the OPPOSITE model from the match screens; the two must never share helpers.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth, canManagePromos } from "@/lib/useAuth";
import {
  type PromoRow, type PromoState, type DiscountType, type TargetUserType, type TargetMatchType,
  promoState, promoBucket, discountLabel, capLabel, leftLabel, leftTone, usageLine, createSummary,
  USER_TYPE_LABEL, MATCH_TYPE_LABEL,
} from "@/lib/promoModel";
import {
  PROMO_TZ_LABEL, fmtChicagoDate, fmtChicagoDateShort, fmtChicagoTime, fmtChicagoFull, ageLabel, toChicagoInputs, fromChicagoInputs,
  nextQuarterHourUtcIso, endOfYearUtcIso, chicagoYearOf, chicagoWallToUtcIso, utcIsoToChicagoWall,
} from "@/lib/promoTz";

const PAGE = 25;
const CEILING = 100; // past this, with an empty search box, stop offering "more" — point at search

async function authFetch(path: string, init?: RequestInit): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return fetch(path, { ...init, headers: { ...(init?.headers ?? {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, cache: "no-store" });
}

type ListResp = { data: PromoRow[]; totalItems: number; nowIso: string; error?: string };

// ── REDEEMED per-row lazy fetch (Phase 20 C). usageCount is detail-only, so the ban on N+1 is
// lifted for the VISIBLE page only, under strict rules: render immediately (never block), fill in
// after; cap 5 concurrent; cache by id for the session (paging back / reopening = zero calls);
// and CANCEL in-flight when the visible id set changes so a late response can't write into the
// wrong row. Four visually distinct states — a pending or failed fetch must NEVER read as "0". ──
type RedeemState = { state: "loading" | "loaded" | "failed"; value?: number };
const redeemedCache = new Map<number, number>(); // session cache: promo id -> usageCount

function useRedeemed(ids: number[]): { get: (id: number) => RedeemState; retry: (id: number) => void } {
  const [cells, setCells] = useState<Record<number, RedeemState>>({});
  const genRef = useRef(0);
  const inflight = useRef<Map<number, AbortController>>(new Map());
  const key = ids.join(",");

  const fetchOne = useCallback((id: number, gen: number): Promise<void> => {
    const ac = new AbortController();
    inflight.current.set(id, ac);
    return authFetch(`/api/promos/detail/${id}`, { signal: ac.signal })
      .then(async (res) => {
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
        return typeof j.usageCount === "number" ? j.usageCount : 0;
      })
      .then((uc) => { redeemedCache.set(id, uc); if (gen === genRef.current) setCells((p) => ({ ...p, [id]: { state: "loaded", value: uc } })); })
      .catch(() => { if (gen === genRef.current && !ac.signal.aborted) setCells((p) => ({ ...p, [id]: { state: "failed" } })); })
      .finally(() => { inflight.current.delete(id); });
  }, []);

  useEffect(() => {
    const gen = ++genRef.current;
    for (const ac of inflight.current.values()) ac.abort(); // cancel the previous generation
    inflight.current = new Map();
    // seed: cached → loaded (0 calls); everything else → loading (NEVER a bare 0 while pending)
    setCells(() => { const next: Record<number, RedeemState> = {}; for (const id of ids) next[id] = redeemedCache.has(id) ? { state: "loaded", value: redeemedCache.get(id)! } : { state: "loading" }; return next; });
    const queue = ids.filter((id) => !redeemedCache.has(id));
    let idx = 0, active = 0;
    const pump = () => {
      while (active < 5 && idx < queue.length) {
        const id = queue[idx++]; active++;
        void fetchOne(id, gen).finally(() => { active--; if (gen === genRef.current) pump(); });
      }
    };
    pump();
    return () => { for (const ac of inflight.current.values()) ac.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, fetchOne]);

  const retry = useCallback((id: number) => { redeemedCache.delete(id); setCells((p) => ({ ...p, [id]: { state: "loading" } })); void fetchOne(id, genRef.current); }, [fetchOne]);
  return { get: (id) => cells[id] ?? { state: "loading" }, retry };
}
type Redeemed = ReturnType<typeof useRedeemed>;

// the REDEEMED cell — four distinct states, never a bare number while loading/failed
function RedeemedCell({ st, onRetry }: { st: RedeemState; onRetry: () => void }) {
  if (st.state === "loading") return <span className="uses red loading" data-testid="redeemed" data-rstate="loading" aria-label="loading">–</span>;
  if (st.state === "failed") return <span className="uses red" data-testid="redeemed" data-rstate="failed"><span role="button" tabIndex={0} className="red-retry" aria-label="Couldn't read redemptions — retry" title="Couldn't read redemptions — retry" onClick={(e) => { e.stopPropagation(); onRetry(); }} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onRetry(); } }}>?</span></span>;
  return <span className={"uses red" + (st.value === 0 ? " zero" : "")} data-testid="redeemed" data-rstate="loaded" data-value={st.value}>{st.value!.toLocaleString()}</span>;
}
// mobile: the redeemed fragment of the one-line usage summary, same four states
function redeemedMobile(st: RedeemState): string {
  if (st.state === "loading") return "… redeemed";
  if (st.state === "failed") return "redemptions unavailable";
  return `${st.value!.toLocaleString()} redeemed`;
}

export default function PromoCodes() {
  const { appUser } = useAuth();
  const mayManage = canManagePromos(appUser);

  const [q, setQ] = useState("");
  const [deferredQ, setDeferredQ] = useState("");
  const [nowIso, setNowIso] = useState<string>(() => new Date().toISOString());

  // browse buckets (accumulated across pages)
  const [live, setLive] = useState<{ rows: PromoRow[]; total: number; page: number }>({ rows: [], total: 0, page: 0 });
  const [past, setPast] = useState<{ rows: PromoRow[]; total: number; page: number }>({ rows: [], total: 0, page: 0 });
  // search results (accumulated) + single-id result
  const [search, setSearch] = useState<{ rows: PromoRow[]; total: number; page: number } | null>(null);
  const [idResult, setIdResult] = useState<{ row: PromoRow | null } | null>(null);
  const [pastOpen, setPastOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [justCreated, setJustCreated] = useState<PromoRow[]>([]);

  const [detailId, setDetailId] = useState<number | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const say = (t: string) => { setToast(t); setTimeout(() => setToast(null), 3200); };

  const mode: "browse" | "search" | "id" = deferredQ.trim() === "" ? "browse" : /^\d+$/.test(deferredQ.trim()) ? "id" : "search";

  // debounce the search box
  useEffect(() => { const t = setTimeout(() => setDeferredQ(q), 280); return () => clearTimeout(t); }, [q]);
  // clearing the box re-collapses PAST
  useEffect(() => { if (deferredQ.trim() === "") setPastOpen(false); }, [deferredQ]);

  const getList = useCallback(async (params: Record<string, string | number>): Promise<ListResp> => {
    const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
    const res = await authFetch(`/api/promos/list?${qs}`);
    const j = (await res.json().catch(() => ({}))) as ListResp;
    if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
    return j;
  }, []);

  // ── BROWSE: load both buckets, page 1 ──
  const loadBrowse = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const [l, p] = await Promise.all([getList({ bucket: "live", page: 1 }), getList({ bucket: "past", page: 1 })]);
      setLive({ rows: l.data, total: l.totalItems, page: 1 });
      setPast({ rows: p.data, total: p.totalItems, page: 1 });
      setNowIso(l.nowIso);
      setSearch(null); setIdResult(null);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setLoading(false);
  }, [getList]);

  // ── SEARCH: substring across both buckets, page 1 ──
  const loadSearch = useCallback(async (text: string) => {
    setLoading(true); setErr(null);
    try {
      const r = await getList({ code: text, page: 1 });
      setSearch({ rows: r.data, total: r.totalItems, page: 1 });
      setNowIso(r.nowIso);
      // auto-expand PAST if the search hit there
      if (r.data.some((row) => promoBucket(row, r.nowIso) === "past")) setPastOpen(true);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setLoading(false);
  }, [getList]);

  // ── ALL-DIGIT lookup: fire BOTH the ID detail AND the code substring search, show both
  //    (18c item 3). One extra call removes the ambiguity — a code literally named "2026" is a
  //    code the substring search finds; the same digits as an ID are the detail lookup. If both
  //    hit, both show (the ID match is tagged). ──
  const loadId = useCallback(async (id: string) => {
    setLoading(true); setErr(null);
    try {
      const [detailRes, searchResp] = await Promise.all([
        authFetch(`/api/promos/detail/${id}`),
        getList({ code: id, page: 1 }).catch(() => ({ data: [] as PromoRow[], totalItems: 0, nowIso: new Date().toISOString() })),
      ]);
      let idRow: PromoRow | null = null;
      if (detailRes.ok) { const j = await detailRes.json(); idRow = j.promo as PromoRow; }
      setIdResult({ row: idRow });
      setSearch({ rows: searchResp.data, total: searchResp.totalItems, page: 1 });
      setNowIso(searchResp.nowIso);
      const all = [...(idRow ? [idRow] : []), ...searchResp.data];
      if (all.some((r) => promoBucket(r, searchResp.nowIso) === "past")) setPastOpen(true);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setLoading(false);
  }, [getList]);

  useEffect(() => {
    if (mode === "browse") void loadBrowse();
    else if (mode === "search") void loadSearch(deferredQ.trim());
    else void loadId(deferredQ.trim());
  }, [mode, deferredQ, loadBrowse, loadSearch, loadId]);

  const loadMore = async (bucket: "live" | "past") => {
    if (mode === "search") { // one combined list, next page appends
      if (!search) return;
      const r = await getList({ code: deferredQ.trim(), page: search.page + 1 });
      setSearch({ rows: [...search.rows, ...r.data], total: r.totalItems, page: search.page + 1 });
      return;
    }
    const cur = bucket === "live" ? live : past;
    const r = await getList({ bucket, page: cur.page + 1 });
    const next = { rows: [...cur.rows, ...r.data], total: r.totalItems, page: cur.page + 1 };
    bucket === "live" ? setLive(next) : setPast(next);
  };

  // ── compute what each table shows, per mode ──
  const view = useMemo(() => {
    if (mode === "id") {
      const idRow = idResult?.row ?? null;
      const searchRows = search?.rows ?? [];
      const idAlsoInSearch = idRow != null && searchRows.some((r) => r.id === idRow.id);
      // ID match first (tagged), then the code-substring hits, minus the same row if it appears in both
      const merged = idRow ? [{ ...idRow, _idMatch: true }, ...searchRows.filter((r) => r.id !== idRow.id)] : searchRows;
      const liveRows = merged.filter((r) => promoBucket(r, nowIso) === "live");
      const pastRows = merged.filter((r) => promoBucket(r, nowIso) === "past");
      return {
        liveRows, liveTotal: liveRows.length, pastRows, pastTotal: pastRows.length,
        searchTotal: (search?.total ?? 0) + (idRow && !idAlsoInSearch ? 1 : 0),
        notFound: idResult != null && idRow == null && searchRows.length === 0,
      };
    }
    if (mode === "search" && search) {
      const liveRows = search.rows.filter((r) => promoBucket(r, nowIso) === "live");
      const pastRows = search.rows.filter((r) => promoBucket(r, nowIso) === "past");
      return { liveRows, liveTotal: liveRows.length, pastRows, pastTotal: pastRows.length, searchTotal: search.total, notFound: search.total === 0 };
    }
    // browse — prepend session "just created" rows to LIVE
    return { liveRows: [...justCreated, ...live.rows], liveTotal: live.total + justCreated.length, pastRows: past.rows, pastTotal: past.total, searchTotal: 0, notFound: false };
  }, [mode, idResult, search, live, past, justCreated, nowIso]);

  // REDEEMED lazy-loads only for the rows on screen now (LIVE always; PAST only when open),
  // excluding just-created session rows (they're new → 0, no fetch). One shared pool + cache.
  // PAUSED while a drawer is open — the list is obscured, and letting 100+ detail calls run then
  // would starve the create form's own request off the browser's per-host connection pool.
  const drawerOpen = createOpen || detailId != null;
  const visibleIds = useMemo(
    () => (drawerOpen ? [] : [...view.liveRows, ...(pastOpen ? view.pastRows : [])].filter((r) => !(r as PromoRow & { _new?: boolean })._new).map((r) => r.id)),
    [view.liveRows, view.pastRows, pastOpen, drawerOpen],
  );
  const redeemed = useRedeemed(visibleIds);

  const onCreated = (row: PromoRow) => { setJustCreated((j) => [{ ...row }, ...j]); setCreateOpen(false); say(`Created ${row.code}`); };

  if (appUser && !mayManage) {
    return <div className="promo"><style>{CSS}</style><div className="wrap"><div className="empty" data-testid="promo-no-access"><b>You do not hold MANAGE PROMOS</b>This screen and its actions require the promo-code permission.</div></div></div>;
  }

  return (
    <div className="promo" data-testid="promos">
      <style>{CSS}</style>
      <div className="wrap">
        <div className="head">
          <div className="htop">
            <div>
              <h1 className="h1">Promo Codes</h1>
              <p className="hsub">Live codes and past ones. Search reaches both — there are 6,260, so search is faster than scroll.</p>
            </div>
            <button className="btn primary" data-testid="promo-new" onClick={() => setCreateOpen(true)}>+ New promo code</button>
          </div>
          <div className="srow">
            <span className="sbox">
              <span className="sicon" aria-hidden>⌕</span>
              <input id="promo-q" data-testid="promo-search" type="search" autoFocus placeholder="Code or ID" autoComplete="off" aria-label="Search promo codes" value={q} onChange={(e) => setQ(e.target.value)} />
            </span>
          </div>
          <p className="hint" data-testid="promo-hint">{
            mode === "id" ? <>All digits — showing the code with that <b>ID</b> and any code <b>containing</b> those digits.</>
            : mode === "search" ? <>Reading that as a <b>code</b> — substring, case-insensitive. Searches both tables, including deleted codes.</>
            : <>Type a code or an ID — all digits is read as an ID, anything else as a code.</>
          }</p>
        </div>

        {loading && !view.liveRows.length && !view.pastRows.length ? <div className="empty" data-testid="promo-loading">Loading…</div>
         : err ? <div className="empty err" data-testid="promo-err">Couldn’t load promo codes: {err}</div>
         : <>
          {/* LIVE */}
          <section className={"grp" + (mode !== "browse" && view.liveTotal === 0 ? " slim" : "")} data-testid="grp-live">
            <div className="ghead">
              <span className="gtitle">LIVE</span>
              <span className="gsub" data-testid="live-sub">{mode === "browse"
                ? <>{view.liveTotal.toLocaleString()} live codes, in the order the API returns them <span className="nosort" data-testid="nosort-note">— no date sort; the CREATED dates are shown, not sortable</span></>
                : `${view.liveTotal.toLocaleString()} live match${view.liveTotal === 1 ? "" : "es"}`}</span>
            </div>
            <PromoTable rows={view.liveRows} nowIso={nowIso} onOpen={setDetailId} redeemed={redeemed}
              empty={mode !== "browse"
                ? <p className="empty oneline" data-testid="live-empty"><b>No live codes match</b>Finished and deleted codes are in the PAST table below — it opens when a search hits it.</p>
                : <p className="empty" data-testid="live-empty"><b>No live codes</b>Nothing is active or scheduled right now.</p>}
              more={<MoreBar mode={mode} loaded={view.liveRows.length - (mode === "browse" ? justCreated.length : 0)} total={mode === "search" ? view.searchTotal : view.liveTotal} onMore={() => loadMore("live")} />} />
          </section>

          {/* PAST — collapsible */}
          <section className={"grp past"} data-testid="grp-past">
            <button type="button" className="ghead gtoggle" data-testid="past-toggle" aria-expanded={pastOpen} onClick={() => setPastOpen((o) => !o)}>
              <span className="caret" aria-hidden>{pastOpen ? "▾" : "▸"}</span>
              <span className="gtitle">PAST</span>
              <span className={"gsub" + (mode !== "browse" && view.pastTotal > 0 ? " pasthit" : "")} data-testid="past-sub">{mode === "browse"
                ? `${view.pastTotal.toLocaleString()} expired or deleted`
                : `${view.pastTotal.toLocaleString()} match${view.pastTotal === 1 ? "" : "es"} in here`}</span>
            </button>
            {pastOpen && (
              <div data-testid="past-body">
                <PromoTable rows={view.pastRows} nowIso={nowIso} onOpen={setDetailId} redeemed={redeemed}
                  empty={<p className="empty" data-testid="past-empty"><b>No past codes match</b>Nothing expired or deleted matches that.</p>}
                  more={<MoreBar mode={mode} loaded={view.pastRows.length} total={mode === "search" ? view.searchTotal : view.pastTotal} onMore={() => loadMore("past")} />} />
              </div>
            )}
          </section>

          <p className="foot" data-testid="promo-foot">{mode === "browse"
            ? `Server order (no sort available). Deleted codes with a future end date appear in LIVE, struck through. CAP is here; redemptions are on a code's detail.`
            : mode === "id"
              ? (view.notFound ? `No code with ID ${deferredQ.trim()}, and none containing those digits.` : `Matched by ID and/or by code substring for “${deferredQ.trim()}”. A code named entirely with digits is findable this way.`)
              : `${view.searchTotal.toLocaleString()} code${view.searchTotal === 1 ? "" : "s"} match “${deferredQ.trim()}”. Deleted codes are never hidden from search.`}</p>
        </>}
      </div>

      {detailId != null && <DetailDrawer id={detailId} onClose={() => setDetailId(null)} />}
      {createOpen && <CreateDrawer onClose={() => setCreateOpen(false)} onCreated={onCreated} />}
      {toast && <div className="toast" data-testid="promo-toast" role="status">{toast}</div>}
    </div>
  );
}

// ── one table. The timezone is stated ONCE here (a property of the table), not per row. ──
function PromoTable({ rows, nowIso, onOpen, redeemed, empty, more }: { rows: PromoRow[]; nowIso: string; onOpen: (id: number) => void; redeemed: Redeemed; empty: React.ReactNode; more: React.ReactNode }) {
  return (
    <div className="sheet">
      <div className="tzbar" data-testid="tzbar">All times <b>America/Chicago</b></div>
      <div className="colhead"><span /><span>CODE</span><span>CREATED</span><span>WINDOW</span><span>DISCOUNT</span><span>WHO · WHICH</span><span className="ra">CAP</span><span className="ra">REDEEMED</span><span>STATE</span></div>
      {rows.length === 0 ? empty : rows.map((p) => <PromoRowEl key={p.id + ":" + p.code} p={p} nowIso={nowIso} onOpen={onOpen} redeemed={redeemed} />)}
      {rows.length > 0 && more}
    </div>
  );
}

function PromoRowEl({ p, nowIso, onOpen, redeemed }: { p: PromoRow; nowIso: string; onOpen: (id: number) => void; redeemed: Redeemed }) {
  const st: PromoState = promoState(p, nowIso);
  const tagged = p as PromoRow & { _new?: boolean; _idMatch?: boolean };
  const age = ageLabel(p.createdAt, Date.parse(nowIso));
  const rst: RedeemState = tagged._new ? { state: "loaded", value: 0 } : redeemed.get(p.id); // just-created = 0, no fetch
  return (
    <button type="button" className={"r " + st} data-testid="promo-row" data-id={p.id} data-state={st} data-code={p.code} onClick={() => onOpen(p.id)}>
      <span className="rail" />
      <span className="cell c-code"><span className="code">{p.code}{tagged._new && <span className="newtag" data-testid="just-created">JUST CREATED</span>}{tagged._idMatch && <span className="newtag idtag" data-testid="id-match">MATCHED BY ID</span>}</span><span className="cid">ID {p.id}</span></span>
      <span className="cell c-created"><span className="cr" data-testid="created">{fmtChicagoDate(p.createdAt)}{age && <small data-testid="created-age">{age}</small>}</span></span>
      <span className="cell c-win"><span className="win">{fmtChicagoDate(p.startDateUtc)} {fmtChicagoTime(p.startDateUtc)}<small>→ {fmtChicagoDate(p.endDateUtc)} {fmtChicagoTime(p.endDateUtc)}</small></span></span>
      <span className="cell c-val"><span className="val">{discountLabel(p)}<small>{p.discountType}</small></span></span>
      <span className="cell c-who"><span className="who">{USER_TYPE_LABEL[p.targetUserType]}<small>{MATCH_TYPE_LABEL[p.targetMatchType]}</small></span></span>
      <span className="cell c-cap"><span className="uses" data-testid="promo-cap">{capLabel(p)}</span></span>
      <span className="cell c-redeemed"><RedeemedCell st={rst} onRetry={() => redeemed.retry(p.id)} /></span>
      <span className="cell c-st"><span className={"st " + st}>{st.toUpperCase()}</span></span>
      {/* mobile-only one-line usage summary: "Created Aug 2 · 4 redeemed · cap 5" (same 4 states) */}
      <span className="cell c-usemob" data-testid="usemob">Created {fmtChicagoDateShort(p.createdAt)} · <span data-testid="usemob-redeemed" data-rstate={rst.state}>{redeemedMobile(rst)}</span> · cap {capLabel(p)}</span>
    </button>
  );
}

function MoreBar({ mode, loaded, total, onMore }: { mode: "browse" | "search" | "id"; loaded: number; total: number; onMore: () => void }) {
  const left = Math.max(0, total - loaded);
  if (left === 0) return <div className="more" data-testid="more"><span>Showing {loaded.toLocaleString()} of {total.toLocaleString()} · all shown</span></div>;
  // browse past the ceiling with an empty search box: stop offering a bigger haystack
  if (mode === "browse" && loaded >= CEILING) {
    return <div className="more" data-testid="more"><span className="nudge" data-testid="nudge">{left.toLocaleString()} more in this table — search by code or ID instead of paging.</span></div>;
  }
  return <div className="more" data-testid="more"><span>Showing {loaded.toLocaleString()} of {total.toLocaleString()}</span><button className="btn" data-testid="show-more" onClick={onMore}>Show {Math.min(PAGE, left)} more</button></div>;
}

// ── DETAIL drawer: the ONLY place redemptions (usageCount) appear → REDEEMED / LEFT here ──
function DetailDrawer({ id, onClose }: { id: number; onClose: () => void }) {
  const [state, setState] = useState<{ promo?: PromoRow & { usageCount?: number }; usageCount?: number; nowIso?: string; loading: boolean; error?: string }>({ loading: true });
  useEffect(() => {
    let live = true;
    (async () => {
      try { const res = await authFetch(`/api/promos/detail/${id}`); const j = await res.json();
        if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
        if (live) setState({ promo: j.promo, usageCount: j.usageCount, nowIso: j.nowIso, loading: false });
      } catch (e) { if (live) setState({ loading: false, error: e instanceof Error ? e.message : String(e) }); }
    })();
    return () => { live = false; };
  }, [id]);
  useEffect(() => { const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; document.addEventListener("keydown", h); return () => document.removeEventListener("keydown", h); }, [onClose]);

  const p = state.promo; const uc = state.usageCount ?? 0;
  return (
    <div className="scrim" data-testid="detail-scrim" onClick={(e) => { if ((e.target as HTMLElement).classList.contains("scrim")) onClose(); }}>
      <div className="drawer" role="dialog" aria-modal="true" aria-label="Promo code detail">
        <div className="dhead"><h2>Promo code</h2><button className="x" aria-label="Close" onClick={onClose}>×</button></div>
        <div className="dbody">
          {state.loading ? <p className="empty">Loading…</p> : state.error ? <p className="empty err">{state.error}</p> : p ? <>
            <div className="dcode"><span className="code big">{p.code}</span><span className="st inline">{promoState(p, state.nowIso ?? new Date().toISOString()).toUpperCase()}</span><span className="cid">ID {p.id}</span></div>
            <div className="usebox" data-testid="detail-usage">
              <div className="usecol"><span className="ul">REDEEMED</span><span className="uv" data-testid="detail-redeemed">{uc.toLocaleString()}</span></div>
              <div className="usecol"><span className="ul">CAP</span><span className="uv">{capLabel(p)}</span></div>
              <div className="usecol"><span className="ul">LEFT</span><span className={"uv left-" + leftTone(p, uc)} data-testid="detail-left">{leftLabel(p, uc)}</span></div>
            </div>
            <p className="useline" data-testid="detail-useline">{usageLine(p, uc)}</p>
            <dl className="facts">
              <div><dt>Discount</dt><dd>{discountLabel(p)} <small>{p.discountType}</small></dd></div>
              <div><dt>Window</dt><dd>{fmtChicagoFull(p.startDateUtc)} → {fmtChicagoFull(p.endDateUtc)}<small>{PROMO_TZ_LABEL}</small></dd></div>
              <div><dt>Audience</dt><dd>{USER_TYPE_LABEL[p.targetUserType]}</dd></div>
              <div><dt>Scope</dt><dd>{MATCH_TYPE_LABEL[p.targetMatchType]}</dd></div>
              <div><dt>Created</dt><dd>{fmtChicagoFull(p.createdAt)}</dd></div>
            </dl>
          </> : null}
        </div>
        <div className="dfoot"><div className="dbtns">
          <span className="sp" />
          <button className="btn" disabled data-testid="detail-edit" title="Editing a promo lands in the next phase.">Edit</button>
          <button className="btn" disabled data-testid="detail-delete" title="Delete is reversible (soft-delete + restore) and lands in the next phase.">Delete (reversible)</button>
        </div></div>
      </div>
    </div>
  );
}

// ── CREATE drawer: only CODE and VALUE typed; everything else prefills. TRUE UTC via Chicago. ──
type PickedUser = { id: number; name: string; email: string; phone: string; city: string };
type PickedMatch = { id: number; name: string; city: string; venue: string; kickoffUtc: string | null };
type PickedField = { id: number; title: string; city: string };
type Form = {
  code: string; type: DiscountType; value: string; sD: string; sT: string; eD: string; eT: string;
  who: TargetUserType; which: TargetMatchType; uses: string;
  users: PickedUser[]; matches: PickedMatch[]; fields: PickedField[]; // specific-scope selections
  mpSD: string; mpST: string; mpED: string; mpET: string;            // TIME_PERIOD match window (Chicago)
};
function CreateDrawer({ onClose, onCreated }: { onClose: () => void; onCreated: (row: PromoRow) => void }) {
  const now = Date.now();
  const startIso = nextQuarterHourUtcIso(now), endIso = endOfYearUtcIso(chicagoYearOf(now));
  const s0 = toChicagoInputs(startIso), e0 = toChicagoInputs(endIso);
  const [f, setF] = useState<Form>({ code: "", type: "PERCENT", value: "", sD: s0.date, sT: s0.time, eD: e0.date, eT: e0.time, who: "ALL_USERS", which: "ALL_MATCHES", uses: "1", users: [], matches: [], fields: [], mpSD: s0.date, mpST: s0.time, mpED: e0.date, mpET: e0.time });
  const [scopeNote, setScopeNote] = useState<string | null>(null);
  const [dupe, setDupe] = useState<{ state: "idle" | "checking" | "free" | "taken" | "inconclusive" | "error"; existing?: { id: number; code: string; state: string } }>({ state: "idle" });
  const [submitting, setSubmitting] = useState(false);
  const [submitErr, setSubmitErr] = useState<string | null>(null);

  const set = (patch: Partial<Form>) => setF((prev) => ({ ...prev, ...patch }));
  const startUtc = () => fromChicagoInputs(f.sD, f.sT);
  const endUtc = () => fromChicagoInputs(f.eD, f.eT);
  const mpStartUtc = () => fromChicagoInputs(f.mpSD, f.mpST);
  const mpEndUtc = () => fromChicagoInputs(f.mpED, f.mpET);
  const badWindow = endUtc() <= startUtc();
  const badMatchPeriod = f.which === "TIME_PERIOD" && mpEndUtc() <= mpStartUtc(); // guarded INDEPENDENTLY of the promo window
  const valNum = Number(f.value);
  const valOk = f.value !== "" && Number.isFinite(valNum) && valNum > 0 && (f.type !== "PERCENT" || valNum <= 100);
  // Switching scope AWAY from a specific option DROPS its selection (never sent stale) and says so.
  const setWho = (w: TargetUserType) => {
    setScopeNote(f.who === "SPECIFIC_USERS" && w !== "SPECIFIC_USERS" && f.users.length ? `${f.users.length} user${f.users.length > 1 ? "s" : ""} deselected` : null);
    set({ who: w, ...(w === "SPECIFIC_USERS" ? {} : { users: [] }) });
  };
  const setWhich = (w: TargetMatchType) => {
    const drops: string[] = [];
    if (f.which === "SPECIFIC_MATCHES" && w !== "SPECIFIC_MATCHES" && f.matches.length) drops.push(`${f.matches.length} match${f.matches.length > 1 ? "es" : ""}`);
    if (f.which === "SPECIFIC_FIELDS" && w !== "SPECIFIC_FIELDS" && f.fields.length) drops.push(`${f.fields.length} field${f.fields.length > 1 ? "s" : ""}`);
    setScopeNote(drops.length ? `${drops.join(" and ")} deselected` : null);
    set({ which: w, ...(w === "SPECIFIC_MATCHES" ? {} : { matches: [] }), ...(w === "SPECIFIC_FIELDS" ? {} : { fields: [] }) });
  };
  const scopeOk = (f.who !== "SPECIFIC_USERS" || f.users.length > 0)
    && (f.which !== "SPECIFIC_MATCHES" || f.matches.length > 0)
    && (f.which !== "SPECIFIC_FIELDS" || f.fields.length > 0)
    && (f.which !== "TIME_PERIOD" || !badMatchPeriod);
  const valid = f.code.trim() !== "" && valOk && !badWindow && dupe.state !== "taken" && Number(f.uses) >= 1 && scopeOk;

  // debounced duplicate check (server call — the browser cannot hold 6,260 codes)
  const codeRef = useRef(f.code);
  useEffect(() => { codeRef.current = f.code; }, [f.code]);
  useEffect(() => {
    const code = f.code.trim();
    if (!code) { setDupe({ state: "idle" }); return; }
    setDupe({ state: "checking" });
    const t = setTimeout(async () => {
      try {
        const res = await authFetch(`/api/promos/check?code=${encodeURIComponent(code)}`);
        const j = await res.json();
        if (codeRef.current.trim() !== code) return; // a newer keystroke won
        if (!res.ok) { setDupe({ state: "error" }); return; }
        // three-way: taken / free / inconclusive (too many similar to see the whole set)
        setDupe(j.result === "taken" ? { state: "taken", existing: j.existing } : j.result === "inconclusive" ? { state: "inconclusive" } : { state: "free" });
      } catch { if (codeRef.current.trim() === code) setDupe({ state: "error" }); }
    }, 300);
    return () => clearTimeout(t);
  }, [f.code]);

  useEffect(() => { const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; document.addEventListener("keydown", h); return () => document.removeEventListener("keydown", h); }, [onClose]);

  const summary = f.code.trim() && valOk
    ? createSummary({ code: f.code.trim(), discountType: f.type, value: f.type === "USD" ? Math.round(valNum * 100) : valNum, who: f.who, which: f.which, uses: Number(f.uses) || 1, startLabel: fmtChicagoFull(startUtc()), endLabel: fmtChicagoFull(endUtc()), tzName: PROMO_TZ_LABEL,
        userNames: f.users.map((u) => u.name), matchCount: f.matches.length, fieldCount: f.fields.length,
        matchPeriod: f.which === "TIME_PERIOD" ? { start: fmtChicagoFull(mpStartUtc()), end: fmtChicagoFull(mpEndUtc()) } : undefined })
    : null;

  const submit = async () => {
    setSubmitting(true); setSubmitErr(null);
    try {
      // send ONLY the active scope's payload — a switched-away array is never in the body (D5).
      const scopePayload: Record<string, unknown> = {
        ...(f.who === "SPECIFIC_USERS" ? { userIDs: f.users.map((u) => u.id) } : {}),
        ...(f.which === "SPECIFIC_MATCHES" ? { matchIDs: f.matches.map((m) => m.id) }
          : f.which === "SPECIFIC_FIELDS" ? { fieldIDs: f.fields.map((x) => x.id) }
          : f.which === "TIME_PERIOD" ? { matchTimePeriodStart: mpStartUtc(), matchTimePeriodEnd: mpEndUtc() } : {}),
      };
      const res = await authFetch(`/api/promos/create`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        code: f.code.trim(), discountType: f.type, value: valNum, startDateUtc: startUtc(), endDateUtc: endUtc(), uses: Number(f.uses), who: f.who, which: f.which, ...scopePayload,
      }) });
      const j = await res.json();
      if (!res.ok) { setSubmitErr(j.error || `HTTP ${res.status}`); setSubmitting(false); return; }
      // synthesize the just-created row for the session marker
      const row: PromoRow & { _new?: boolean } = {
        id: (j.result && (j.result.id ?? j.result?.data?.id)) || Date.now(), code: f.code.trim(), startDateUtc: startUtc(), endDateUtc: endUtc(),
        discountType: f.type, discountValue: f.type === "USD" ? Math.round(valNum * 100) : valNum, targetUserType: f.who, numberOfUsesPerUser: Number(f.uses),
        targetMatchType: f.which, matchTimePeriodStart: null, matchTimePeriodEnd: null, createdAt: new Date().toISOString(), deletedAt: null, _new: true,
      };
      onCreated(row);
    } catch (e) { setSubmitErr(e instanceof Error ? e.message : String(e)); setSubmitting(false); }
  };

  const preset = (kind: string) => {
    const n = Date.now();
    if (kind === "now") { const w = toChicagoInputs(nextQuarterHourUtcIso(n)); set({ sD: w.date, sT: w.time }); }
    else if (kind === "tom9") { const c = utcIsoToChicagoWall(new Date(n).toISOString()); const iso = chicagoWallToUtcIso({ y: c.y, mo: c.mo, d: c.d + 1, h: 9, mi: 0 }); const w = toChicagoInputs(iso); set({ sD: w.date, sT: w.time }); }
    else if (kind === "eoy") { const w = toChicagoInputs(endOfYearUtcIso(chicagoYearOf(n))); set({ eD: w.date, eT: w.time }); }
    else if (kind === "eom") { const c = utcIsoToChicagoWall(new Date(n).toISOString()); const iso = chicagoWallToUtcIso({ y: c.y, mo: c.mo, d: new Date(Date.UTC(c.y, c.mo, 0)).getUTCDate(), h: 23, mi: 59 }); const w = toChicagoInputs(iso); set({ eD: w.date, eT: w.time }); }
    else if (kind === "d30") { const c = utcIsoToChicagoWall(new Date(n).toISOString()); const iso = chicagoWallToUtcIso({ y: c.y, mo: c.mo, d: c.d + 30, h: 23, mi: 59 }); const w = toChicagoInputs(iso); set({ eD: w.date, eT: w.time }); }
  };

  const WHO_OPTS: TargetUserType[] = ["ALL_USERS", "NEW_USERS", "CHURN_USERS", "SPECIFIC_USERS"];
  const WHICH_OPTS: TargetMatchType[] = ["ALL_MATCHES", "TOTAL_USAGE", "TIME_PERIOD", "SPECIFIC_FIELDS", "SPECIFIC_MATCHES"];

  return (
    <div className="scrim" onClick={(e) => { if ((e.target as HTMLElement).classList.contains("scrim")) onClose(); }}>
      <div className="drawer" role="dialog" aria-modal="true" aria-label="New promo code">
        <div className="dhead"><h2>New promo code</h2><button className="x" aria-label="Close" onClick={onClose}>×</button></div>
        <div className="dbody">
          <span className="tzline">All promo times are <b>{PROMO_TZ_LABEL}</b>, entered here and stored as a true UTC instant. Clubhouse converts for you (and is DST-correct, unlike Retool).</span>

          <div className="fgrid one">
            <label className="fld"><span className="lb">CODE <span className="req">*</span></span>
              <input className="mono" data-testid="f-code" value={f.code} placeholder="e.g. augweekend" autoComplete="off" aria-invalid={dupe.state === "taken"} onChange={(e) => set({ code: e.target.value })} />
              {dupe.state === "taken" ? <span className="dupe" data-testid="f-dupe"><b>{dupe.existing?.code}</b> already exists — ID {dupe.existing?.id}, {dupe.existing?.state}. Pick another.</span>
               : dupe.state === "checking" ? <span className="help" data-testid="f-checking">Checking availability…</span>
               : dupe.state === "free" ? <span className="help ok" data-testid="f-free">Available. Stored exactly as typed (case is kept).</span>
               : dupe.state === "inconclusive" ? <span className="help" data-testid="f-inconclusive">Too many similar codes to check here — the server will reject a duplicate on save.</span>
               : dupe.state === "error" ? <span className="err" data-testid="f-checkerr">Couldn’t check uniqueness — the server enforces it on save.</span>
               : <span className="help">Checked against all codes as you type; the check ignores case, the stored value does not.</span>}
            </label>
          </div>

          <div className="fgrid" style={{ marginTop: 13 }}>
            <span className="fld"><span className="lb">DISCOUNT TYPE <span className="auto">PREFILLED</span></span>
              <span className="seg" role="group" aria-label="Discount type">
                <button type="button" data-testid="f-type-pct" aria-pressed={f.type === "PERCENT"} onClick={() => set({ type: "PERCENT" })}>Percent</button>
                <button type="button" data-testid="f-type-usd" aria-pressed={f.type === "USD"} onClick={() => set({ type: "USD" })}>Amount</button>
              </span>
            </span>
            <label className="fld"><span className="lb">VALUE <span className="req">*</span></span>
              <input data-testid="f-value" inputMode="decimal" value={f.value} placeholder={f.type === "PERCENT" ? "50" : "5.00"} autoComplete="off" onChange={(e) => set({ value: e.target.value })} />
              <span className="help">{f.type === "PERCENT" ? "Percent off, 1–100." : "Dollars off. Stored in cents."}</span>
            </label>
          </div>

          <div className="sect"><h3>WHEN</h3>
            <div className="fgrid">
              <span className="fld"><span className="lb">STARTS</span>
                <input type="date" data-testid="f-sd" value={f.sD} onChange={(e) => set({ sD: e.target.value })} />
                <input type="time" data-testid="f-st" value={f.sT} style={{ marginTop: 7 }} onChange={(e) => set({ sT: e.target.value })} />
                <span className="presets"><button type="button" className="pbtn" onClick={() => preset("now")}>Next quarter hour</button><button type="button" className="pbtn" onClick={() => preset("tom9")}>Tomorrow 9:00</button></span>
              </span>
              <span className="fld"><span className="lb">ENDS</span>
                <input type="date" data-testid="f-ed" value={f.eD} aria-invalid={badWindow} onChange={(e) => set({ eD: e.target.value })} />
                <input type="time" data-testid="f-et" value={f.eT} style={{ marginTop: 7 }} onChange={(e) => set({ eT: e.target.value })} />
                <span className="presets"><button type="button" className="pbtn" onClick={() => preset("eoy")}>End of year</button><button type="button" className="pbtn" onClick={() => preset("eom")}>End of month</button><button type="button" className="pbtn" onClick={() => preset("d30")}>+30 days</button></span>
                {badWindow && <span className="err" data-testid="f-winerr">The end must be after the start.</span>}
              </span>
            </div>
          </div>

          <div className="sect"><h3>WHO CAN USE IT</h3>
            <span className="radios">{WHO_OPTS.map((v) => <button key={v} type="button" className="rad" data-testid={`f-who-${v}`} aria-pressed={f.who === v} onClick={() => setWho(v)}>{USER_TYPE_LABEL[v]}</button>)}</span>
            {f.who === "SPECIFIC_USERS" && <UserPicker selected={f.users} onChange={(users) => set({ users })} />}
            <label className="fld" style={{ marginTop: 13 }}><span className="lb">USES PER {f.which === "TOTAL_USAGE" ? "CODE (TOTAL)" : "PERSON"} <span className="auto">PREFILLED 1</span></span>
              <input data-testid="f-uses" inputMode="numeric" value={f.uses} onChange={(e) => set({ uses: e.target.value })} />
              <span className="help" data-testid="f-uses-help">{f.which === "TOTAL_USAGE"
                ? "A TOTAL cap across everyone — the code stops after this many redemptions in all."
                : "Per person. Starts at 1 (Retool defaults it to 0, which nobody can redeem). Becomes a total cap under “All Matches (total cap)”."}</span>
            </label>
          </div>

          <div className="sect"><h3>WHICH MATCHES</h3>
            <span className="radios">{WHICH_OPTS.map((v) => <button key={v} type="button" className="rad" data-testid={`f-which-${v}`} aria-pressed={f.which === v} onClick={() => setWhich(v)}>{MATCH_TYPE_LABEL[v]}</button>)}</span>
            {scopeNote && <span className="help" data-testid="f-scope-note">{scopeNote}.</span>}
            {f.which === "TIME_PERIOD" && (
              <div className="fgrid" style={{ marginTop: 13 }}>
                <span className="fld"><span className="lb">MATCHES KICKING OFF FROM <span className="auto">PREFILLED</span></span>
                  <input type="date" data-testid="f-mpsd" value={f.mpSD} onChange={(e) => set({ mpSD: e.target.value })} />
                  <input type="time" data-testid="f-mpst" value={f.mpST} style={{ marginTop: 7 }} onChange={(e) => set({ mpST: e.target.value })} />
                </span>
                <span className="fld"><span className="lb">…UNTIL</span>
                  <input type="date" data-testid="f-mped" value={f.mpED} aria-invalid={badMatchPeriod} onChange={(e) => set({ mpED: e.target.value })} />
                  <input type="time" data-testid="f-mpet" value={f.mpET} style={{ marginTop: 7 }} onChange={(e) => set({ mpET: e.target.value })} />
                  {badMatchPeriod && <span className="err" data-testid="f-mperr">The match period end must be after its start.</span>}
                  <span className="help">Which matches the discount applies to — separate from when the code can be redeemed (above).</span>
                </span>
              </div>
            )}
            {f.which === "SPECIFIC_MATCHES" && <MatchPicker selected={f.matches} promoFrom={f.sD} promoTo={f.eD} onChange={(matches) => set({ matches })} />}
            {f.which === "SPECIFIC_FIELDS" && <FieldPicker selected={f.fields} onChange={(fields) => set({ fields })} />}
          </div>
        </div>

        <div className="dfoot">
          {summary ? <span className="summary" data-testid="f-summary"><b>WHAT THIS DOES</b>{summary}</span>
                   : <span className="summary bad" data-testid="f-summary"><b>WHAT THIS DOES</b>Enter a code and a value and this line will say, in plain words, exactly what you are about to create.</span>}
          {submitErr && <span className="dupe" data-testid="f-submiterr">{submitErr}</span>}
          <span className="dbtns"><span className="sp" />
            <button className="btn" data-testid="f-cancel" onClick={onClose}>Cancel</button>
            <button className="btn primary" data-testid="f-create" disabled={!valid || submitting} onClick={submit}>{submitting ? "Creating…" : "Create promo code"}</button>
          </span>
        </div>
      </div>
    </div>
  );
}

// ── D2: Specific Users — reuses the universal player search (/api/lookup/{env}?q=), which fuzzy-
//    matches email, name AND phone digits. Multi-select with removable chips. ──
function UserPicker({ selected, onChange }: { selected: PickedUser[]; onChange: (u: PickedUser[]) => void }) {
  const [q, setQ] = useState(""); const [results, setResults] = useState<PickedUser[]>([]); const [loading, setLoading] = useState(false);
  const qref = useRef(q); useEffect(() => { qref.current = q; }, [q]);
  useEffect(() => {
    const term = q.trim(); if (term.length < 2) { setResults([]); return; }
    setLoading(true);
    const t = setTimeout(async () => {
      try { const res = await authFetch(`/api/lookup/production?q=${encodeURIComponent(term)}`); const j = await res.json();
        if (qref.current.trim() !== term) return;
        setResults((j.results ?? []).map((r: Record<string, unknown>) => ({ id: Number(r.id), name: String(r.name ?? `User ${r.id}`), email: String(r.email ?? ""), phone: String(r.phone ?? ""), city: String(r.city ?? "") })));
      } catch { /* ignore */ } finally { if (qref.current.trim() === term) setLoading(false); }
    }, 300);
    return () => clearTimeout(t);
  }, [q]);
  const add = (u: PickedUser) => { if (!selected.some((s) => s.id === u.id)) onChange([...selected, u]); };
  const remove = (id: number) => onChange(selected.filter((s) => s.id !== id));
  return (
    <div className="pk" data-testid="user-picker">
      <input className="pk-search" data-testid="user-search" placeholder="Search users by name, email or phone" value={q} onChange={(e) => setQ(e.target.value)} />
      {selected.length > 0 && <div className="pk-chips" data-testid="user-chips">{selected.map((u) => <span key={u.id} className="pk-chip">{u.name}<button type="button" aria-label={`Remove ${u.name}`} onClick={() => remove(u.id)}>×</button></span>)}</div>}
      {q.trim().length >= 2 && <div className="pk-results" data-testid="user-results">
        {loading ? <div className="pk-empty">Searching…</div> : results.length === 0 ? <div className="pk-empty">No matching users.</div> :
          results.map((u) => <button type="button" key={u.id} className="pk-row" data-testid={`user-opt-${u.id}`} disabled={selected.some((s) => s.id === u.id)} onClick={() => add(u)}>
            <span className="pk-name">{u.name}</span><span className="pk-meta">{[u.email, u.phone, u.city].filter(Boolean).join(" · ")}</span></button>)}
      </div>}
    </div>
  );
}

// ── D3: Specific Matches — date range (defaults to the promo window) + city filter, multi-select. ──
function MatchPicker({ selected, promoFrom, promoTo, onChange }: { selected: PickedMatch[]; promoFrom: string; promoTo: string; onChange: (m: PickedMatch[]) => void }) {
  const [from, setFrom] = useState(promoFrom); const [to, setTo] = useState(promoTo); const [city, setCity] = useState("");
  const [data, setData] = useState<{ matches: PickedMatch[]; cities: { id: number; name: string }[] }>({ matches: [], cities: [] });
  const [loading, setLoading] = useState(false); const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setLoading(true); setErr(null);
    const t = setTimeout(async () => {
      try { const res = await authFetch(`/api/promos/matches?from=${from}&to=${to}`); const j = await res.json();
        if (!res.ok) { setErr(j.error || "couldn't load matches"); setData({ matches: [], cities: [] }); } else setData({ matches: j.matches ?? [], cities: j.cities ?? [] });
      } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setLoading(false); }
    }, 350);
    return () => clearTimeout(t);
  }, [from, to]);
  const shown = data.matches.filter((m) => !city || String((m as PickedMatch & { cityId?: number }).cityId) === city);
  const add = (m: PickedMatch) => { if (!selected.some((s) => s.id === m.id)) onChange([...selected, m]); };
  const remove = (id: number) => onChange(selected.filter((s) => s.id !== id));
  return (
    <div className="pk" data-testid="match-picker">
      <div className="pk-filters">
        <input type="date" data-testid="match-from" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Matches from date" />
        <input type="date" data-testid="match-to" value={to} onChange={(e) => setTo(e.target.value)} aria-label="Matches to date" />
        <select data-testid="match-city" value={city} onChange={(e) => setCity(e.target.value)} aria-label="City"><option value="">All cities</option>{data.cities.map((c) => <option key={c.id} value={String(c.id)}>{c.name}</option>)}</select>
      </div>
      {selected.length > 0 && <div className="pk-chips" data-testid="match-chips">{selected.map((m) => <span key={m.id} className="pk-chip">{m.name}<button type="button" aria-label={`Remove ${m.name}`} onClick={() => remove(m.id)}>×</button></span>)}</div>}
      <div className="pk-results" data-testid="match-results">
        {loading ? <div className="pk-empty">Loading matches…</div> : err ? <div className="pk-empty">{err}</div> : shown.length === 0 ? <div className="pk-empty">No matches in this range/city.</div> :
          shown.slice(0, 60).map((m) => <button type="button" key={m.id} className="pk-row" data-testid={`match-opt-${m.id}`} disabled={selected.some((s) => s.id === m.id)} onClick={() => add(m)}>
            <span className="pk-name">{m.name}</span><span className="pk-meta">{[m.venue, m.city, m.kickoffUtc ? fmtChicagoFull(m.kickoffUtc) : null].filter(Boolean).join(" · ")}</span></button>)}
      </div>
    </div>
  );
}

// ── D4: Specific Fields — grouped by city, multi-select toggle chips. ──
function FieldPicker({ selected, onChange }: { selected: PickedField[]; onChange: (f: PickedField[]) => void }) {
  const [data, setData] = useState<PickedField[]>([]); const [q, setQ] = useState(""); const [loading, setLoading] = useState(true); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { (async () => {
    try { const res = await authFetch(`/api/promos/fields`); const j = await res.json();
      if (!res.ok) setErr(j.error || "couldn't load fields"); else setData((j.fields ?? []).map((f: Record<string, unknown>) => ({ id: Number(f.id), title: String(f.title), city: String(f.city) })));
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setLoading(false); }
  })(); }, []);
  const shown = data.filter((f) => !q.trim() || `${f.title} ${f.city}`.toLowerCase().includes(q.trim().toLowerCase()));
  const cities = [...new Set(shown.map((f) => f.city))];
  const toggle = (fl: PickedField) => selected.some((s) => s.id === fl.id) ? onChange(selected.filter((s) => s.id !== fl.id)) : onChange([...selected, fl]);
  return (
    <div className="pk" data-testid="field-picker">
      <input className="pk-search" data-testid="field-search" placeholder="Filter fields by name or city" value={q} onChange={(e) => setQ(e.target.value)} />
      {selected.length > 0 && <div className="pk-chips" data-testid="field-chips">{selected.map((fl) => <span key={fl.id} className="pk-chip">{fl.title}<button type="button" aria-label={`Remove ${fl.title}`} onClick={() => toggle(fl)}>×</button></span>)}</div>}
      <div className="pk-results" data-testid="field-results">
        {loading ? <div className="pk-empty">Loading fields…</div> : err ? <div className="pk-empty">{err}</div> : cities.length === 0 ? <div className="pk-empty">No fields.</div> :
          cities.map((c) => <div key={c} className="pk-group"><div className="pk-gh">{c}</div>{shown.filter((f) => f.city === c).map((fl) => <button type="button" key={fl.id} className={"pk-row" + (selected.some((s) => s.id === fl.id) ? " on" : "")} data-testid={`field-opt-${fl.id}`} onClick={() => toggle(fl)}><span className="pk-name">{fl.title}</span></button>)}</div>)}
      </div>
    </div>
  );
}

const CSS = `
.promo{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Helvetica,Arial,sans-serif;color:#0e1a13;background:#f2f6f4;min-height:100vh}
.promo *{box-sizing:border-box}
.promo .wrap{max-width:1200px;margin:0 auto;padding:16px 16px 72px}
.promo .head{background:#fff;border:1px solid #dde6e1;border-radius:14px;padding:16px 18px;margin-bottom:14px}
.promo .htop{display:flex;align-items:flex-start;gap:14px;flex-wrap:wrap}
.promo .h1{font-size:23px;font-weight:700;letter-spacing:-.02em;margin:0}
.promo .hsub{color:#3d5349;margin:2px 0 0;font-size:13.5px}
.promo .btn{border:1px solid #cbd8d1;background:#fff;border-radius:11px;padding:0 16px;font:inherit;font-weight:700;cursor:pointer;color:#3d5349;min-height:42px;white-space:nowrap}
.promo .btn:hover{background:#f6faf8}
.promo .btn.primary{background:#12301f;border-color:#12301f;color:#fff;margin-left:auto}
.promo .btn.primary:hover{background:#1b4630}
.promo .btn:disabled{opacity:.45;cursor:not-allowed}
.promo .srow{display:flex;gap:10px;margin-top:14px}
.promo .sbox{flex:1 1 auto;min-width:0;position:relative;display:flex}
.promo .sbox input{width:100%;min-width:0;border:1px solid #cbd8d1;border-radius:11px;padding:11px 14px 11px 38px;font:inherit;font-size:15px;background:#fbfdfc;color:#0e1a13}
.promo .sbox input:focus{outline:2px solid #0b6bcb;outline-offset:-1px;background:#fff}
.promo .sicon{position:absolute;left:13px;top:50%;transform:translateY(-50%);color:#5c7168;pointer-events:none}
.promo .hint{margin:9px 2px 0;font-size:12.5px;color:#5c7168}.promo .hint b{color:#3d5349}
.promo .grp{margin-bottom:16px}
.promo .ghead{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:0 2px 9px;width:100%;text-align:left}
.promo .gtitle{font-size:11px;font-weight:800;letter-spacing:.13em;color:#0e1a13}
.promo .gsub{font-size:12.5px;color:#5c7168;font-variant-numeric:tabular-nums}
.promo .nosort{color:#8a5600;font-weight:600}
.promo .gsub.pasthit{font-weight:700;color:#b3241f}
.promo .gtoggle{border:1px solid #dde6e1;background:#fff;border-radius:12px;font:inherit;cursor:pointer;padding:11px 14px}
.promo .gtoggle:hover{background:#f7fbf9}.promo .gtoggle:focus-visible{outline:2px solid #0b6bcb;outline-offset:2px}
.promo .caret{color:#5c7168;font-size:11px;width:11px;display:inline-block}
.promo .grp.slim .colhead{display:none}
.promo .grp.slim .empty.oneline{padding:13px 15px;text-align:left}
.promo .grp.slim .empty.oneline b{display:inline;margin:0}.promo .grp.slim .empty.oneline b::after{content:" — "}
.promo .sheet{background:#fff;border:1px solid #dde6e1;border-radius:14px;overflow:hidden}
.promo .tzbar{padding:8px 16px;background:#e8f0fa;border-bottom:1px solid #a8c4e6;color:#123a6b;font-size:11.5px;font-weight:600}
.promo .tzbar b{font-weight:800}
.promo .colhead,.promo .r{display:grid;gap:12px;align-items:center;grid-template-columns:5px 150px 92px 138px 80px minmax(110px,1fr) 66px 84px 88px;padding:0 16px 0 0}
.promo .colhead{padding-top:9px;padding-bottom:9px;background:#fafcfb;border-bottom:1px solid #dde6e1;font-size:10px;font-weight:800;letter-spacing:.11em;color:#5c7168}
.promo .colhead>span{display:block}.promo .colhead .ra{text-align:right}
.promo .cr{display:block;font-size:12.5px;color:#3d5349;font-variant-numeric:tabular-nums;white-space:nowrap}
.promo .cr small{display:block;font-size:11px;color:#146c43;font-weight:700}
.promo .uses.red{display:block;text-align:right}
.promo .uses.red.zero{color:#5c7168}.promo .uses.red.loading{color:#5c7168}
.promo .red-retry{display:inline-flex;align-items:center;justify-content:center;min-width:26px;min-height:26px;border-radius:6px;border:1px solid #f0a9a4;background:#fdecea;color:#b3241f;font-weight:800;cursor:pointer;font-size:13px}
.promo .red-retry:hover{background:#fbdcd8}.promo .red-retry:focus-visible{outline:2px solid #0b6bcb;outline-offset:1px}
.promo .cell.c-usemob{display:none}/* beat .cell{display:block} (same specificity, later source) — desktop hide must win regardless of rule order */
.promo .r{width:100%;text-align:left;border:0;border-bottom:1px solid #dde6e1;background:#fff;font:inherit;color:inherit;cursor:pointer}
.promo .r:last-child{border-bottom:0}.promo .r:hover{background:#f7fbf9}.promo .r:focus-visible{outline:2px solid #0b6bcb;outline-offset:-2px}
.promo .rail{align-self:stretch;display:block;background:#cbd8d1}
.promo .r.active .rail{background:#146c43}.promo .r.scheduled .rail{background:#1d4f8f}.promo .r.expired .rail{background:#c3cfc9}.promo .r.deleted .rail{background:#b3241f}
.promo .r.deleted{background:#fdf7f6}
.promo .cell{display:block;padding:10px 0;min-width:0}
.promo .code{display:block;font-weight:700;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13.5px}
.promo .r.deleted .code{text-decoration:line-through;text-decoration-color:rgba(179,36,31,.5)}
.promo .newtag{margin-left:7px;background:#e6f4ec;color:#146c43;border:1px solid #9fd3b6;font-size:9px;font-weight:800;letter-spacing:.05em;padding:1px 5px;border-radius:4px;vertical-align:1px;font-family:-apple-system,sans-serif}
.promo .newtag.idtag{background:#e8f0fa;color:#1d4f8f;border-color:#a8c4e6}
.promo .cid{display:block;font-size:11.5px;color:#5c7168;font-variant-numeric:tabular-nums}
.promo .win{display:block;font-size:11.5px;color:#3d5349;font-variant-numeric:tabular-nums;white-space:nowrap}.promo .win small{display:block;font-size:11px;color:#5c7168;white-space:nowrap}
.promo .val{display:block;font-weight:700;font-variant-numeric:tabular-nums}.promo .val small{display:block;font-size:11px;font-weight:600;color:#5c7168;letter-spacing:.04em}
.promo .who{display:block;font-size:12.5px;color:#3d5349}.promo .who small{display:block;font-size:11px;color:#5c7168}
.promo .uses{display:block;text-align:right;font-variant-numeric:tabular-nums;font-size:13px;color:#3d5349}
.promo .st{display:inline-flex;align-items:center;justify-content:center;padding:3px 6px;border-radius:6px;font-size:10.5px;font-weight:800;letter-spacing:.04em;border:1px solid;white-space:nowrap}
.promo .st.active{background:#e6f4ec;color:#146c43;border-color:#9fd3b6}
.promo .st.scheduled{background:#e8f0fa;color:#1d4f8f;border-color:#a8c4e6}
.promo .st.expired{background:#f0f4f2;color:#3d5349;border-color:#cbd8d1}
.promo .st.deleted{background:#fdecea;color:#b3241f;border-color:#f0a9a4}
.promo .more{display:flex;align-items:center;gap:12px;padding:12px 16px;background:#fafcfb;border-top:1px solid #dde6e1;font-size:12.5px;color:#5c7168}
.promo .more .btn{min-height:34px;padding:0 13px;font-size:12.5px}
.promo .empty{padding:34px 16px;text-align:center;color:#5c7168}.promo .empty b{display:block;color:#3d5349;margin-bottom:4px}
.promo .empty.err{color:#b3241f}
.promo .foot{margin-top:10px;color:#5c7168;font-size:12px;padding:0 2px}
/* drawer */
.promo .scrim{position:fixed;inset:0;background:rgba(9,24,17,.42);z-index:60;display:flex;justify-content:flex-end}
.promo .drawer{background:#fff;width:min(560px,100%);height:100%;overflow:auto;display:flex;flex-direction:column}
.promo .dhead{display:flex;align-items:center;gap:10px;padding:15px 18px;border-bottom:1px solid #dde6e1;position:sticky;top:0;background:#fff;z-index:2}
.promo .dhead h2{margin:0;font-size:18px;letter-spacing:-.02em}
.promo .dhead .x{margin-left:auto;border:0;background:none;font-size:22px;line-height:1;color:#5c7168;min-width:44px;min-height:44px;cursor:pointer}
.promo .dbody{padding:16px 18px;flex:1 1 auto}
.promo .dfoot{border-top:1px solid #dde6e1;background:#fafcfb;position:sticky;bottom:0}
.promo .dbtns{display:flex;gap:10px;align-items:center;padding:12px 18px;flex-wrap:wrap}.promo .dfoot .sp{flex:1 1 auto}
.promo .dcode{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:14px}.promo .code.big{font-size:18px}.promo .st.inline{font-size:10px}
.promo .usebox{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:10px}
.promo .usecol{background:#f6faf8;border:1px solid #dde6e1;border-radius:10px;padding:10px 12px}
.promo .ul{display:block;font-size:9.5px;font-weight:800;letter-spacing:.11em;color:#5c7168;margin-bottom:4px}
.promo .uv{display:block;font-size:19px;font-weight:800;font-variant-numeric:tabular-nums;color:#0e1a13}
.promo .uv.left-over{color:#8a5600}.promo .uv.left-spent{color:#b42318}
.promo .useline{margin:0 0 16px;font-size:12.5px;color:#3d5349;font-variant-numeric:tabular-nums}
.promo .facts{margin:0;display:grid;gap:11px}.promo .facts div{display:grid;grid-template-columns:96px 1fr;gap:10px}
.promo .facts dt{font-size:10px;font-weight:800;letter-spacing:.1em;color:#5c7168;padding-top:2px}
.promo .facts dd{margin:0;font-size:13.5px;color:#0e1a13}.promo .facts small{display:block;font-size:11px;color:#5c7168}
.promo .tzline{display:block;padding:9px 12px;border-radius:10px;background:#e8f0fa;border:1px solid #a8c4e6;color:#123a6b;font-size:12.5px;margin-bottom:16px}.promo .tzline b{font-weight:800}
.promo .fgrid{display:grid;grid-template-columns:1fr 1fr;gap:13px}.promo .fgrid.one{grid-template-columns:1fr}
.promo .fld{display:block;min-width:0}
.promo .fld .lb{display:flex;align-items:baseline;gap:6px;font-size:10px;font-weight:800;letter-spacing:.11em;color:#5c7168;margin-bottom:5px}
.promo .fld .lb .req{color:#b3241f}
.promo .fld .lb .auto{margin-left:auto;font-size:9.5px;font-weight:800;letter-spacing:.06em;color:#146c43;background:#e6f4ec;border:1px solid #9fd3b6;border-radius:5px;padding:1px 5px}
.promo .fld input,.promo .fld select{width:100%;min-width:0;border:1px solid #cbd8d1;border-radius:10px;padding:10px 12px;font:inherit;background:#fbfdfc;color:#0e1a13;min-height:44px}
.promo .fld input:focus{outline:2px solid #0b6bcb;outline-offset:-1px;background:#fff}
.promo .fld input.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.promo .fld input[aria-invalid="true"]{border-color:#f0a9a4;background:#fffafa}
.promo .fld .help{display:block;margin-top:5px;font-size:11.5px;color:#5c7168}.promo .fld .help.ok{color:#146c43;font-weight:600}
.promo .fld .err{display:block;margin-top:5px;font-size:11.5px;color:#b3241f;font-weight:600}
.promo .presets{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
.promo .pbtn{border:1px solid #cbd8d1;background:#fff;border-radius:8px;padding:0 9px;min-height:32px;font:inherit;font-size:11.5px;font-weight:600;color:#3d5349;cursor:pointer}
.promo .pbtn:hover{background:#f4f8f6}
.promo .seg{display:inline-flex;border:1px solid #cbd8d1;border-radius:10px;overflow:hidden;background:#fbfdfc;width:100%}
.promo .seg button{flex:1 1 0;border:0;background:transparent;min-height:44px;font:inherit;font-size:13px;font-weight:700;color:#3d5349;cursor:pointer}
.promo .seg button+button{border-left:1px solid #cbd8d1}
.promo .seg button[aria-pressed="true"]{background:#12301f;color:#fff}
.promo .radios{display:flex;gap:7px;flex-wrap:wrap}
.promo .rad{border:1px solid #cbd8d1;background:#fff;border-radius:999px;padding:0 13px;min-height:44px;font:inherit;font-size:12.5px;font-weight:600;color:#3d5349;cursor:pointer;display:inline-flex;align-items:center}
.promo .rad[aria-pressed="true"]{background:#12301f;border-color:#12301f;color:#fff}.promo .rad:disabled{opacity:.4;cursor:not-allowed}
.promo .sect{margin-top:18px;padding-top:15px;border-top:1px solid #dde6e1}.promo .sect h3{margin:0 0 11px;font-size:10.5px;font-weight:800;letter-spacing:.12em;color:#5c7168}
/* scope pickers */
.promo .pk{margin-top:12px}
.promo .pk-filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:9px}
.promo .pk-filters input,.promo .pk-filters select{flex:1 1 auto;min-width:0;border:1px solid #cbd8d1;border-radius:9px;padding:8px 10px;font:inherit;font-size:13px;background:#fbfdfc;color:#0e1a13;min-height:40px}
.promo .pk-search{width:100%;border:1px solid #cbd8d1;border-radius:9px;padding:9px 11px;font:inherit;font-size:14px;background:#fbfdfc;color:#0e1a13;min-height:42px}
.promo .pk-search:focus{outline:2px solid #0b6bcb;outline-offset:-1px;background:#fff}
.promo .pk-chips{display:flex;flex-wrap:wrap;gap:6px;margin:9px 0}
.promo .pk-chip{display:inline-flex;align-items:center;gap:5px;background:#e6f4ec;border:1px solid #9fd3b6;color:#0d4a2e;border-radius:999px;padding:3px 5px 3px 11px;font-size:12.5px;font-weight:600}
.promo .pk-chip button{border:0;background:none;color:#146c43;font-size:16px;line-height:1;cursor:pointer;min-width:24px;min-height:24px}
.promo .pk-results{margin-top:9px;max-height:230px;overflow-y:auto;border:1px solid #dde6e1;border-radius:10px}
.promo .pk-row{display:block;width:100%;text-align:left;border:0;border-bottom:1px solid #eef3f0;background:#fff;padding:9px 12px;font:inherit;cursor:pointer;min-height:44px}
.promo .pk-row:last-child{border-bottom:0}.promo .pk-row:hover{background:#f4f8f6}.promo .pk-row:disabled{opacity:.5;cursor:not-allowed}
.promo .pk-row.on{background:#e6f4ec}
.promo .pk-name{display:block;font-weight:700;font-size:13.5px;color:#0e1a13}
.promo .pk-meta{display:block;font-size:11.5px;color:#5c7168;margin-top:1px}
.promo .pk-empty{padding:14px 12px;text-align:center;color:#5c7168;font-size:13px}
.promo .pk-group .pk-gh{position:sticky;top:0;background:#fafcfb;border-bottom:1px solid #dde6e1;padding:6px 12px;font-size:10px;font-weight:800;letter-spacing:.1em;color:#5c7168}
.promo .summary{display:block;margin:0;padding:12px 18px;background:#e6f4ec;border-bottom:1px solid #9fd3b6;color:#0d4a2e;font-size:13px;line-height:1.45}
.promo .summary b{display:block;font-size:10px;letter-spacing:.12em;margin-bottom:4px;color:#0f5c39}
.promo .summary.bad{background:#fdf2e0;border-bottom-color:#e8c383;color:#6b4400}.promo .summary.bad b{color:#7a4d00}
.promo .dupe{display:block;margin:6px 18px 0;padding:9px 12px;border-radius:10px;background:#fdecea;border:1px solid #f0a9a4;color:#7d1a16;font-size:12.5px}.promo .dupe b{font-weight:800}
.promo .toast{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);background:#12301f;color:#fff;padding:12px 18px;border-radius:11px;font-size:13.5px;font-weight:600;z-index:80;box-shadow:0 10px 26px rgba(6,20,13,.3)}

@media (max-width:820px){
  .promo .wrap{padding:10px 10px 60px}
  .promo .head{padding:14px}
  /* §9g — every interactive element is at least 44px on its short axis on the phone */
  .promo .btn,.promo .gtoggle,.promo .pbtn,.promo .more .btn{min-height:44px}
  .promo .colhead{display:none}
  /* CREATED, CAP and REDEEMED collapse into one usage line on the card; WINDOW stays. */
  .promo .r{grid-template-columns:5px 1fr auto;grid-template-areas:"rail code st" "rail win st" "rail val val" "rail who who" "rail usemob usemob";gap:0 11px;padding:0 12px 0 0}
  .promo .rail{grid-area:rail}
  .promo .c-code{grid-area:code;padding:9px 0 0}.promo .c-win{grid-area:win;padding:2px 0 0}
  .promo .c-val{grid-area:val;padding:6px 0 0}.promo .c-who{grid-area:who;padding:2px 0 0}
  .promo .c-created,.promo .c-cap,.promo .c-redeemed{display:none}
  .promo .cell.c-usemob{display:block;grid-area:usemob;padding:5px 0 10px;font-size:12px;color:#3d5349;font-variant-numeric:tabular-nums}
  .promo .c-st{grid-area:st;padding:9px 0 0;align-self:start}
  .promo .win,.promo .who{white-space:normal}
  .promo .win small{white-space:normal}
  .promo .code{white-space:normal;overflow-wrap:anywhere}
  .promo .fgrid{grid-template-columns:1fr}
  .promo .usebox{grid-template-columns:1fr 1fr 1fr}
  .promo .drawer{width:100%}
  .promo .dbtns{flex-wrap:nowrap}.promo .dbtns .btn{flex:1 1 0;padding:0 10px}.promo .btn.primary{margin-left:0;flex:2 1 0}
  .promo .toast{left:12px;right:12px;transform:none;text-align:center}
}
`;
