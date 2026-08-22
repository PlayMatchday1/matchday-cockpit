"use client";

// PLAYER FINDER — set parameters, get the players.
//
// IT *IS* REGISTERED PLAYERS. With nothing set it is the same list as before: every registered
// player, newest first. Two tables over the same 30,245 people is two places to be wrong, so the
// finder replaced that table rather than sitting above it.
//
// THE STATS BAND IS THE ANSWER; THE TABLE IS THE EXPORT. "How many Warsaw signups have never
// played" is the question. Nobody reads 30,245 rows.
//
// NOTHING IS FILTERED OR COUNTED HERE. Every figure on this screen — the header count, all six
// tiles, the occupancy figures — comes from the server, computed over the whole filtered set. This
// component holds one page of rows at a time and could not count anything if it tried. A browser
// filtering the 50 rows it happens to hold reports a confident wrong number for the other 30,195.
//
// THERE IS NO reachable / has-phone / has-email FILTER. 98% of players have one or the other, so
// it never narrowed anything. Phone and email are COLUMNS — worth seeing, not worth filtering on.
// If it ever comes back, that is why it went.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";

type Player = {
  id: number; name: string | null; email: string | null; phone: string | null;
  city: string | null; registered: string | null; last_match: string | null;
  member: boolean; plays: number;
};

type Stats = {
  players: number; never: number; members: number; week: number; month30: number;
  heavy: number; named: number; cities: number;
  topCity: { name: string; n: number } | null;
  medianAgeDays: number | null; newest: string | null;
  // NULL when there is no window to total — a negation, or a set with no spots. Never 0.
  spots: number | null; matches: number | null; matchesFull: number | null; capacity: number | null;
};

type Payload = {
  players: Player[]; total: number; page: number; size: number;
  // WHAT THE SERVER APPLIED. The controls light from this rather than from local state, so a
  // preset the server overrode cannot stay lit and a suppressed play window is visibly suppressed.
  applied: { q: string | null; reg: string; regFrom: string | null; regTo: string | null;
    hist: string; play: string; playFrom: string | null; playTo: string | null;
    playMode: string; playSuppressed: boolean; member: string; city: string | null };
  stats: Stats; scope: string | null; scopeName: string | null; confined: boolean;
  syncedAt: string | null; error?: string;
};

type Filters = {
  q: string; reg: string; regFrom: string; regTo: string;
  hist: string; play: string; playFrom: string; playTo: string;
  city: string; member: string;
};

const DEFAULTS: Filters = {
  q: "", reg: "all", regFrom: "", regTo: "",
  hist: "any", play: "all", playFrom: "", playTo: "", city: "", member: "any",
};

/* ── THE TWO WINDOW ROWS ARE THE SAME CONTROL TWICE ───────────────────────────────────────────
 * Identical shape, identical override rules, one renderer — a preset strip plus a from–to pair.
 * The ONE difference is `not60`, and it is a difference of meaning rather than of layout: a
 * negation needs a set of events to be false across, and signing up is a single event. There is
 * nothing to negate on the SIGNED UP row, so it is not offered there. */
const REG_OPTS: [string, string][] = [["7", "Last 7 days"], ["30", "Last 30 days"], ["90", "Last 90 days"], ["all", "All time"]];
const PLAY_OPTS: [string, string][] = [...REG_OPTS.slice(0, 3), ["all", "Any time"], ["not60", "Not in 60+ days"]];
// HISTORY IS A COUNT, NOT A CLOCK. "Played in 30d" and "Lapsed 60d+" moved to the PLAYED row where
// they are the general case; nothing here may carry a time word or a day count.
const HIST_OPTS: [string, string][] = [["any", "Any"], ["never", "Never played"], ["once", "Played once"], ["multi", "Played 2+"]];
const MEM_OPTS: [string, string][] = [["any", "Any"], ["yes", "Members"], ["no", "Non-members"]];

// The city select offers IDENTIFIERS, because that is what the server's allowlist accepts. A name
// typed here would be refused, which is the point — the filter is a convenience, the scope is the
// boundary, and only the server decides.
const CITIES: [string, string][] = [
  ["ATL", "Atlanta"], ["ATX", "Austin"], ["DFW", "Dallas / Fort Worth"], ["HOU", "Houston"],
  ["OKC", "Oklahoma City"], ["SATX", "San Antonio"], ["STL", "St. Louis"], ["WAW", "Warsaw"],
];

