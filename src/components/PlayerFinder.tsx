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

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CITY_SCOPES } from "@/lib/cityScope";
import { supabase } from "@/lib/supabase";

type Player = {
  id: number; name: string | null; email: string | null; phone: string | null;
  city: string | null; registered: string | null; last_match: string | null;
  member: boolean; plays: number;
  // Set by the server when MatchDay has scrubbed the account (see shape() in the finder route).
  // The client never re-derives it from the name — the marker is the server's call, once.
  scrubbed?: boolean;
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
  /* THE AGE OF THE PRECOMPUTED SET, not of the mirror (migration 0147). `stale` means a sync
   * landed and the rebuild did not follow it — the one state a fast table can be in that a slow
   * view never could: confidently wrong. */
  freshness?: {
    refreshedAt: string | null; sourceSyncedAt: string | null; stale: boolean; rebuilt?: boolean;
    // BOTH mirror stamps, so the banner can name WHICH source is behind rather than say "stale".
    matchesSyncedAt?: string | null; usersSyncedAt?: string | null;
    // What Refresh did to the source mirror. null when this was an ordinary read.
    sourceSynced?: { ran: boolean; rows?: number; error?: string } | null;
  };
  /** How many players carry NO home city. Printed beside the control so "= Austin" cannot
   *  silently drop them. Counted over the whole estate, so it does not move with the filters. */
  noHomeCity?: number;
  /** Every field that has hosted a match, with its city, for the Played-at Field select. */
  fields?: { fieldId: number; title: string; city: string | null }[];
};

type Filters = {
  q: string; reg: string; regFrom: string; regTo: string;
  hist: string; play: string; playFrom: string; playTo: string;
  /* HOME city — the city on the player's ACCOUNT. "unset" selects the 4,010 who have none, who a
   * plain equality test has always dropped without saying so. */
  city: string; member: string;
  // ── PLAYED AT — the matches they were actually at. A different question from every filter
  // above, which describe the player rather than the play.
  matchCity: string; fieldId: string; kickFrom: string; kickTo: string;
  matchFrom: string; matchTo: string;
};