const N = (v: number | null | undefined) => (v == null ? "—" : v.toLocaleString());

const fmtDate = (iso: string | null): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
};

const fmtWhen = (iso: string | null): string => {
  if (!iso) return "unknown";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown";
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  return `${Math.round(hrs / 24)} day${Math.round(hrs / 24) === 1 ? "" : "s"} ago`;
};

type Tile = { k: string; v: string; s: string; dead: boolean };

export default function PlayerFinder({ onOpen }: { onOpen?: (id: number) => void }) {
  const [f, setF] = useState<Filters>(DEFAULTS);
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(true);
  const [exporting, setExporting] = useState(false);
  const size = 50;
  const seq = useRef(0);

  const query = useCallback((extra: Record<string, string> = {}) => {
    const p = new URLSearchParams();
    if (f.q) p.set("q", f.q);
    // THE PRESET AND THE RANGE ARE MUTUALLY EXCLUSIVE and the server enforces it; sending both
    // would leave the client lighting one control while the server applied the other.
    if (f.regFrom || f.regTo) {
      if (f.regFrom) p.set("regFrom", f.regFrom);
      if (f.regTo) p.set("regTo", f.regTo);
    } else if (f.reg !== "all") p.set("reg", f.reg);
    if (f.hist !== "any") p.set("hist", f.hist);
    // THE SAME RULE AS SIGNED UP: an explicit range beats the preset, and only one is ever sent.
    if (f.playFrom || f.playTo) {
      if (f.playFrom) p.set("playFrom", f.playFrom);
      if (f.playTo) p.set("playTo", f.playTo);
    } else if (f.play !== "all") p.set("play", f.play);
    if (f.city) p.set("city", f.city);
    if (f.member !== "any") p.set("member", f.member);
    for (const [k, v] of Object.entries(extra)) p.set(k, v);
    return p.toString();
  }, [f]);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true); setErr(null);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      const res = await fetch(`/api/players/finder?${query({ page: String(page), size: String(size) })}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {}, cache: "no-store",
      });
      const json = (await res.json()) as Payload;
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      // A SLOW EARLIER REQUEST MUST NOT LAND ON TOP OF A NEWER ONE. Typing in the search box fires
      // several; without this the box can end up showing the results for a prefix of what it says.
      if (mine === seq.current) setData(json);
    } catch (e) {
      if (mine === seq.current) setErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [query, page]);

  useEffect(() => { void load(); }, [load]);
  // Any filter change starts again at page one — page 4 of a different question is not a page.
  useEffect(() => { setPage(1); }, [f]);

  const dirty = useMemo(() => (Object.keys(DEFAULTS) as (keyof Filters)[]).some((k) => f[k] !== DEFAULTS[k]), [f]);
  const st = data?.stats;
  const total = data?.total ?? 0;
  const applied = data?.applied;
  const range = !!(f.regFrom || f.regTo);

  /* ── THE BAND ────────────────────────────────────────────────────────────────────────────────
   * A tile whose value is FORCED by an active filter tells you nothing you did not just type. With
   * City = Warsaw, a "Top city: Warsaw" tile is the filter row read back at you. Each metric
   * declares when it is dead; dead ones are dropped and the grid gets NARROWER rather than padding
   * itself to six with filler.
   *
   * The occupancy three rank straight after Players whenever the selection is about who plays —
   * otherwise they never reach the six visible slots, and they are the answer to the question that
   * prompted this. */
  const tiles = useMemo<Tile[]>(() => {
    if (!st) return [];
    const pc = (v: number) => (total ? `${Math.round((v / total) * 100)}% of these` : "—");
    /* THE OCCUPANCY TILES ARE DROPPED, NOT ZEROED, in two cases, and the server decides both by
     * sending null rather than a number: HISTORY = never played (there are no spots), and
     * PLAYED = Not in 60+ days (a negation has no window to total, and a figure labelled with one
     * would be lying about its own scope). */
    const noPlay = f.hist === "never" || st.spots == null;
    // THE TILE NAMES ITS OWN WINDOW. A number whose scope is only knowable from a control three
    // rows up is a number waiting to be quoted wrongly.
    const winWord = f.playFrom || f.playTo
      ? `${f.playFrom || "the start"} → ${f.playTo || "today"}`
      : f.play === "all" ? "all time"
      : (PLAY_OPTS.find(([v]) => v === f.play)?.[1] ?? f.play).toLowerCase();

    const OCC: Tile[] = [
      { k: "Spots occupied", v: N(st.spots),
        s: st.capacity ? `${Math.round(((st.spots ?? 0) / st.capacity) * 100)}% of the ${N(st.capacity)} spots in those matches` : "—",
        dead: noPlay },
      { k: "Matches", v: N(st.matches), s: `they appear in · ${winWord}`, dead: noPlay },
      { k: "Matches full", v: st.matches ? `${Math.round(((st.matchesFull ?? 0) / st.matches) * 100)}%` : "—",
        // SPELLED OUT so nobody has to trust a bare percentage.
        s: st.matches ? `${N(st.matchesFull)} of ${N(st.matches)} they played in` : "—", dead: noPlay },
    ];
    const POOL: Tile[] = [
      { k: "Players", v: N(total), s: dirty ? "matching your filters" : "all registered", dead: false },
      { k: "Never played", v: N(st.never), s: pc(st.never), dead: f.hist !== "any" },
      { k: "Members", v: N(st.members), s: pc(st.members), dead: f.member !== "any" || f.hist === "never" },
      { k: "New this week", v: N(st.week), s: "signed up in the last 7 days", dead: f.reg === "7" || range },
      { k: "Top city", v: st.topCity?.name ?? "—", s: st.topCity ? `${N(st.topCity.n)} players` : "—", dead: !!f.city },
      { k: "Played 2+", v: N(st.heavy), s: pc(st.heavy), dead: f.hist !== "any" },
      { k: "New in 30 days", v: N(st.month30), s: pc(st.month30), dead: f.reg === "7" || f.reg === "30" || range },
      { k: "Cities", v: N(st.cities), s: "represented here", dead: !!f.city },
      { k: "Has a name", v: N(st.named), s: pc(st.named), dead: false },
      { k: "Median signup age", v: st.medianAgeDays == null ? "—" : `${st.medianAgeDays}d`, s: "half are older than this", dead: false },
      { k: "Newest signup", v: fmtDate(st.newest), s: "most recent", dead: false },
    ];
    const hot = f.member !== "any" || f.hist !== "any" || f.play !== "all" || !!(f.playFrom || f.playTo);
    const full = hot ? [POOL[0], ...OCC, ...POOL.slice(1)] : [...POOL, ...OCC];
    // BACKSTOP for implications the predicates do not know about: "97 of 97" is never news whatever
    // produced it. A zero can still be news, so zeros stay.
    return full.filter((t, i) => !t.dead && !(i > 0 && total > 0 && t.v === N(total))).slice(0, 6);
  }, [st, total, f, dirty, range]);

  const clear = () => setF(DEFAULTS);

  const doExport = async () => {
    setExporting(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      // THE WHOLE FILTERED SET, not the page. Exporting the fifty rows on screen is useless for the
      // outreach this exists for.
      const res = await fetch(`/api/players/finder?${query({ export: "1" })}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {}, cache: "no-store",
      });
      const json = (await res.json()) as { players?: Player[]; error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      const rows = json.players ?? [];
      const csv = [
        ["id", "name", "email", "phone", "preferred_city", "registered", "last_match", "member"].join(","),
        ...rows.map((r) => [r.id, r.name ?? "", r.email ?? "", r.phone ?? "", r.city ?? "", r.registered ?? "", r.last_match ?? "", r.member ? "yes" : "no"]
          .map((v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v))).join(",")),
      ].join("\n");
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
      const a = document.createElement("a");
      a.href = url; a.download = `players-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click(); URL.revokeObjectURL(url);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  };

  /**
   * ONE WINDOW ROW, RENDERED TWICE. A preset strip plus a from–to pair, with the rules that keep them
   * from both being lit: picking a preset empties the dates, typing a date drops the preset back to
   * its default. `disabled` dims the whole row and states why rather than hiding it.
   *
   * IT LIVES INSIDE THE COMPONENT, AND THAT IS LOAD-BEARING. styled-jsx's transform is LEXICAL: it
   * adds the scoped class to JSX written inside the component that declares the <style jsx> block.
   * As a top-level `function WindowRow(...)` both window rows rendered with className="" and NONE
   * of this card's styles — no pill segments, no padding — while the History row beside them was
   * styled correctly. `pointer-events: none` on the disabled state silently did nothing too, which
   * is how the suite caught it. Moving the call site did not help; only moving the DECLARATION did.
   */
  const windowRow = ({ label, name, opts, preset, from, to, disabled = false, why, onPreset, onFrom, onTo }: {
    label: string; name: string; opts: [string, string][];
    preset: string; from: string; to: string; disabled?: boolean; why?: string;
    onPreset: (v: string) => void; onFrom: (v: string) => void; onTo: (v: string) => void;
  }) => {
    // A TYPED RANGE WINS. While one is set, no preset is lit — two date filters both lit is a lie
    // about what is on screen.
    const ranged = !!(from || to);
    return (
      <div className={`pf-row${disabled ? " off" : ""}`} data-testid={`finder-${name}-row`} data-disabled={disabled ? "true" : "false"}>
        <span className="pf-lbl">{label}</span>
        <div className="pf-seg" role="group" aria-label={label}>
          {opts.map(([v, t]) => (
            <button key={v} type="button" data-testid={`finder-${name}-${v}`}
              aria-pressed={preset === v && !ranged} disabled={disabled}
              className={preset === v && !ranged ? "on" : ""}
              onClick={() => onPreset(v)}>{t}</button>
          ))}
        </div>
        <span className="pf-dates">
          from <input type="date" data-testid={`finder-${name}from`} value={from} disabled={disabled}
            onChange={(e) => onFrom(e.target.value)} />
          to <input type="date" data-testid={`finder-${name}to`} value={to} disabled={disabled}
            onChange={(e) => onTo(e.target.value)} />
        </span>
        {disabled && why && <span className="pf-why" data-testid={`finder-${name}-why`}>{why}</span>}
      </div>
    );
  }

  const pages = Math.max(1, Math.ceil(total / size));

  return (
    <div className="panel pf" data-testid="finder-card">
      {/* THE COUNT STAYS IN THE HEADER WHILE COLLAPSED. A collapsed section that hides how many
          there are has hidden the only thing worth a glance. */}
      <div className="pf-head" data-testid="finder-head" onClick={() => setOpen((v) => !v)}
        role="button" tabIndex={0} aria-expanded={open}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen((v) => !v); } }}>
        <span className={`pf-chev${open ? " up" : ""}`} data-testid="finder-chev" aria-hidden>▾</span>
        <h3>PLAYER FINDER</h3>
        <span className="pf-hcount" data-testid="finder-count">
          {loading && !data ? "loading…" : `${N(total)} ${total === 1 ? "player" : "players"}`}
          <i className="pf-hsub">{dirty ? "matching your filters" : "registered"}</i>
        </span>
      </div>

      <div id="finder-body" data-testid="finder-body" hidden={!open}>
        <div className="pf-sync" data-testid="finder-freshness">
          Mirrored data · last synced {fmtWhen(data?.syncedAt ?? null)}. A signup newer than that is
          not here yet.
          <button type="button" className="pf-btn" onClick={() => void load()} data-testid="finder-refresh">Refresh</button>
        </div>

        <div className="pf-params">
          <div className="pf-row">
            <span className="pf-lbl">Search</span>
            <input type="search" className="pf-search" data-testid="finder-q" placeholder="Name, email, phone or ID"
              value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
          </div>

          {/* ── THE TWO WINDOW ROWS, FROM ONE RENDERER ────────────────────────────────────────
              Identical shape and identical rules is not a coincidence to be maintained by hand —
              they are the same control, so they are the same code. A divergence between them
              would otherwise be a copy-paste away, and the whole point of the rework is that
              PLAYED behaves exactly as SIGNED UP already did. */}
          {windowRow({
            label: "Signed up", name: "reg", opts: REG_OPTS,
            preset: applied?.reg ?? f.reg, from: f.regFrom, to: f.regTo,
            onPreset: (v) => setF({ ...f, reg: v, regFrom: "", regTo: "" }),
            onFrom: (v) => setF({ ...f, regFrom: v, reg: "all" }),
            onTo: (v) => setF({ ...f, regTo: v, reg: "all" }),
          })}

          <div className="pf-row">
            <span className="pf-lbl">History</span>
            <div className="pf-seg" role="group" aria-label="History">
              {HIST_OPTS.map(([v, t]) => (
                <button key={v} type="button" data-testid={`finder-hist-${v}`}
                  aria-pressed={f.hist === v} className={f.hist === v ? "on" : ""}
                  // NEVER PLAYED CLEARS THE PLAY WINDOW as it disables it, so re-enabling later
                  // cannot resurrect a filter the operator can no longer see.
                  onClick={() => setF(v === "never"
                    ? { ...f, hist: v, play: "all", playFrom: "", playTo: "" }
                    : { ...f, hist: v })}>{t}</button>
              ))}
            </div>
          </div>

          {/* NEVER PLAYED AND A PLAY WINDOW CANNOT BOTH BE TRUE. Dimmed and unclickable WITH THE
              REASON ON SCREEN — not hidden, and never left live to return a silent zero. The
              server ignores the window too; this is the courtesy, that is the rule. */}
          {windowRow({
            label: "Played", name: "play", opts: PLAY_OPTS,
            preset: applied?.play ?? f.play, from: f.playFrom, to: f.playTo,
            disabled: f.hist === "never",
            why: "No play dates to filter on — History is set to Never played",
            onPreset: (v) => setF({ ...f, play: v, playFrom: "", playTo: "" }),
            onFrom: (v) => setF({ ...f, playFrom: v, play: "all" }),
            onTo: (v) => setF({ ...f, playTo: v, play: "all" }),
          })}

          <div className="pf-row">
            <span className="pf-lbl">City</span>
            <select className="pf-sel" data-testid="finder-city" value={f.city}
              // A CONFINED ACCOUNT CANNOT WIDEN THIS, and the disabled select is not why — the
              // server refuses any city but theirs. This is courtesy.
              disabled={!!data?.confined}
              onChange={(e) => setF({ ...f, city: e.target.value })}>
              <option value="">All cities</option>
              {CITIES.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
            </select>
            <span className="pf-lbl pf-lbl2">Member</span>
            <div className="pf-seg" role="group" aria-label="Member">
              {MEM_OPTS.map(([v, t]) => (
                <button key={v} type="button" data-testid={`finder-member-${v}`}
                  aria-pressed={f.member === v} className={f.member === v ? "on" : ""}
                  onClick={() => setF({ ...f, member: v })}>{t}</button>
              ))}
            </div>
            {dirty && <button type="button" className="pf-clear" data-testid="finder-clear" onClick={clear}>Clear filters</button>}
          </div>
        </div>

        {err && <p className="empty" data-testid="finder-err"><b>Could not load players</b>{err}</p>}

        {!err && tiles.length > 0 && (
          <div className="pf-band" data-testid="finder-band" style={{ gridTemplateColumns: `repeat(${tiles.length},1fr)` }}>
            {tiles.map((t) => (
              <div className="pf-tile" key={t.k} data-testid="finder-tile" data-k={t.k}>
                <div className="pf-k">{t.k}</div>
                <div className="pf-v" data-testid={`finder-tile-${t.k.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}>{t.v}</div>
                <div className="pf-s">{t.s}</div>
              </div>
            ))}
          </div>
        )}

        {!err && (
          <>
            <div className="pf-tbar">
              <span className="pf-n" data-testid="finder-tablecount">{N(total)} {total === 1 ? "player" : "players"}</span>
              <button type="button" className="pf-btn pf-exp" data-testid="finder-export"
                disabled={!total || exporting} onClick={() => void doExport()}>
                {/* THE FULL COUNT ON ITS FACE — the point is outreach, and a button that says
                    "Export" next to a filtered list of 4,000 does not say what it will do. */}
                {exporting ? "Exporting…" : total ? `Export ${N(total)}` : "Export"}
              </button>
            </div>

            <div className="pf-scroll">
              <table className="pf-tbl" data-testid="finder-table">
                <thead>
                  <tr>
                    <th>ID</th><th>Name</th><th>Email</th><th>Phone</th>
                    <th>Preferred city</th><th>Registered</th><th>Last match</th><th>Member</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.players ?? []).map((p) => (
                    <tr key={p.id} data-testid="finder-row" data-pid={p.id}>
                      <td className="mono">
                        {onOpen ? <button type="button" className="pf-id" onClick={() => onOpen(p.id)}>{p.id}</button> : p.id}
                      </td>
                      <td>{p.name ?? "—"}</td>
                      <td>{p.email ?? "—"}</td>
                      <td className="mono">{p.phone ?? "—"}</td>
                      {/* NOT SET, never blank — a blank cell reads as a rendering bug, and 13.7%
                          of players have no preferred city. */}
                      <td data-testid="finder-city-cell">{p.city ?? "Not set"}</td>
                      <td data-iso={p.registered ?? ""}>{fmtDate(p.registered)}</td>
                      <td>{fmtDate(p.last_match)}</td>
                      <td>{p.member ? "yes" : "no"}</td>
                    </tr>
                  ))}
                  {data && data.players.length === 0 && !loading && (
                    <tr><td colSpan={8}><p className="empty" data-testid="finder-empty"><b>No players</b>Nothing matches these parameters.</p></td></tr>
                  )}
                </tbody>
              </table>
            </div>

            {pages > 1 && (
              <div className="pf-pager" data-testid="finder-pager">
                <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>‹ Prev</button>
                <span>Page {page} of {N(pages)}</span>
                <button type="button" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next ›</button>
              </div>
            )}
          </>
        )}
      </div>

      {/* GLOBAL, DELIBERATELY, and every selector is `.pf-`-prefixed so nothing else can be hit.
          styled-jsx's transform is LEXICAL: it only adds its scoped class to JSX it can statically
          see in the component's own render. `windowRow` is a helper that RETURNS a tree, and no
          arrangement of it — top-level function, function call, const declared inside the component
          — got the class added. Both window rows therefore rendered with className="" and none of
          these styles: no pill segments, no padding, and `pointer-events: none` on the disabled
          state silently doing nothing. Measured, not guessed: the History row beside them carried
          `jsx-9578503f9eb49537` and the PLAYED row carried nothing.
          Scoped styles that do not reach half the card are worse than a namespaced global block.
          styled-jsx still mounts and unmounts this with the component. */}
      <style jsx global>{`
        .pf-head { display: flex; align-items: center; gap: 12px; padding: 14px 18px;
          border-bottom: 1px solid #eef2ec; cursor: pointer; user-select: none; }
        .pf-head h3 { margin: 0; font-size: 12px; letter-spacing: .1em; text-transform: uppercase; color: #42513f; }
        .pf-chev { width: 22px; height: 22px; border-radius: 6px; border: 1px solid #e2e8de;
          display: grid; place-items: center; color: #42513f; font-size: 11px; background: #fff;
          flex: none; transition: transform .16s ease; }
        .pf-chev.up { transform: rotate(180deg); }
        .pf-hcount { margin-left: auto; font-size: 13px; color: #42513f; font-weight: 600; white-space: nowrap; }
        .pf-hsub { font-size: 12px; color: #7d8a7c; font-weight: 400; margin-left: 8px; font-style: normal; }
        .pf-sync { display: flex; align-items: center; gap: 10px; padding: 9px 18px;
          background: #f7faf6; border-bottom: 1px solid #eef2ec; font-size: 11.5px; color: #7d8a7c; }
        .pf-btn { border: 1px solid #e2e8de; background: #fff; border-radius: 8px; padding: 5px 11px;
          font: inherit; font-size: 12px; font-weight: 600; color: #42513f; cursor: pointer; }
        .pf-btn:disabled { opacity: .45; cursor: default; }
        .pf-params { padding: 14px 18px 4px; }
        .pf-row { display: flex; align-items: center; gap: 12px; margin-bottom: 11px; flex-wrap: wrap; }
        .pf-lbl { width: 74px; flex: none; font-size: 10.5px; letter-spacing: .09em;
          text-transform: uppercase; color: #7d8a7c; font-weight: 600; }
        .pf-lbl2 { width: auto; margin-left: 8px; }
        .pf-search { width: 340px; border: 1px solid #e2e8de; border-radius: 9px; padding: 7px 10px;
          font: inherit; font-size: 13px; color: #16241a; background: #fff; }
        .pf-seg { display: inline-flex; background: #f4f7f3; border: 1px solid #e2e8de;
          border-radius: 999px; padding: 3px; }
        .pf-seg button { border: 0; background: transparent; border-radius: 999px; padding: 6px 13px;
          font: inherit; font-size: 12.5px; color: #42513f; cursor: pointer; white-space: nowrap; }
        .pf-seg button.on { background: #d6ecdd; color: #0f3d24; font-weight: 600; }
        .pf-sel, .pf-dates input { border: 1px solid #e2e8de; border-radius: 9px; padding: 7px 10px;
          font: inherit; font-size: 13px; color: #16241a; background: #fff; }
        .pf-sel:disabled { background: #f4f7f3; color: #7d8a7c; }
        .pf-dates { display: flex; align-items: center; gap: 7px; font-size: 12px; color: #7d8a7c; }
        .pf-hint { font-size: 12px; color: #9aa598; }
        /* DIMMED AND UNCLICKABLE, with the reason beside it. pointer-events is what makes the row
           genuinely inert — opacity alone leaves a control that looks dead and still fires. */
        .pf-row.off { opacity: .45; pointer-events: none; }
        .pf-why { font-size: 12px; color: #7a5b18; font-weight: 600; }
        .pf-clear { margin-left: auto; border: 0; background: transparent; color: #1c7a4a;
          font-size: 12.5px; font-weight: 600; cursor: pointer; text-decoration: underline; }
        .pf-band { display: grid; border-top: 1px solid #eef2ec; border-bottom: 1px solid #eef2ec;
          background: #fbfdfa; margin-top: 8px; }
        .pf-tile { padding: 13px 18px; border-right: 1px solid #eef2ec; }
        .pf-tile:last-child { border-right: 0; }
        .pf-k { font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: #7d8a7c; font-weight: 600; }
        .pf-v { font-size: 21px; font-weight: 700; margin-top: 3px; letter-spacing: -.01em; line-height: 1.1; }
        .pf-s { font-size: 11.5px; color: #7d8a7c; margin-top: 2px; }
        .pf-tbar { display: flex; align-items: center; gap: 12px; padding: 12px 18px 9px; }
        .pf-n { font-size: 13px; font-weight: 600; color: #42513f; }
        .pf-exp { margin-left: auto; }
        .pf-scroll { overflow-x: auto; }
        table.pf-tbl { border-collapse: collapse; width: 100%; font-size: 13px; }
        table.pf-tbl th { font-size: 10px; letter-spacing: .07em; text-transform: uppercase; color: #7d8a7c;
          font-weight: 600; text-align: left; padding: 8px 14px; border-bottom: 1px solid #e2e8de;
          white-space: nowrap; background: #f7f8f5; }
        table.pf-tbl td { padding: 9px 14px; border-bottom: 1px solid #eef2ec; white-space: nowrap; color: #16241a; }
        table.pf-tbl td.mono { font-variant-numeric: tabular-nums; }
        .pf-id { all: unset; cursor: pointer; text-decoration: underline; color: #0f3d24; font-weight: 600; }
        table.pf-tbl tbody tr:hover td { background: #f8fbf7; }
        .pf-pager { display: flex; align-items: center; gap: 12px; padding: 10px 18px; font-size: 12px; color: #7d8a7c; }
        .pf-pager button { border: 1px solid #e2e8de; background: #fff; border-radius: 8px;
          padding: 4px 10px; font: inherit; font-size: 12px; color: #16241a; cursor: pointer; }
        .pf-pager button:disabled { opacity: .4; cursor: default; }
      `}</style>
    </div>
  );
}