const DEFAULTS: Filters = {
  q: "", reg: "all", regFrom: "", regTo: "",
  hist: "any", play: "all", playFrom: "", playTo: "", city: "", member: "any",
  matchCity: "", fieldId: "", kickFrom: "", kickTo: "", matchFrom: "", matchTo: "",
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
/* DERIVED, NOT COPIED. This was a hand-written duplicate of CITY_SCOPES — a second place the
 * identifier↔name pair lived, and the kind of copy that goes stale the day a market opens. It
 * happened to be right about Warsaw only because someone remembered to edit both. */
const CITIES: [string, string][] = CITY_SCOPES.map((c) => [c.identifier, c.name]);

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
  /* A FIELD BELONGS TO ONE CITY. With a city chosen the select offers only its fields; with none
   * it offers all of them, labelled by city so two pitches with similar names stay apart. */
  const fieldsForCity = (cityId: string) => {
    const all = data?.fields ?? [];
    if (!cityId) return all.map((x) => ({ ...x, title: x.city ? `${x.title} · ${x.city}` : x.title }));
    const name = CITIES.find(([v]) => v === cityId)?.[1] ?? null;
    return all.filter((x) => x.city === name);
  };
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
    // "unset" is not a city — it is the absence of one, and the server reads it from its own key.
    if (f.city === "unset") p.set("homeCity", "unset");
    else if (f.city) p.set("city", f.city);
    if (f.member !== "any") p.set("member", f.member);
    if (f.matchCity) p.set("matchCity", f.matchCity);
    if (f.fieldId) p.set("fieldId", f.fieldId);
    if (f.kickFrom) p.set("kickFrom", f.kickFrom);
    if (f.kickTo) p.set("kickTo", f.kickTo);
    if (f.matchFrom) p.set("matchFrom", f.matchFrom);
    if (f.matchTo) p.set("matchTo", f.matchTo);
    for (const [k, v] of Object.entries(extra)) p.set(k, v);
    return p.toString();
  }, [f]);

  /* `opts.rebuild` asks the SERVER to rebuild the precomputed set before reading it, and is sent
   * only by the Refresh button. It is not part of `query`'s filter state — a rebuild is an action,
   * not a filter, and it must not be replayed by the effect below every time a filter changes. */
  const load = useCallback(async (opts?: { rebuild?: string }) => {
    const mine = ++seq.current;
    setLoading(true); setErr(null);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      const res = await fetch(`/api/players/finder?${query({ page: String(page), size: String(size), ...(opts?.rebuild ? { rebuild: opts.rebuild } : {}) })}`, {
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

  /* ── THE CHIP BAR ─────────────────────────────────────────────────────────────────────────────
   * Seven stacked rows of controls became one search field and six chips. NOTHING ABOUT WHAT A
   * FILTER DOES CHANGED: same option sets, same state shape, same query params, same server. This
   * is where the controls live, not what they mean.
   *
   * A CHIP IS QUIET UNTIL IT IS DOING SOMETHING. At rest it shows the filter's name in grey. Only
   * a filter moved off its DEFAULT is lit, carries its value and grows an × to clear it — so the
   * bar reads as "nothing is filtered" at a glance, and the narrowing you applied is the only
   * thing on it with colour. `set` below is that test and nothing else; a chip that merely exists
   * never counts.
   */
  const [openChip, setOpenChip] = useState<string | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);

  // Click away or press Escape to close. Clicks INSIDE the bar are ignored here so that using a
  // control in the popover does not close the popover under your finger.
  useEffect(() => {
    if (!openChip) return;
    const onDown = (e: MouseEvent) => { if (!barRef.current?.contains(e.target as Node)) setOpenChip(null); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpenChip(null); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [openChip]);

  /* NO POPOVER MAY SPILL OUTSIDE THE CARD. Anchored under its own chip, every chip in the
   * right-hand half of a narrow card would push one off the edge — and which chips those are
   * depends on where the row wrapped, which only layout knows. So it is MEASURED once on open and
   * shifted left by exactly the overhang, never past the card's left edge. Set on the node rather
   * than through state: it is a layout correction, and a state round-trip would paint the
   * uncorrected position first.
   *
   * ON A PHONE THERE IS NOTHING TO CORRECT — the popover is a bottom sheet (see .pf-pop in the
   * styles), full width and fixed to the bottom of the viewport, so it is skipped. */
  useLayoutEffect(() => {
    const pop = popRef.current;
    if (!pop) return;
    pop.style.marginLeft = "0px";
    if (window.matchMedia("(max-width: 640px)").matches) return;
    const card = pop.closest(".pf") as HTMLElement | null;
    if (!card) return;
    const p = pop.getBoundingClientRect(), c = card.getBoundingClientRect();
    const over = p.right - (c.right - 12);
    if (over > 0) pop.style.marginLeft = `${-Math.min(over, Math.max(0, p.left - (c.left + 12)))}px`;
  }, [openChip]);

  const lab = (opts: [string, string][], v: string) => opts.find(([o]) => o === v)?.[1] ?? v;
  const cityName = (v: string) => (v === "unset" ? "Not set" : CITIES.find(([c]) => c === v)?.[1] ?? v);
  const rangeLab = (a: string, b: string) => (a || b ? `${a || "start"} → ${b || "today"}` : null);

  // PLAYED AT IS SIX CONTROLS BEHIND ONE CHIP, so its value has to summarise them. The most
  // specific thing set wins, because that is what the operator will recognise.
  const atSet = !!(f.matchCity || f.fieldId || f.kickFrom || f.kickTo || f.matchFrom || f.matchTo);
  const atLabel = f.fieldId
    ? ((data?.fields ?? []).find((x) => String(x.fieldId) === f.fieldId)?.title ?? "a field")
    : f.matchCity ? cityName(f.matchCity)
    : rangeLab(f.matchFrom, f.matchTo)
      ?? (f.kickFrom || f.kickTo ? `${f.kickFrom || "any"}–${f.kickTo || "any"}` : "");

  // NEVER PLAYED AND A PLAY WINDOW CANNOT BOTH BE TRUE — the existing rule, unchanged.
  const playOff = f.hist === "never";
  // A CONFINED ACCOUNT CANNOT WIDEN A CITY. The server refuses any city but theirs; dimming is the
  // courtesy, and it must reach the chip too — a chip that opens onto a dead select is a control
  // that looks live and does nothing.
  const cityLocked = !!data?.confined;

  type Chip = { id: string; name: string; value: string; set: boolean; off: boolean; why?: string; onClear: () => void };
  const chips: Chip[] = [
    { id: "reg", name: "Signed up", set: f.reg !== "all" || !!f.regFrom || !!f.regTo, off: false,
      value: rangeLab(f.regFrom, f.regTo) ?? lab(REG_OPTS, applied?.reg ?? f.reg),
      onClear: () => setF({ ...f, reg: "all", regFrom: "", regTo: "" }) },
    { id: "hist", name: "History", set: f.hist !== "any", off: false,
      value: lab(HIST_OPTS, f.hist), onClear: () => setF({ ...f, hist: "any" }) },
    { id: "play", name: "Played", set: f.play !== "all" || !!f.playFrom || !!f.playTo, off: playOff,
      why: "No play dates to filter on — History is set to Never played",
      value: rangeLab(f.playFrom, f.playTo) ?? lab(PLAY_OPTS, applied?.play ?? f.play),
      onClear: () => setF({ ...f, play: "all", playFrom: "", playTo: "" }) },
    { id: "city", name: "Home city", set: !!f.city, off: cityLocked,
      why: "Your account is confined to one city — the server refuses any other",
      value: cityName(f.city), onClear: () => setF({ ...f, city: "" }) },
    { id: "mem", name: "Member", set: f.member !== "any", off: false,
      value: lab(MEM_OPTS, f.member), onClear: () => setF({ ...f, member: "any" }) },
    { id: "at", name: "Played at", set: atSet, off: false, value: atLabel,
      onClear: () => setF({ ...f, matchCity: "", fieldId: "", kickFrom: "", kickTo: "", matchFrom: "", matchTo: "" }) },
  ];
  const chipsOn = chips.filter((c) => c.set).length;

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
    /* A TILE FORCED BY THE SCOPE IS AS DEAD AS ONE FORCED BY A FILTER, and until now only the
     * second was noticed. `f.city` is what the operator TYPED; a confined account types nothing —
     * the server imposes its city from the account row — so `!!f.city` was false for exactly the
     * people who can only ever see one city. The result was backwards: the Warsaw operator got
     * "Top city: Warsaw" and "Cities: 1", the filter read back at him, while the admin who typed
     * Warsaw correctly got Median signup age and Newest signup in those slots.
     *
     * Read the EFFECTIVE scope — typed OR imposed — from the payload the server already sends. */
    const cityFixed = !!f.city || !!data?.scope;
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
      { k: "Top city", v: st.topCity?.name ?? "—", s: st.topCity ? `${N(st.topCity.n)} players` : "—", dead: cityFixed },
      { k: "Played 2+", v: N(st.heavy), s: pc(st.heavy), dead: f.hist !== "any" },
      { k: "New in 30 days", v: N(st.month30), s: pc(st.month30), dead: f.reg === "7" || f.reg === "30" || range },
      { k: "Cities", v: N(st.cities), s: "represented here", dead: cityFixed },
      { k: "Has a name", v: N(st.named), s: pc(st.named), dead: false },
      { k: "Median signup age", v: st.medianAgeDays == null ? "—" : `${st.medianAgeDays}d`, s: "half are older than this", dead: false },
      { k: "Newest signup", v: fmtDate(st.newest), s: "most recent", dead: false },
    ];
    const hot = f.member !== "any" || f.hist !== "any" || f.play !== "all" || !!(f.playFrom || f.playTo);
    const full = hot ? [POOL[0], ...OCC, ...POOL.slice(1)] : [...POOL, ...OCC];
    // BACKSTOP for implications the predicates do not know about: "97 of 97" is never news whatever
    // produced it. A zero can still be news, so zeros stay.
    return full.filter((t, i) => !t.dead && !(i > 0 && total > 0 && t.v === N(total))).slice(0, 6);
  }, [st, total, f, dirty, range, data?.scope]);

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
      /* email and phone ARRIVE null for a scrubbed account — the server drops them in shape(), so
       * the export cannot leak what the table hides. A blank cell alone would read as "no email on
       * file", which is a different fact, so `deleted` is carried explicitly and the sheet can
       * filter on it. APPENDED LAST, deliberately: anything reading these columns by position
       * keeps working. */
      const csv = [
        ["id", "name", "email", "phone", "home_city", "registered", "last_match", "member", "deleted"].join(","),
        ...rows.map((r) => [r.id, r.name ?? "", r.email ?? "", r.phone ?? "", r.city ?? "", r.registered ?? "", r.last_match ?? "", r.member ? "yes" : "no", r.scrubbed ? "yes" : "no"]
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
  const windowPop = ({ label, name, opts, preset, from, to, onPreset, onFrom, onTo }: {
    label: string; name: string; opts: [string, string][];
    preset: string; from: string; to: string;
    onPreset: (v: string) => void; onFrom: (v: string) => void; onTo: (v: string) => void;
  }) => {
    // A TYPED RANGE WINS. While one is set, no preset is lit — two date filters both lit is a lie
    // about what is on screen.
    const ranged = !!(from || to);
    return (
      <>
        <h4 className="pf-poph">{label}</h4>
        <div className="pf-opts" role="group" aria-label={label}>
          {opts.map(([v, t]) => (
            <button key={v} type="button" data-testid={`finder-${name}-${v}`}
              aria-pressed={preset === v && !ranged}
              className={preset === v && !ranged ? "on" : ""}
              onClick={() => onPreset(v)}>
              {t}{preset === v && !ranged ? <span className="pf-tick" aria-hidden>✓</span> : null}
            </button>
          ))}
        </div>
        <div className="pf-subhd">Or an exact range</div>
        <div className="pf-two">
          <input type="date" data-testid={`finder-${name}from`} aria-label={`${label} from`} value={from}
            onChange={(e) => onFrom(e.target.value)} />
          <span>to</span>
          <input type="date" data-testid={`finder-${name}to`} aria-label={`${label} to`} value={to}
            onChange={(e) => onTo(e.target.value)} />
        </div>
      </>
    );
  }

  // The contents of each chip's popover. Keyed by chip id so the bar renders exactly one.
  const POPS: Record<string, () => React.ReactNode> = {
    reg: () => windowPop({
      label: "Signed up", name: "reg", opts: REG_OPTS,
      preset: applied?.reg ?? f.reg, from: f.regFrom, to: f.regTo,
      onPreset: (v) => setF({ ...f, reg: v, regFrom: "", regTo: "" }),
      onFrom: (v) => setF({ ...f, regFrom: v, reg: "all" }),
      onTo: (v) => setF({ ...f, regTo: v, reg: "all" }),
    }),
    play: () => windowPop({
      label: "Played", name: "play", opts: PLAY_OPTS,
      preset: applied?.play ?? f.play, from: f.playFrom, to: f.playTo,
      onPreset: (v) => setF({ ...f, play: v, playFrom: "", playTo: "" }),
      onFrom: (v) => setF({ ...f, playFrom: v, play: "all" }),
      onTo: (v) => setF({ ...f, playTo: v, play: "all" }),
    }),
    hist: () => (
      <>
        <h4 className="pf-poph">History</h4>
        <div className="pf-opts" role="group" aria-label="History">
          {HIST_OPTS.map(([v, t]) => (
            <button key={v} type="button" data-testid={`finder-hist-${v}`}
              aria-pressed={f.hist === v} className={f.hist === v ? "on" : ""}
              // NEVER PLAYED CLEARS THE PLAY WINDOW as it disables it, so re-enabling later
              // cannot resurrect a filter the operator can no longer see.
              onClick={() => setF(v === "never"
                ? { ...f, hist: v, play: "all", playFrom: "", playTo: "" }
                : { ...f, hist: v })}>
              {t}{f.hist === v ? <span className="pf-tick" aria-hidden>✓</span> : null}
            </button>
          ))}
        </div>
        <p className="pf-pophint">A count of matches played, not a date window.</p>
      </>
    ),
    city: () => (
      <>
        {/* HOME CITY, NOT CITY. This reads preferable_city_name — the city on the player's ACCOUNT
            — and it is a signup attribute, not where they played. The Played-at chip is the other
            question, and two controls called "City" is how someone answers the wrong one. */}
        <h4 className="pf-poph">Home city</h4>
        <select className="pf-sel pf-popsel" data-testid="finder-city" value={f.city}
          disabled={cityLocked}
          onChange={(e) => setF({ ...f, city: e.target.value })}>
          <option value="">All cities</option>
          {CITIES.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
          {/* SELECTABLE, NOT JUST COUNTED. Picking a city excludes everyone with none; this is
              the only way to reach them, and without it they are invisible rather than filtered. */}
          <option value="unset">Not set{data?.noHomeCity ? ` (${N(data.noHomeCity)})` : ""}</option>
        </select>
        {!!data?.noHomeCity && (
          <p className="pf-pophint" data-testid="finder-nohome">
            {N(data.noHomeCity)} players have no home city — picking one excludes them.
          </p>
        )}
      </>
    ),
    mem: () => (
      <>
        <h4 className="pf-poph">Member</h4>
        <div className="pf-opts" role="group" aria-label="Member">
          {MEM_OPTS.map(([v, t]) => (
            <button key={v} type="button" data-testid={`finder-member-${v}`}
              aria-pressed={f.member === v} className={f.member === v ? "on" : ""}
              onClick={() => setF({ ...f, member: v })}>
              {t}{f.member === v ? <span className="pf-tick" aria-hidden>✓</span> : null}
            </button>
          ))}
        </div>
      </>
    ),
    /* ── PLAYED AT — THE MATCHES, NOT THE PLAYER ──────────────────────────────────────────────
       Every chip before this one describes who someone IS: when they signed up, what their account
       says, whether they hold a membership. These describe WHERE AND WHEN THEY ACTUALLY PLAYED.
       Four controls that only make sense together, which is exactly what one chip is for.

       THE FIELD SELECT NARROWS TO THE CHOSEN CITY, because a field belongs to one city and
       offering all 79 against a picked city is offering wrong answers. */
    at: () => (
      <>
        <h4 className="pf-poph">Played at</h4>
        <select className="pf-sel pf-popsel" data-testid="finder-match-city" value={f.matchCity}
          aria-label="Played-at city" disabled={cityLocked}
          onChange={(e) => {
            const city = e.target.value;
            const stillValid = fieldsForCity(city).some((x) => String(x.fieldId) === f.fieldId);
            setF({ ...f, matchCity: city, fieldId: stillValid ? f.fieldId : "" });
          }}>
          <option value="">Any city</option>
          {CITIES.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
        </select>
        <select className="pf-sel pf-popsel" data-testid="finder-field" value={f.fieldId}
          aria-label="Played-at field"
          onChange={(e) => setF({ ...f, fieldId: e.target.value })}>
          <option value="">Any field</option>
          {fieldsForCity(f.matchCity).map((x) => (
            <option key={x.fieldId} value={x.fieldId}>{x.title}</option>
          ))}
        </select>
        <div className="pf-subhd">Kick-off between</div>
        <div className="pf-two">
          <input type="time" data-testid="finder-kickfrom" aria-label="Kick-off from"
            value={f.kickFrom} onChange={(e) => setF({ ...f, kickFrom: e.target.value })} />
          <span>to</span>
          <input type="time" data-testid="finder-kickto" aria-label="Kick-off to"
            value={f.kickTo} onChange={(e) => setF({ ...f, kickTo: e.target.value })} />
        </div>
        <div className="pf-subhd">On dates</div>
        <div className="pf-two">
          <input type="date" data-testid="finder-matchfrom" aria-label="Match date from"
            value={f.matchFrom} onChange={(e) => setF({ ...f, matchFrom: e.target.value })} />
          <span>to</span>
          <input type="date" data-testid="finder-matchto" aria-label="Match date to"
            value={f.matchTo} onChange={(e) => setF({ ...f, matchTo: e.target.value })} />
        </div>
        <p className="pf-pophint">The matches they were actually at — a different question from Home city.</p>
      </>
    ),
  };

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
        {/* THE SET'S AGE, NOT THE MIRROR'S. Since 0147 these figures come from a precomputed set
            built FROM the mirror, so the set's age is what governs the screen. When a sync has
            landed and the rebuild has not followed it, that is said outright — a fast table that
            has gone stale is confidently wrong, which a slow view never was. */}
        <div className={`pf-sync${data?.freshness?.stale ? " pf-sync-stale" : ""}`} data-testid="finder-freshness"
          data-stale={data?.freshness?.stale ? "1" : "0"}>
          {data?.freshness?.stale ? (
            <>
              <b>These counts are out of date.</b> The source synced{" "}
              {fmtWhen(data.freshness.sourceSyncedAt)} but this set was last rebuilt{" "}
              {fmtWhen(data.freshness.refreshedAt)} — anything since is missing. It rebuilds on the
              next sync.
            </>
          ) : (
            <>Mirrored data · set rebuilt {fmtWhen(data?.freshness?.refreshedAt ?? data?.syncedAt ?? null)}. A signup newer than that is not here yet.</>
          )}
          {/* WHAT REFRESH ACTUALLY DID, said plainly. The failure case is the one that matters: a
              source sync that errored leaves the page NOT current, and the old button reported
              success regardless. `ran: false` is the rate limit, not a failure — it means the
              mirror was synced within the last minute and there was nothing to fetch. */}
          {data?.freshness?.sourceSynced?.error ? (
            <b className="pf-sync-bad"> · Could not sync the source — this page is NOT current.</b>
          ) : data?.freshness?.sourceSynced?.ran ? (
            <span className="pf-sync-ok">
              {" "}· Synced the source ({data.freshness.sourceSynced.rows?.toLocaleString()} rows)
              {data.freshness.rebuilt ? " and rebuilt the set." : "; the set was already current."}
            </span>
          ) : data?.freshness?.sourceSynced ? (
            <span className="pf-sync-ok"> · Source was synced under a minute ago; nothing to fetch.</span>
          ) : null}
          {/* REFRESH SYNCS THE SOURCE, THEN REBUILDS. Rebuilding alone re-derived the set from a
              mirror that was itself behind, so pressing this after a new signup showed nothing and
              still reported success. Measured: the incremental source sync is 0.6s and the rebuild
              3.1s, so the whole thing sits behind a click comfortably. The FULL re-sync — the one
              that catches deletions — is 113s and stays on the daily cron. */}
          <button type="button" className="pf-btn" disabled={loading}
            onClick={() => void load({ rebuild: "1" })} data-testid="finder-refresh">
            {loading ? "Syncing…" : "Refresh"}
          </button>
        </div>

        <div className="pf-params" data-testid="finder-params" ref={barRef}>
          {/* SEARCH STAYS A REAL FIELD. It is the thing you came to do, not a filter, so it does
              not go behind a chip. */}
          <div className="pf-searchrow">
            <input type="search" className="pf-search" data-testid="finder-q" placeholder="Name, email, phone or ID"
              value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
          </div>

          <div className="pf-chips" data-testid="finder-chips">
            {chips.map((c) => {
              const opened = openChip === c.id;
              return (
                <div className="pf-chipwrap" key={c.id}>
                  <button type="button" data-testid={`finder-chip-${c.id}`} data-chip={c.id}
                    data-set={c.set ? "true" : "false"} data-disabled={c.off ? "true" : "false"}
                    aria-expanded={opened} aria-disabled={c.off}
                    className={`pf-chip${c.set ? " on" : ""}${c.off ? " off" : ""}`}
                    onClick={() => { if (!c.off) setOpenChip(opened ? null : c.id); }}>
                    <span className="pf-chipn">{c.name}</span>
                    {c.set && c.value ? <span className="pf-chipv" data-testid={`finder-chipv-${c.id}`}>{c.value}</span> : null}
                    <span className="pf-caret" aria-hidden>▾</span>
                    {c.set && (
                      // The × clears this filter without opening the popover. stopPropagation, or
                      // clearing would also toggle the popover open under the pointer.
                      <span role="button" tabIndex={0} className="pf-x" data-testid={`finder-chipx-${c.id}`}
                        aria-label={`Clear ${c.name}`}
                        onClick={(e) => { e.stopPropagation(); c.onClear(); setOpenChip(null); }}
                        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); c.onClear(); setOpenChip(null); } }}>×</span>
                    )}
                  </button>
                  {opened && !c.off && (
                    <>
                      {/* The scrim only exists on a phone, where the popover is a bottom sheet
                          (see .pf-scrim in the styles). On desktop it is display:none. */}
                      <span className="pf-scrim" aria-hidden onClick={() => setOpenChip(null)} />
                      <div className={`pf-pop${c.id === "at" ? " wide" : ""}`} ref={popRef}
                        data-testid="finder-pop" data-pop={c.id} role="dialog" aria-label={c.name}>
                        {POPS[c.id]()}
                      </div>
                    </>
                  )}
                </div>
              );
            })}

            {chipsOn > 0 || dirty ? (
              <>
                {dirty && <button type="button" className="pf-clear" data-testid="finder-clear" onClick={clear}>Clear all</button>}
                <span className="pf-fcount" data-testid="finder-filtercount">
                  {chipsOn > 0
                    ? `${chipsOn} filter${chipsOn === 1 ? "" : "s"} on`
                    : "No filters beyond the search"}
                </span>
              </>
            ) : (
              <span className="pf-fcount" data-testid="finder-filtercount">
                No filters — all {N(total)} players
              </span>
            )}
          </div>

          {/* THE REASON IS TEXT IN THE BAR, NOT A TOOLTIP. The Played chip is dimmed and opens
              nothing, and a disabled control is the one thing nobody hovers — so a `title` would
              be a reason that is never read. It stays where the old row put it: on screen. */}
          {playOff && (
            <div className="pf-why" data-testid="finder-play-why">
              Played is off — no play dates to filter on when History is <b>Never played</b>.
            </div>
          )}

          {/* NEVER PLAYED AND A MATCH FILTER CANNOT BOTH BE TRUE, and unlike the play window the
              two do NOT contradict into an ignored filter — a player who never played genuinely
              matches no match, so the honest result is empty. Said here rather than discovered. */}
          {f.hist === "never" && (f.matchCity || f.fieldId || f.kickFrom || f.kickTo || f.matchFrom || f.matchTo) && (
            <div className="pf-why" data-testid="finder-playedat-empty">
              History is <b>Never played</b> and a Played-at filter is set — nobody can match both,
              so this will return nothing. That is the real answer, not a bug.
            </div>
          )}
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
                    <th>Home city</th><th>Registered</th><th>Last match</th><th>Member</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.players ?? []).map((p) => (
                    <tr key={p.id} data-testid="finder-row" data-pid={p.id}>
                      <td className="mono">
                        {onOpen ? <button type="button" className="pf-id" onClick={() => onOpen(p.id)}>{p.id}</button> : p.id}
                      </td>
                      {/* A DELETED ACCOUNT SAYS SO, and says it once. The name already arrives as
                          "Deleted Account" from MatchDay's own scrub; the marker makes it read as a
                          state rather than as somebody unfortunately named. */}
                      <td>{p.scrubbed ? <span className="pf-scrubbed">Deleted account</span> : (p.name ?? "—")}</td>
                      {/* NOT "—". An em-dash here means "we have no email"; these rows HAVE one and
                          it is a tombstone that bounces. Naming it stops anyone trying. */}
                      <td>{p.scrubbed ? <span className="pf-scrubbed">deleted</span> : (p.email ?? "—")}</td>
                      <td className="mono">{p.scrubbed ? <span className="pf-scrubbed">deleted</span> : (p.phone ?? "—")}</td>
                      {/* NOT SET, never blank — a blank cell reads as a rendering bug, and 13.7%
                          of players have no home city. */}
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
        .pf-params { padding: 12px 18px 12px; display: flex; flex-direction: column; gap: 9px; }
        .pf-searchrow { display: flex; align-items: center; gap: 9px; }

        /* ── THE CHIP BAR ────────────────────────────────────────────────────────────────────
           A chip is QUIET until it is doing something: grey border, grey name, no value. The .on
           class is "moved off its default" and nothing else — the only colour in the bar, which is
           what makes "nothing is filtered" readable at a glance. */
        .pf-chips { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
        .pf-chipwrap { position: relative; display: inline-flex; }
        .pf-chip { display: inline-flex; align-items: center; gap: 6px; height: 30px;
          border: 1px solid #e2e8de; background: #fff; border-radius: 999px; padding: 0 11px;
          font: inherit; font-size: 12.5px; font-weight: 600; color: #42513f; cursor: pointer;
          white-space: nowrap; }
        .pf-chip:hover { border-color: #c3d2c8; }
        .pf-chip.on { background: #d6ecdd; border-color: #b9dcc6; color: #0f3d24; }
        .pf-chipv { color: #16241a; font-weight: 700; max-width: 190px; overflow: hidden;
          text-overflow: ellipsis; }
        .pf-chip.on .pf-chipv { color: #0f3d24; }
        .pf-caret { color: #9aa8a0; font-size: 9px; }
        .pf-chip.on .pf-caret { color: #6ba585; }
        .pf-x { width: 15px; height: 15px; border-radius: 999px; display: inline-flex;
          align-items: center; justify-content: center; font-size: 11px; line-height: 1;
          background: rgba(15,61,36,.12); color: #0f3d24; }
        .pf-x:hover { background: rgba(15,61,36,.22); }
        /* DIMMED AND UNCLICKABLE, with the reason in the bar rather than a title. pointer-events
           is what makes it genuinely inert — opacity alone leaves a control that looks dead and
           still fires. */
        .pf-chip.off { opacity: .45; pointer-events: none; }
        .pf-fcount { font-size: 11.5px; color: #7d8a7c; margin-left: 2px; }

        /* ── THE POPOVER ─────────────────────────────────────────────────────────────────────
           Anchored under its chip on a desktop. Its left offset is corrected in a layout effect
           so it can never spill past the card's right edge. */
        .pf-pop { position: absolute; top: 36px; left: 0; z-index: 30; background: #fff;
          border: 1px solid #e2e8de; border-radius: 12px; box-shadow: 0 10px 28px rgba(16,40,28,.14);
          padding: 11px; min-width: 262px; max-width: min(430px, calc(100vw - 32px));
          white-space: normal; }
        .pf-pop.wide { min-width: 300px; width: 400px; max-width: calc(100vw - 32px); }
        .pf-poph { margin: 0 0 8px; font-size: 10px; letter-spacing: .09em; text-transform: uppercase;
          color: #7d8a7c; font-weight: 700; }
        .pf-opts { display: flex; flex-direction: column; gap: 2px; }
        .pf-opts button { display: flex; align-items: center; gap: 8px; border: 0; background: none;
          border-radius: 8px; padding: 7px 9px; font: inherit; font-size: 12.5px; font-weight: 600;
          color: #42513f; cursor: pointer; text-align: left; width: 100%; }
        .pf-opts button:hover { background: #f4f7f3; }
        .pf-opts button.on { background: #d6ecdd; color: #0f3d24; font-weight: 700; }
        .pf-tick { margin-left: auto; font-size: 11px; }
        .pf-subhd { margin: 10px 0 6px; font-size: 10px; letter-spacing: .09em; text-transform: uppercase;
          color: #7d8a7c; font-weight: 700; border-top: 1px solid #eef2ec; padding-top: 9px; }
        .pf-two { display: flex; align-items: center; gap: 7px; }
        .pf-two input { flex: 1; min-width: 0; border: 1px solid #e2e8de; border-radius: 9px;
          padding: 6px 9px; font: inherit; font-size: 12.5px; color: #16241a; background: #fff; }
        .pf-two span { font-size: 11.5px; color: #9aa598; }
        .pf-popsel { width: 100%; margin-bottom: 7px; }
        .pf-pophint { margin: 9px 0 0; font-size: 11.5px; color: #7d8a7c; line-height: 1.45; }
        .pf-scrim { display: none; }

        /* ── ON A PHONE THE POPOVER IS A BOTTOM SHEET ────────────────────────────────────────
           A popover anchored under a chip is the wrong shape on a 390px screen: the chips wrap to
           three rows, so "under the chip" is the middle of the screen, and a 262px card next to a
           chip sitting at x=280 has nowhere to go. A sheet needs no anchoring at all, cannot run
           off an edge at any width, gives the option list a real tap target, and opens where the
           thumb already is. Same markup, same test ids — only the container moves. */
        @media (max-width: 640px) {
          .pf-pop { position: fixed; top: auto; left: 0; right: 0; bottom: 0; width: auto;
            min-width: 0; max-width: none; margin-left: 0 !important; border-radius: 14px 14px 0 0;
            padding: 14px 16px calc(16px + env(safe-area-inset-bottom));
            max-height: 72vh; overflow-y: auto; box-shadow: 0 -8px 28px rgba(16,40,28,.18); }
          .pf-pop.wide { width: auto; }
          .pf-scrim { display: block; position: fixed; inset: 0; z-index: 29;
            background: rgba(7,42,32,.28); }
          .pf-opts button { padding: 11px 10px; font-size: 13.5px; }
          .pf-search { width: 100%; }
        }

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
        /* ── PLAYED AT (0147) ──────────────────────────────────────────────────────────────
           Set apart by a rule and a tint rather than a heading: it is a DIFFERENT QUESTION from
           the rows above — the matches someone was at, not who they are — and the eye should see
           the seam without another label competing with "Home city" beside it. */
        .pf-playedat { border-top: 1px dashed #e2e8de; padding-top: 12px; margin-top: 2px; }
        .pf-playedat2 { margin-top: -4px; }
        .pf-date { border: 1px solid #e2e8de; border-radius: 9px; padding: 6px 9px;
          font: inherit; font-size: 12.5px; color: #16241a; background: #fff; }
        .pf-to { font-size: 12px; color: #9aa598; }
        .pf-sel-wide { max-width: 260px; }
        /* STALE IS NOT DECORATION. The set is fast and can be confidently wrong; when it is behind
           the mirror the strip stops being a grey footnote and says so. */
        .pf-sync-ok { color: #4a7c59; }
        .pf-sync-bad { color: #8a3b16; }
        .pf-sync-stale { background: #fff4ed; color: #8a3b16; border-bottom-color: #f2d3c0; }
        .pf-sync-stale b { color: #8a3b16; }
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
        /* Quiet, not alarming. A deleted account is a normal end state, not an error — it just
           must not read as a contact. Italic and faded is enough to stop a copy-paste. */
        .pf-scrubbed { font-style: italic; color: #8a8f8b; }
        table.pf-tbl tbody tr:hover td { background: #f8fbf7; }
        .pf-pager { display: flex; align-items: center; gap: 12px; padding: 10px 18px; font-size: 12px; color: #7d8a7c; }
        .pf-pager button { border: 1px solid #e2e8de; background: #fff; border-radius: 8px;
          padding: 4px 10px; font: inherit; font-size: 12px; color: #16241a; cursor: pointer; }
        .pf-pager button:disabled { opacity: .4; cursor: default; }
      `}</style>
    </div>
  );
}
