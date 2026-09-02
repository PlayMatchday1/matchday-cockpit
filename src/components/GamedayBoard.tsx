"use client";

// Gameday Ops (Phase 15) — a triage board, not a schedule. It answers "what is about
// to go wrong" for one day, read LIVE from the API, sorted by the REAL kickoff instant
// (startDateUtc), banded, with the fake-spot ladder as a countdown and auto-cancel
// driving each tile's colour. Built from today-v1_6.html; where the mockup and the API
// conflicted the API won (see docs/matchday-api-facts.md "Gameday Ops"):
//   • order by startDateUtc, no per-city offset maths (the API carries the instant);
//   • current fakes are OBSERVED (_count.fakePlayers), the ladder only forecasts;
//   • cancelled = isCancelled (not autoCanceled, a policy flag).
// All board maths live in the shared, tested gamedayModel. The tile is ONE <button>;
// the roster link and Veo control are SPANS with role + keyboard handling, because a
// <button> cannot nest inside a <button> (it silently ends the outer one).

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { envBadge } from "@/lib/matchEnvBadge";
import { DRAWER_ENV } from "@/lib/matchEnv";
import { centsToDollars } from "@/lib/matchMoney";
import MatchPanel from "@/components/MatchPanel";
import { useCrmConversationOptional } from "@/lib/crmConversation";
import LogHealthBanner from "@/components/LogHealthBanner";
import MatchOpsSectionSheet from "@/app/(internal)/match-ops/MatchOpsSectionSheet";
import MatchOpsMobileBar from "@/app/(internal)/match-ops/MatchOpsMobileBar";
import type { RailItem } from "@/app/(internal)/match-ops/sections";
import RefreshIcon from "@/components/RefreshIcon";
import ChatPane from "@/app/(internal)/match-ops/match-chats/ChatPane";
import { useAuth, canEditMatches } from "@/lib/useAuth";
import {
  type ApiMatch, type BoardFilter, type MatchGroup, GROUPS, byKickoff, matchGroup, minsUntil, fmtDur, localClock, deadlineClock, tzAbbr,
  realCount, fakeCount, capacity, openSpots, teamCount, short, shortBy, fill, flags, attention,
  acLevel, minsToDeadline, nextRelease, nextMark, inCities, passesFilter, stillToCome, riskTier, snapRail, vsMin, vsMinDelta, STD_LEAD, MARKS, autoCancels,
  atRisk, realFillPct, dayBucket, DAY_BUCKETS, passesStrip, meter, showsDeadline, type DayBucket, type StripKey,
  bannerUrgent, defaultBanners, riskSubtitle, BANNER_LEAD_MINUTES, DEFAULT_BANNER_CAP,
} from "@/lib/gamedayModel";
import {
  fakesFor, rungFor, markInForce, rungKey, spotsLeftWriteDiff, spotsLeftNow, type Ladder,
} from "@/lib/fakeLadder";

const ENV = DRAWER_ENV; // the board reads and edits the same environment as the drawer

/** The strip tiles' names, for the empty state — so it says which filter found nothing. */
const STRIP_LABEL: Record<StripKey, string> = {
  all: "All matches", risk: "Needs attention", soon: "Still to come", live: "In play", fill: "Real spots filled",
};

const localYMD = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const addDays = (ymd: string, n: number) => { const [y, m, d] = ymd.split("-").map(Number); const dt = new Date(y, m - 1, d + n); return localYMD(dt); };
const dayLabel = (ymd: string) => { const [y, m, d] = ymd.split("-").map(Number); return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" }); };
// Phone day label: "Sun, Aug 9" — the long weekday+month+year won't fit a 44px band.
const shortDay = (ymd: string) => { const [y, m, d] = ymd.split("-").map(Number); return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }); };
const clockNow = (nowMs: number) => new Date(nowMs).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

async function authFetch(path: string): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return fetch(path, { headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) }, cache: "no-store" });
}

const PANEL_W = 600; // the in-place match panel (replaces the old side drawer + "Open full editor")
/* CAPPED AT 760, the same width the Fields drawer uses (FieldsView: min(760px,96vw)).
 *
 * IT WAS 820 AND THAT ATE THE LIST. At 1600 the panel took 820px of edge and the board's rows were
 * clipped mid-bar — the SPOTS column rendered "36 total of 3…" with the rest running under the
 * panel. A drawer that makes the thing behind it unreadable is not a wider drawer, it is a modal
 * that forgot to say so. 760 keeps the teams grid's name-plus-phone rows (the reason it widened in
 * the first place) and gives the board back 60px at every width above 1600. */
const PANEL_W_WIDE = 760;
const DOCK_W = 360;  // the CRM chat dock's expanded width — they sit side-by-side at ≥1600

// ONE BOARD, TWO CALLERS. Match Ops renders it bare; the city-manager tier passes three props.
// Everything else — the rails, the bands, the fake-spot ladder, the decide-by countdown, the
// grouping, both layouts — is the same component, because the difference between the two pages is
// WHICH MATCHES, not what a match looks like.
//
//   endpoint    where the day comes from. Default is the admin route (every city). The city tier
//               passes its own, which is scoped server-side from the session.
//   lockedCity  renders the city control as a single locked chip instead of the chip row. The lock
//               is a UI fact, not the security: the scoped endpoint has already decided.
//   onOpenMatch replaces "open the match panel". The city tier sends the operator to the match's
//               Manager Pay row instead — the panel, the roster and the cancel preview are all
//               things this tier must not reach, and the routes behind them refuse it anyway.
//               When this is set the panel is never mounted at all.
//   nav         the board renders the app bar itself (its refresh + freshness stamp share that
//               44px band), so the caller's nav list has to reach it here rather than from the
//               layout. Omitted = the Match Ops list, as before.
export default function GamedayBoard({
  endpoint,
  lockedCity = null,
  onOpenMatch,
  nav,
}: {
  endpoint?: string;
  lockedCity?: string | null;
  onOpenMatch?: (id: number) => void;
  nav?: { items: RailItem[]; title: string };
} = {}) {
  const router = useRouter();
  const { appUser } = useAuth();
  const [today] = useState(() => localYMD(new Date()));
  const [date, setDate] = useState(today);
  const [matches, setMatches] = useState<ApiMatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // When the DATA landed — not the wall clock. null until the first successful fetch.
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [staleFail, setStaleFail] = useState(false); // last manual refresh failed; rows are old but kept
  /* THE all/att/upc FILTER STATE IS GONE. Both pill rows that drove it were replaced by the stat
   * strip, so nothing could set it and nothing but its own reader could read it — state that looks
   * like a control and is not is how the next person ships a bug against it. */
  /* ── THE STAT STRIP'S SELECTION ───────────────────────────────────────────────────────────────
   * `null` is "no bucket filter". Only risk / soon / live are selectable; All matches and Real
   * spots filled are read-outs, and the board does not wire them as filters at all rather than
   * wiring them to a no-op. Clicking the active tile again clears, which is why this is a single
   * nullable key and not a set. */
  const [strip, setStrip] = useState<StripKey | null>(null);
  /* WHICH SECTIONS ARE OPEN. Finished starts CLOSED — it is the largest section by the end of a
   * day and it is the one nobody is acting on. */
  const [openSec, setOpenSec] = useState<Record<DayBucket, boolean>>({ soon: true, live: true, done: false, cx: false });
  /* PENDING MINIMUM ADJUSTMENTS, per match id, from the banner stepper. A value here means the
   * operator has stepped but not saved. It is DISCARDED when the editor opens — see openDrawer. */
  const [pendingMin, setPendingMin] = useState<Record<number, number>>({});
  /* THE OTHER TWO PENDING VALUES. Fakes and the 3h rung follow the same local-then-save shape as
   * the minimum: step freely, nothing leaves the browser until Save. */
  /* ONE PENDING VALUE FOR THE ONE FAKE CONTROL: the spots-shown-as-left rung. */
  const [pendingSpots, setPendingSpots] = useState<Record<number, number>>({});
  /* ── ONE PANEL, TWO TABS ──────────────────────────────────────────────────────────────────────
   * Not a second drawer. Open match chat opens the SAME panel on Chat; a row opens it on Details.
   * The tab is panel state, so switching does not unmount MatchPanel and unsaved edits survive —
   * see the render, where Details is HIDDEN rather than removed. */
  const [panelTab, setPanelTab] = useState<"details" | "chat">("details");
  const [saveState, setSaveState] = useState<Record<number, { s: "saving" | "landed" | "failed" | "unknown"; msg: string }>>({});
  const [cities, setCities] = useState<Set<string>>(new Set());
  const [drawerId, setDrawerId] = useState<number | null>(null);
  const [drawerDirty, setDrawerDirty] = useState(false);
  // The dock collision. The CRM chat dock is already a right-edge column; the panel wants the same
  // edge. ≥1600 they coexist (panel sits left of the dock, main shrinks). <1600 opening the panel
  // COLLAPSES the dock to its rail — the thread and draft live in the provider, so nothing is lost;
  // it is not reopened when the panel closes (the operator's choice). Said once, the first time.
  // NULL in the city-manager shell, which mounts no CRM provider on purpose. Every use below is
  // guarded — see useCrmConversationOptional.
  const crm = useCrmConversationOptional();
  const [wide, setWide] = useState(false);
  const [dockNotice, setDockNotice] = useState(false);
  const dockNoticeShown = useRef(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(min-width: 1600px)");
    const on = () => setWide(mq.matches); on();
    mq.addEventListener("change", on); return () => mq.removeEventListener("change", on);
  }, []);
  useEffect(() => {
    if (drawerId == null || wide) return;
    if (crm?.dockedThreadId && crm.dockOpen) {
      crm.setDockOpen(false); // collapse only — dockedThreadId + drafts stay in the provider
      if (!dockNoticeShown.current) { dockNoticeShown.current = true; setDockNotice(true); }
    }
  }, [drawerId, wide, crm?.dockedThreadId, crm?.dockOpen, crm]);
  const coexist = drawerId != null && wide && !!crm?.dockedThreadId && crm.dockOpen;
  const panelW = wide && !coexist ? PANEL_W_WIDE : PANEL_W;
  const [toast, setToast] = useState<{ t: string; bad?: boolean } | null>(null);
  // Snapshot is the ONLY layout. The Detail card view and its Snapshot/Detail toggle were removed
  // — the whole day on one screen is the job, and a second layout was a fork nobody chose.
  // A stale ?view=detail bookmark is simply ignored: nothing reads the param, so the page loads.
  // Phone-only: the "Gameday Ops ▾" title opens the screen picker (replaces the tab strip).
  const [pickerOpen, setPickerOpen] = useState(false);
  const mheadRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
  }, []);
  const badge = envBadge(ENV);
  const updatedLabel = updatedAt == null ? "—" : clockNow(updatedAt);
  // `now` already ticks every 30s, so the "Nm ago" figure stays honest without its own timer.
  const staleMins = updatedAt == null ? 0 : Math.floor((now - updatedAt) / 60000);

  const say = (t: string, bad = false) => { setToast({ t, bad }); setTimeout(() => setToast(null), 2800); };

  // `quiet` = a manual refresh: keep the current rows on screen instead of flashing the loader,
  // and NEVER blank the table on failure. Stale data the manager knows is stale beats an empty page.
  const load = useCallback(async (d: string, quiet = false) => {
    if (quiet) setRefreshing(true); else setLoading(true);
    if (!quiet) setErr(null);
    setStaleFail(false);
    let landed = false;
    try {
      const res = await authFetch(`${endpoint ?? `/api/matchday/${ENV}/gameday`}?date=${d}`);
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (quiet) setStaleFail(true); else { setErr(j?.error ?? `HTTP ${res.status}`); setMatches([]); }
      } else { setMatches((j.matches ?? []) as ApiMatch[]); landed = true; }
    } catch (e) {
      if (quiet) setStaleFail(true); else { setErr(e instanceof Error ? e.message : String(e)); setMatches([]); }
    }
    // THE TIMESTAMP MOVES ONLY WHEN DATA LANDED. A clock that ticks regardless is a clock
    // pretending to be a freshness indicator.
    if (landed) setUpdatedAt(Date.now());
    setLoading(false); setRefreshing(false);
  }, [endpoint]);
  useEffect(() => { void load(date); }, [date, load]);
  // 15s, not 30s: this clock drives the freshness age, and at 30s the "2 minutes" threshold
  // could be reported up to half a minute late — which reads as "the stamp is not ageing".
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 15000); return () => clearInterval(t); }, []);
  // Phone: glue the sticky group subheads directly under the sticky header. The header
  // is 3 fixed 44px bands + the 3px prod strip (~135px), but measure it so a wrapped
  // chip row can't shove a group header under the wrong offset. Harmless on desktop
  // (mhead is display:none → 0, and desktop group heads aren't sticky).
  useEffect(() => {
    const set = () => { const h = mheadRef.current?.getBoundingClientRect().height ?? 0; document.documentElement.style.setProperty("--gd-hdrh", `${Math.round(h) + 3}px`); };
    set(); window.addEventListener("resize", set); return () => window.removeEventListener("resize", set);
  }, []); // the mhead is 3 fixed bands — height is constant; only mount + viewport resize matter

  const guardLeave = () => { if (drawerDirty) { say("Save or revert first.", true); return false; } return true; };
  const goDay = (d: string) => { if (!guardLeave()) return; if (drawerId != null) setDrawerId(null); setDate(d); };

  // scope = the city selection; the STATS (filter counts, band counts) derive from it,
  // not just the grid.
  const scope = useMemo(() => matches.filter((m) => inCities(m, cities)), [matches, cities]);
  const counts = useMemo(() => ({
    all: scope.length,
    att: scope.filter((m) => attention(m, now)).length,
    upc: scope.filter((m) => stillToCome(m, now)).length, // §0: the ONE predicate the group + rows use
  }), [scope, now]);
  const cityNames = useMemo(() => {
    const map = new Map<string, number>();
    for (const m of matches) { const c = m.field?.city?.name; if (c) map.set(c, (map.get(c) ?? 0) + 1); }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [matches]);

  /* ── THE STRIP ────────────────────────────────────────────────────────────────────────────────
   * Every figure derives from `scope` — the CITY-filtered set — not from `matches`. A tile that
   * counted the whole day while the grid showed one city would be describing a different page. */
  const strips = useMemo(() => {
    const soon = scope.filter((m) => dayBucket(m, now) === "soon");
    const live = scope.filter((m) => dayBucket(m, now) === "live");
    const risk = scope.filter((m) => atRisk(m, now));
    const f = realFillPct(scope);
    const cityCount = new Set(scope.map((m) => m.field?.city?.name).filter(Boolean)).size;
    const nextKick = soon.length ? soon.slice().sort(byKickoff)[0] : null;
    return { soon, live, risk, fill: f, cityCount, nextKick, allCount: scope.length,
             riskSub: riskSubtitle(scope, now, date === today) };
  }, [scope, now]);

  /* THE GRID. City first, then the bucket — the two COMPOSE, so Austin + In play is Austin
   * matches in play and nothing else. Neither ever widens the other. */
  const shown = useMemo(
    () => scope.filter((m) => passesStrip(m, now, strip)).sort(byKickoff),
    [scope, now, strip],
  );
  const sections = useMemo(
    () => DAY_BUCKETS.map((B) => ({ B, rows: shown.filter((m) => dayBucket(m, now) === B.k) })),
    [shown, now],
  );
  const isToday = date === today;
  /* ── WHICH BANNERS RENDER, AND WHEN ───────────────────────────────────────────────────────────
   * DEFAULT VIEW: only matches that are urgent TODAY - short, armed, and inside
   * BANNER_LEAD_MINUTES of their deadline. Capped, soonest deadline first, with a line offering
   * the rest. On any other date the default view shows no banners at all: nine interrupts about
   * tomorrow pushed the match table off the screen and taught the operator to scroll past them.
   *
   * NEEDS ATTENTION: every short match, as a banner INSTEAD of a row. That filter is what the
   * banner format is for - the operator asked for the list, so the list is the interrupt.
   *
   * EVERY OTHER FILTER: rows, never banners. */
  /* `visible` fed the old grouping and now only supplies the panel's prev/next siblings. It
   * follows the strip, which is the only selection the page still has. */
  const visible = shown;
  const risky = useMemo(() => scope.filter((m) => atRisk(m, now)).sort(byKickoff), [scope, now]);
  const bannerMode = strip === "risk";
  const defaults = useMemo(() => defaultBanners(scope, now, isToday), [scope, now, isToday]);
  const banners = bannerMode
    ? risky.slice().sort((a, b) => minsToDeadline(a, now) - minsToDeadline(b, now))
    : defaults.show;
  const moreCount = bannerMode ? 0 : defaults.more;
  /* CITIES HOLDING AN AT-RISK MATCH, for the chip's risk style. Derived from `matches`, not
   * `scope`: selecting Austin must not stop Houston's chip from showing that Houston has a
   * problem — that is the one moment the operator most needs to see it. */
  /* ONLY CITIES WITH AN URGENT MATCH. It used to be every city holding a short match, which on
   * tomorrow's board is EVERY city - a row of red chips that means "this day has not sold yet",
   * which is not what red is for. Restricted to the same predicate the default banner uses, so on
   * a future date no chip is red. */
  const riskCities = useMemo(() => {
    const set = new Set<string>();
    for (const m of matches) if (bannerUrgent(m, now, date === today)) { const c = m.field?.city?.name; if (c) set.add(c); }
    return set;
  }, [matches, now, date, today]);

  /* ── THE ONE WRITE ON THIS PAGE ───────────────────────────────────────────────────────────────
   * KEYED ON THE ACTUAL EDIT MATCHES RIGHT, not on whether a callback was passed.
   *
   * The first version of this read `!onOpenMatch` — inferring write capability from the presence
   * of a prop. That is a proxy, and it fails the day someone wires onOpenMatch into
   * /city/gameday for any reason: the stepper would go live for a tier that must never reach a
   * write, and nothing in the diff would look wrong. `canEditMatches` is the same permission the
   * write route enforces server-side; this is the courtesy half of that check, and the route is
   * still what actually holds. */
  const canEditMin = canEditMatches(appUser);
  /* LOWERING THE MINIMUM GENUINELY RESCUES THE MATCH — PROVEN, NOT ASSUMED.
   *
   * Staging experiment, 2026-09-01. Two identical matches, both armed (autoCanceled true,
   * autoCanceledMinutes 20) and both short (0 real against a minimum of 9), deadline 20:55:34:
   *   A CONTROL   left at min 9  -> isCancelled TRUE  by 21:00
   *   B TREATMENT min -> 0 at 20:51 -> isCancelled FALSE, still false at 21:07
   * The control firing is what makes the treatment mean anything: it proves the mechanism is live
   * and observable, so B staying up is a prevented cancel and not a quiet worker. B was watched for
   * twelve minutes past A's cancellation, so it is not merely slower.
   *
   * The cancel fires LATE by a VARIABLE margin — 10 seconds past nominal in one run, about four
   * minutes forty in another. The countdown is a guide, not a contract, and the banner does not
   * promise otherwise.
   *
   * AND FAKE SPOTS DO NOT COUNT TOWARD THE MINIMUM — proven the same evening with a fixture where
   * the two hypotheses disagree: real 0, fake 16, minimum 3. Total was five times the minimum and
   * it cancelled anyway. So the countdown is REAL for exactly the matches this page was built for:
   * a match propped up by fakes still cancels, and `short()` keying on realCount is right. */
  const stepperReason = canEditMin
    ? "Lowering the minimum TO OR BELOW the real player count prevents the pending auto-cancel — proven on staging 2026-09-01. A smaller reduction that still leaves a shortfall does not."
    : "You have read-only Match Ops access. EDIT MATCHES is required to change a match minimum.";

  const stepMin = (id: number, d: number) => {
    const m = matches.find((x) => x.id === id);
    if (!m) return;
    const cap = capacity(m) ?? Number(m.maxPlayerCount ?? 0);
    const cur = pendingMin[id] ?? Number(m.minPlayerCount ?? 0);
    /* FLOOR 2, CEILING CAPACITY. The buttons are disabled at the bound rather than clamping
     * silently — a − that does nothing and says nothing is a control that looks live. This clamp
     * is the second line of defence, not the first. */
    const next = Math.max(2, Math.min(cap, cur + d));
    if (next === cur) return;
    setSaveState((p) => { const n = { ...p }; delete n[id]; return n; });
    setPendingMin((p) => {
      const saved = Number(m.minPlayerCount ?? 0);
      const n = { ...p };
      // Stepping back to the saved value is not a pending change — it restores Cancel now.
      if (next === saved) delete n[id]; else n[id] = next;
      return n;
    });
  };

  /* SAVE. ONE ATTEMPT, NEVER A RETRY — there is no Idempotency-Key on this API and a duplicate
   * write is visible to a player. The route reads the match back and returns its own verdict; a
   * 2xx alone is not a landed write and is never treated as one.
   *
   * ON UNKNOWN, LOCAL STATE IS NOT MUTATED. The board refetches instead, because the one thing
   * worse than not knowing is showing a number nobody has confirmed. */
  const saveMin = async (id: number) => {
    const next = pendingMin[id];
    if (next == null) return;
    setSaveState((p) => ({ ...p, [id]: { s: "saving", msg: "Saving…" } }));
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      const res = await fetch(`/api/matchday/${ENV}/matches/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        // THE DIFF IS THE REQUEST BODY. Only the field that changed.
        body: JSON.stringify({ changes: { minPlayerCount: next }, source: "gameday-stepper" }),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok) {
        setSaveState((p) => ({ ...p, [id]: { s: "failed", msg: `FAILED — ${j?.error ?? `HTTP ${res.status}`}` } }));
        return;
      }
      const outcome = String(j?.outcome ?? "").toLowerCase();
      if (outcome === "landed") {
        setSaveState((p) => ({ ...p, [id]: { s: "landed", msg: `LANDED — minimum is ${next}` } }));
        setPendingMin((p) => { const n = { ...p }; delete n[id]; return n; });
        await load(date, true);   // the row's notch, label and delta all move off the refetch
      } else if (outcome === "failed" || outcome === "not_applied" || outcome === "not applied") {
        setSaveState((p) => ({ ...p, [id]: { s: "failed", msg: `${outcome.toUpperCase()} — the minimum did not change` } }));
      } else {
        setSaveState((p) => ({ ...p, [id]: { s: "unknown", msg: "UNKNOWN — refetching rather than guessing" } }));
        setPendingMin((p) => { const n = { ...p }; delete n[id]; return n; });
        await load(date, true);
      }
    } catch (e) {
      setSaveState((p) => ({ ...p, [id]: { s: "failed", msg: `FAILED — ${e instanceof Error ? e.message : String(e)}` } }));
    }
  };

  const drawerSiblings = useMemo(() => visible.map((m) => m.id), [visible]);

  const money = (c: number | null | undefined) => (c == null ? "—" : "$" + centsToDollars(c));

  // A read-only caller never opens the panel — it is not hidden, it is not built.
  const openDrawer = (id: number) => {
    if (onOpenMatch) { onOpenMatch(id); return; }
    if (drawerId != null && drawerId !== id && !guardLeave()) return;
    /* ── THE EDITOR IS THE SINGLE SOURCE OF TRUTH ONCE OPEN ────────────────────────────────────
     * Any pending stepper value is DISCARDED here, not merged and not used to pre-fill. The
     * stepper and the editor write the same field, and two live drafts of one field is how a
     * value nobody chose gets saved: the operator steps to 7, opens the editor to check something,
     * sees 7 pre-filled, assumes it is stored, and saves it. Discarding is the only rule that
     * cannot produce that. It is also why the stepper resets to the SAVED value on close. */
    setPendingMin({});
    setPendingSpots({});
    setSaveState({});
    setPanelTab("details");
    setDrawerId(id);
  };
  /* THE SAME PANEL, OPENED ON CHAT. It does not navigate — losing your place on the board to read
   * one message is the behaviour this replaces. A read-only caller still routes out, because that
   * tier does not mount the panel at all. */
  const openChat = (id: number) => {
    if (onOpenMatch) { router.push(`/match-ops/match-chats?chatId=${encodeURIComponent(String(id))}`); return; }
    if (drawerId != null && drawerId !== id && !guardLeave()) return;
    if (drawerId !== id) { setPendingMin({}); setPendingSpots({}); setSaveState({}); }
    setPanelTab("chat");
    setDrawerId(id);
  };
  const ladderOf = (m: ApiMatch): Ladder => ({
    fakeSpotLeft36h: Number(m.fakeSpotLeft36h ?? 0), fakeSpotLeft24h: Number(m.fakeSpotLeft24h ?? 0),
    fakeSpotLeft12h: Number(m.fakeSpotLeft12h ?? 0), fakeSpotLeft6h: Number(m.fakeSpotLeft6h ?? 0),
    fakeSpotLeft3h: Number(m.fakeSpotLeft3h ?? 0),
  });

  /* ── ONE WRITE HELPER FOR BOTH RUNG CONTROLS ──────────────────────────────────────────────────
   * Same contract as saveMin and for the same reasons: the diff IS the body, one attempt, never a
   * retry, and the verdict comes from the route's read-back rather than from a 2xx.
   *
   * THE VERDICT IS JUDGED ON THE RUNG, NOT ON THE FAKE COUNT. Measured on staging: the worker
   * takes about 150 seconds to recompute fakes after a rung changes. Judging the write on the fake
   * count would report FAILED for a write that landed perfectly and simply has not been applied
   * yet. The rung reads back immediately; that is what LANDED means here. */
  const saveRungs = async (id: number, diff: Ladder, note: string, clear: () => void) => {
    /* AN EMPTY DIFF STILL REPORTS. It used to return silently — the operator pressed Save, nothing
     * was sent because every band already held the value, and NOTHING APPEARED. A save that
     * produces no visible outcome is indistinguishable from one that failed. */
    if (Object.keys(diff).length === 0) {
      setSaveState((p) => ({ ...p, [id]: { s: "landed", msg: `LANDED - ${note} (already stored)` } }));
      clear();
      return;
    }
    setSaveState((p) => ({ ...p, [id]: { s: "saving", msg: "Saving…" } }));
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      const res = await fetch(`/api/matchday/${ENV}/matches/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ changes: diff, source: "gameday-fakes" }),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok) {
        setSaveState((p) => ({ ...p, [id]: { s: "failed", msg: `FAILED — ${j?.error ?? `HTTP ${res.status}`}` } }));
        return;
      }
      const outcome = String(j?.outcome ?? "").toLowerCase();
      if (outcome === "landed") {
        setSaveState((p) => ({ ...p, [id]: { s: "landed", msg: `LANDED — ${note}` } }));
        clear();
        await load(date, true);
      } else if (outcome === "failed" || outcome === "not_applied" || outcome === "not applied") {
        setSaveState((p) => ({ ...p, [id]: { s: "failed", msg: `${outcome.toUpperCase()} — the ladder did not change` } }));
      } else {
        setSaveState((p) => ({ ...p, [id]: { s: "unknown", msg: "UNKNOWN — refetching rather than guessing" } }));
        clear();
        await load(date, true);
      }
    } catch (e) {
      setSaveState((p) => ({ ...p, [id]: { s: "failed", msg: `FAILED — ${e instanceof Error ? e.message : String(e)}` } }));
    }
  };

  const stepSpots = (id: number, d: number) => {
    const m = matches.find((x) => x.id === id); if (!m) return;
    const cap = capacity(m) ?? 0, real = realCount(m);
    const cur = pendingSpots[id] ?? spotsLeftNow(ladderOf(m), minsUntil(m, now) / 60);
    /* FLOOR 0 (every spot shown taken) AND CEILING capacity minus real (no fakes at all). The
     * buttons are disabled at the bound; this is the second line of defence. */
    const next = Math.max(0, Math.min(Math.max(0, cap - real), cur + d));
    if (next === cur) return;
    setSaveState((p) => { const n = { ...p }; delete n[id]; return n; });
    setPendingSpots((p) => {
      const saved = spotsLeftNow(ladderOf(m), minsUntil(m, now) / 60);
      const n = { ...p }; if (next === saved) delete n[id]; else n[id] = next; return n;
    });
  };
  const saveSpots = (id: number) => {
    const m = matches.find((x) => x.id === id); if (!m) return;
    const target = pendingSpots[id]; if (target == null) return;
    const cap = capacity(m) ?? 0, real = realCount(m);
    const w = spotsLeftWriteDiff(ladderOf(m), minsUntil(m, now) / 60, target);
    void saveRungs(id, w.diff,
      `${target} spot${target === 1 ? "" : "s"} showing as left · ${fakesFor(cap, target, real)} fake`,
      () => setPendingSpots((p) => { const n = { ...p }; delete n[id]; return n; }));
  };

  /* CLOSING RE-READS THE MATCH, so the banner, the row and the Needs attention tile all reflect
   * whatever the editor did — including an edit that did not touch the minimum. */
  const closeDrawer = () => {
    if (!guardLeave()) return;
    setDrawerId(null);
    void load(date, true);
  };
  const stepIdx = drawerId != null ? drawerSiblings.indexOf(drawerId) : -1;
  const step = (d: number) => { if (!guardLeave()) return; const i = stepIdx + d; if (i >= 0 && i < drawerSiblings.length) setDrawerId(drawerSiblings[i]); };
  const toggleCity = (c: string) => setCities((prev) => { const n = new Set(prev); if (c === "") return new Set(); n.has(c) ? n.delete(c) : n.add(c); return n; });

  // THE grouping — four groups (still-to-come, in-play, cancelled, finished), from the ONE
  // matchGroup() function, shared by BOTH views so they can never disagree. Every group sorts
  // by kickoff (`visible` is already byKickoff). The Risk sort was removed in Phase 21 §8: it
  // duplicated the "Needs attention" filter — sorting risk to the top and filtering to it
  // answer the same question, and the filter answers it better without reshuffling the day.
  const grouped = useMemo(() => GROUPS.map((G) => ({ G, rows: visible.filter((m) => matchGroup(m, now) === G.k) }))
    .filter((x) => x.rows.length), [visible, now]);
  const anyRows = grouped.some((x) => x.rows.length > 0);

  return (
    <div className="gdo" data-testid="gameday" data-env={ENV} style={{ ["--drawer-w" as string]: `${panelW + (coexist ? DOCK_W : 0)}px` }}>
      <style>{CSS}</style>
      <div className={"gmain" + (drawerId != null ? " drawering" : "")}>
        {/* ── PHONE header (≤759px). Desktop shows the .head card below; this is
            display:none there. Three 44px bands under a 3px prod strip, ~135px total,
            replacing 600px of chrome. The horizontal tab strip is gone (the layout
            suppresses it on this route); the title itself is the screen picker. ── */}
        <span className={"prodstrip " + (badge.tone === "prod" ? "live" : "stg")} data-testid="prodstrip" aria-hidden />
        <div className="mhead" data-testid="mhead" ref={mheadRef}>
          {/* THE SHARED HEADER. Gameday Ops used to build its own picker row here and Chats used a
              different system entirely; this is the one component both now render, so they cannot
              drift again. The page's own controls go in `actions`. */}
          <MatchOpsMobileBar
            items={nav?.items}
            sheetTitle={nav?.title}
            showSwitch={!nav}
            leading={badge.tone === "prod" ? <span className="livedot" aria-hidden /> : null}
            actions={
              <span className="mfresh" data-testid="m-fresh">
                <span className={"mstamp" + (staleFail ? " failed" : staleMins >= 2 ? " stale" : "")} data-testid="m-updated-at">
                  {/* KEEP THE TIME and APPEND the age — "11:51 PM · 3m ago". */}
                  {staleFail ? "not refreshed" : updatedAt == null ? "…" : staleMins >= 2 ? `${updatedLabel} · ${staleMins}m ago` : updatedLabel}
                </span>
                <button type="button" className="mrefresh" data-testid="m-gday-refresh" disabled={refreshing}
                  aria-label="Refresh the board" onClick={() => void load(date, true)}>
                  <RefreshIcon size={19} spinning={refreshing} />
                </button>
              </span>
            }
          />
          <div className="mband">
            <span className="mdaynav">
              <button className="marw" data-testid="m-day-prev" aria-label="Previous day" onClick={() => goDay(addDays(date, -1))}>‹</button>
              <span className="mdaylab"><b data-testid="m-daylab">{shortDay(date)}</b>{date === today && <i>TODAY</i>}</span>
              <button className="marw" data-testid="m-day-next" aria-label="Next day" onClick={() => goDay(addDays(date, 1))}>›</button>
              <input type="date" className="daypick" data-testid="m-day-pick" aria-label="Jump to a date"
                value={date} onChange={(e) => { if (e.target.value) goDay(e.target.value); }} />
            </span>
            <button className="chip mtoday" data-testid="m-day-today" disabled={date === today} onClick={() => goDay(today)}>Today</button>
          </div>
          {/* ONE scroller: filters + cities together, the only horizontal scroll on the page. */}
          {/* THE MOBILE PILL ROW LOST ITS FILTERS TOO. It duplicated the stat strip directly below
              it - two controls for one selection, and on a 390px screen the second one was clipped
              at the right edge. Cities stay: this is where they live on a phone. */}
          <div className="mchips" data-testid="mchips">
            {/* LOCKED, NOT REMOVED — the control still says which city this is. */}
            {lockedCity ? (
              <button className="chip on" data-testid="city-locked" disabled aria-disabled="true"
                title={`Scoped to ${lockedCity}`}>{lockedCity}<span className="b">{counts.all}</span></button>
            ) : (<>
              <button className={"chip" + (cities.size === 0 ? " on" : "")} onClick={() => toggleCity("")}>All cities</button>
              {cityNames.map(([c, n]) => (
                <button key={c} className={"chip gchip" + (cities.has(c) ? " on" : "") + (riskCities.has(c) ? " risk" : "")}
                  data-testid={`mcity-${c}`} data-risk={riskCities.has(c) ? "1" : "0"}
                  onClick={() => toggleCity(c)}>{c}<u>{n}</u></button>
              ))}
            </>)}
          </div>
        </div>
        <LogHealthBanner />
        <div className="panel head">
          <div className="r1">
            <h1>Gameday Ops</h1>
            {/* Refresh + freshness, in the space the Snapshot/Detail toggle vacated. The stamp is
                when the DATA landed; it goes muted with "· Nm ago" after 2 minutes so staleness is
                visible without being loud. NO AUTO-POLLING: this page has live edit controls and
                rows re-sort by kickoff, so a background refetch could reorder the list under a
                cursor mid-click. Manual only. */}
            <span className="fresh" data-testid="fresh">
              <button type="button" className="refresh" data-testid="gday-refresh" disabled={refreshing}
                aria-label="Refresh the board" title="Refresh the board"
                onClick={() => void load(date, true)}>
                <RefreshIcon size={14} spinning={refreshing} />
                <span className="rlab">{refreshing ? "Refreshing…" : "Refresh"}</span>
              </button>
              <span className={"stamp" + (staleFail ? " failed" : staleMins >= 2 ? " stale" : "")} data-testid="updated-at">
                {staleFail ? `Couldn't refresh · showing ${updatedLabel}`
                  : updatedAt == null ? "Loading…"
                  : staleMins >= 2 ? `Updated ${updatedLabel} · ${staleMins}m ago`
                  : `Updated ${updatedLabel}`}
              </span>
            </span>
          </div>
          <div className="chips">
            <div className="daynav">
              <button className="arw" data-testid="day-prev" aria-label="Previous day" onClick={() => goDay(addDays(date, -1))}>‹</button>
              <div className="daylab"><b data-testid="daylab">{dayLabel(date)}</b><i>{date === today ? "TODAY" : ""}</i></div>
              <button className="arw" data-testid="day-next" aria-label="Next day" onClick={() => goDay(addDays(date, 1))}>›</button>
              {/* THE PICKER DOES NO DATE ARITHMETIC AT ALL, and that is the whole design.
                  <input type="date"> yields "YYYY-MM-DD" — the exact shape `date` already holds —
                  so the value goes straight into goDay(), the same function the arrows call. There
                  is no parse, no format, no new Date(), and therefore no way for the picker and the
                  arrows to disagree about what day it is: they are the same state and the same
                  setter. A day boundary can only be wrong here if it is already wrong for ‹ ›. */}
              <input type="date" className="daypick" data-testid="day-pick" aria-label="Jump to a date"
                value={date} onChange={(e) => { if (e.target.value) goDay(e.target.value); }} />
            </div>
            <button className="chip" data-testid="day-today" disabled={date === today} onClick={() => goDay(today)}>Today</button>
            {/* THE PILL ROW IS GONE — the stat strip below the header is the filter now, and it
                carries the counts these pills used to. Keeping both would be two controls for one
                selection. */}
          </div>
          {/* COMPACT CHIPS. A city holding an at-risk match carries the risk style, so the row
              above the grid answers "where is tonight's problem" without reading the grid. */}
          <div className="row2 gcities"><span className="lb">CITIES</span>
            <span className="cityf" data-testid="cityf">
              {lockedCity ? (
                <button className="chip gchip on" data-testid="city-locked" disabled aria-disabled="true"
                  title={`Scoped to ${lockedCity}`}>{lockedCity}<u>{counts.all}</u></button>
              ) : (<>
                <button className={"chip gchip" + (cities.size === 0 ? " on" : "")} data-testid="city-all"
                  onClick={() => toggleCity("")}>All cities<u data-testid="city-all-n">{matches.length}</u></button>
                {cityNames.map(([c, n]) => (
                  <button key={c} className={"chip gchip" + (cities.has(c) ? " on" : "") + (riskCities.has(c) ? " risk" : "")}
                    data-testid={`city-${c}`} data-risk={riskCities.has(c) ? "1" : "0"}
                    onClick={() => toggleCity(c)}>{c}<u>{n}</u></button>
                ))}
              </>)}
            </span>
          </div>
          <span className={"pill " + (badge.tone === "prod" ? "live" : "stg")} data-testid="gameday-env">{badge.tone === "prod" ? <><i />PRODUCTION — LIVE EDITS</> : badge.label}</span>
        </div>

        {loading ? <div className="empty" data-testid="loading">Loading {dayLabel(date)}…</div>
          : err ? <div className="empty err" data-testid="board-err">Couldn’t load the board: {err}</div>
          : <>
              <StatStrip s={strips} active={strip} clockOf={localClock}
                onPick={(k) => setStrip((prev) => (prev === k ? null : k))} />

              {/* The slot renders nothing at all when there is nothing urgent - an empty box that
                  is always there stops being looked at. */}
              {banners.length > 0 && (
                <div data-testid="gday-alertslot" data-mode={bannerMode ? "filter" : "default"}>
                  {banners.map((m) => (
                    <AlertBanner key={m.id} m={m} now={now}
                      pending={pendingMin[m.id] ?? null}
                      pendingSpots={pendingSpots[m.id] ?? null}
                      onStep={stepMin} onStepSpots={stepSpots}
                      onSave={saveMin} onSaveSpots={saveSpots}
                      onOpen={openDrawer} onChat={openChat}
                      saveState={saveState[m.id]}
                      canEdit={canEditMin} stepperReason={stepperReason} />
                  ))}
                  {/* THE REST, ONE CLICK AWAY. The cap keeps the table on the first screen; this
                      line keeps the others from being hidden by it. */}
                  {moreCount > 0 && (
                    <button type="button" className="gmore" data-testid="gday-more-risk"
                      onClick={() => setStrip("risk")}>
                      +{moreCount} more need attention
                    </button>
                  )}
                </div>
              )}

              {/* NEEDS ATTENTION RENDERS BANNERS INSTEAD OF ROWS - the card is not drawn at all,
                  so there is no empty table under the list. Every other filter draws the table. */}
              {!bannerMode && (
              <div className="gcard" data-testid="snapshot">
                <div className="gcolhead">
                  <div>Kickoff</div><div>Match · field</div><div>Spots vs minimum</div><div>Manager</div>
                </div>
                {shown.length === 0 ? (
                  /* AN EXPLICIT EMPTY STATE, not a blank card — a filter combination that matches
                     nothing must say so, or it reads as a failed load. */
                  <div className="empty" data-testid="empty">
                    Nothing matches {strip ? `“${STRIP_LABEL[strip]}”` : "this view"}
                    {cities.size ? ` in ${[...cities].join(", ")}` : ""} on {dayLabel(date)}.
                  </div>
                ) : sections.map(({ B, rows }) => rows.length === 0 ? null : (
                  <section key={B.k} data-testid={`gday-section-${B.k}`}>
                    <button type="button" className={"gsec" + (B.k === "live" ? " live" : "")}
                      data-testid={`gday-sec-${B.k}`} aria-expanded={openSec[B.k]}
                      onClick={() => setOpenSec((p) => ({ ...p, [B.k]: !p[B.k] }))}>
                      <span className="tw">{B.t}</span>
                      <span className="n" data-testid={`gday-seccount-${B.k}`}>{rows.length}</span>
                      <span className="car">{openSec[B.k] ? "Hide ▴" : "Show ▾"}</span>
                    </button>
                    {/* THE LIST IS THE GUTTER. Bands need ground between them and around them,
                        and that ground belongs to the list rather than to each band's margin —
                        margins collapse, gaps do not. */}
                    {openSec[B.k] && (
                      <div className="glist">
                        {rows.map((m) => (
                          <GRow key={m.id} m={m} now={now} selected={drawerId === m.id}
                            onOpen={openDrawer} money={money} atRiskRow={atRisk(m, now)} />
                        ))}
                      </div>
                    )}
                  </section>
                ))}
              </div>
              )}
              {bannerMode && banners.length === 0 && (
                <div className="gcard"><div className="empty" data-testid="empty">
                  Nothing needs attention{cities.size ? ` in ${[...cities].join(", ")}` : ""} on {dayLabel(date)}.
                </div></div>
              )}
              <p className="gfoot" data-testid="gday-foot">
                {bannerMode ? banners.length : shown.length} of {scope.length} matches
                {cities.size ? ` · ${[...cities].join(", ")}` : ""}
                {" · the tick and its label are the match minimum · fake spots are hatched and do not count toward it"}
              </p>
            </>}
      </div>

      {/* NOT HIDDEN — NOT BUILT. A read-only caller sets onOpenMatch, drawerId therefore never
          leaves null, and MatchPanel is never mounted: no roster fetch, no cancel preview, no
          control that looks live. The routes behind it refuse this tier as well; this is the UI
          half of the same statement. */}
      {drawerId != null && !onOpenMatch && (
        <aside className={"gpanel" + (coexist ? " coexist" : "")} data-testid="gday-panel" style={{ ["--panel-w" as string]: `${panelW}px`, right: coexist ? DOCK_W : 0 }}>
          <div className="gpanel-bar">
            <button className="gpanel-x" data-testid="gday-panel-close" aria-label="Close panel" onClick={closeDrawer}>✕ Close</button>
            <span className="gpanel-step">
              <button data-testid="gday-prev" aria-label="Previous match" disabled={stepIdx <= 0} onClick={() => step(-1)}>‹</button>
              <button data-testid="gday-next" aria-label="Next match" disabled={stepIdx < 0 || stepIdx >= drawerSiblings.length - 1} onClick={() => step(1)}>›</button>
            </span>
          </div>
          {dockNotice && (
            <div className="gpanel-notice" data-testid="gday-dock-notice">
              Chat dock collapsed to make room — reopen it any time from the tab on the right; the thread and your draft are kept.
              <button onClick={() => setDockNotice(false)} aria-label="Dismiss">Got it</button>
            </div>
          )}
          {/* THE TAB STRIP. Two tabs, one panel. */}
          <div className="gpanel-tabs" role="tablist" data-testid="gday-panel-tabs">
            <button type="button" role="tab" data-testid="gday-tab-details"
              aria-selected={panelTab === "details"} className={panelTab === "details" ? "on" : ""}
              onClick={() => setPanelTab("details")}>Details</button>
            <button type="button" role="tab" data-testid="gday-tab-chat"
              aria-selected={panelTab === "chat"} className={panelTab === "chat" ? "on" : ""}
              onClick={() => setPanelTab("chat")}>Chat</button>
          </div>
          {/* DETAILS IS HIDDEN, NOT UNMOUNTED. Unmounting it would throw away unsaved edits on
              every tab switch — the operator changes the minimum, flips to Chat to ask the manager
              about it, comes back and the change is gone. */}
          <div className={"gpanel-body" + (panelTab === "details" ? "" : " gpanel-hide")}
            data-testid="gday-panel-details" aria-hidden={panelTab !== "details"}>
            <MatchPanel key={drawerId} matchId={String(drawerId)} onDirtyChange={setDrawerDirty} />
          </div>
          {/* CHAT RESOLVES THE THREAD THE WAY IT WAS PROVEN TO RESOLVE: chatId is the match api_id.
              No second lookup, and the same ChatPane the standalone console uses. */}
          <div className={"gpanel-body gpanel-chat" + (panelTab === "chat" ? "" : " gpanel-hide")}
            data-testid="gday-panel-chat" aria-hidden={panelTab !== "chat"} data-chat-id={String(drawerId)}>
            <ChatPane chatId={String(drawerId)} showOnMobile={false} embedded onBack={() => setPanelTab("details")} />
          </div>
        </aside>
      )}
      {toast && <div className={"toast" + (toast.bad ? " bad" : "")} data-testid="toast">{toast.t}</div>}
      <MatchOpsSectionSheet open={pickerOpen} onClose={() => setPickerOpen(false)} />
    </div>
  );
}

/* SnapRow WAS HERE AND IS GONE. It was the old eight-column row, left behind when the five-
 * column rebuild replaced it with GRow. Nothing referenced it. Dead code that still compiles
 * is the next person's trap: it looked like the row component and was not, and an edit made
 * to it would have had no effect anyone could see. */

const CSS = `
.gdo{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Helvetica,Arial,sans-serif;color:#0B1F17;background:#EDF2EF;min-height:100vh}
.gdo .gmain{padding:20px 24px 70px;transition:margin-right .17s ease-out}
.gdo .gmain.drawering{margin-right:var(--drawer-w,480px)}
/* the in-place match panel (replaces the old drawer). Fixed right edge; the right offset is set
   inline to the dock width when they coexist (>=1600) so the two never overlap. */
.gdo .gpanel{position:fixed;top:0;bottom:0;height:100dvh;width:min(var(--panel-w,600px),96vw);max-width:100vw;background:#eef2f0;border-left:1px solid #d4e0da;box-shadow:-8px 0 26px rgba(4,26,18,.12);z-index:60;display:flex;flex-direction:column}
/* SAFE AREA. The panel is position:fixed top:0, so without this the header renders beneath the iOS
   status bar and the Dynamic Island — "× Close" was drawn straight through the clock and could not
   be tapped without rotating the device. The bar is STICKY and starts BELOW the inset; the body
   scrolls under it. env() is 0 on desktop, so this changes nothing there. */
.gdo .gpanel-bar{display:flex;align-items:center;gap:8px;padding:9px 12px;background:#04291d;color:#fff;flex:0 0 auto;
  position:sticky;top:0;z-index:2;padding-top:calc(9px + var(--sat));
  padding-left:calc(12px + var(--sal, 0px));padding-right:calc(12px + var(--sar, 0px))}
/* >=44px: this is the only way out of the panel on a phone. */
.gdo .gpanel-x{border:1px solid #2a5644;background:transparent;color:#cfe7dc;border-radius:8px;padding:7px 13px;
  min-height:44px;min-width:44px;font:inherit;font-size:13px;font-weight:600;cursor:pointer}
.gdo .gpanel-x:hover{background:#14432f;color:#fff}
.gdo .gpanel-step{margin-left:auto;display:inline-flex;gap:5px}
.gdo .gpanel-step button{border:1px solid #2a5644;background:transparent;color:#cfe7dc;border-radius:8px;min-width:36px;min-height:34px;font:inherit;font-size:17px;cursor:pointer}
.gdo .gpanel-step button:disabled{opacity:.4;cursor:not-allowed}
.gdo .gpanel-notice{display:flex;align-items:center;gap:10px;background:#fdf2e0;border-bottom:1px solid #e8c383;color:#6b4400;font-size:12px;line-height:1.4;padding:9px 12px;flex:0 0 auto}
.gdo .gpanel-notice button{margin-left:auto;border:1px solid #e8c383;background:#fff;border-radius:6px;padding:4px 10px;font:inherit;font-size:11.5px;font-weight:600;cursor:pointer;white-space:nowrap}
/* THE DRAWER NO LONGER SCROLLS — THE PANEL INSIDE IT DOES, and that is the whole of the save-bar
   fix. This was overflow-y:auto, so MatchPanel sat inside it as ordinary content: .mp-panel's own
   display:flex + overflow:hidden never received a bounded height, it grew to its content, and
   .mp-foot scrolled away with it — measured at top:2782px in a 950px viewport on desktop and
   top:4112px in 780px on a phone. Master Schedule never had the problem because MatchDrawer mounts
   MatchEditor as a direct flex child and the EDITOR owns its scroll. This makes the Gameday drawer
   do the same thing.
   The bottom padding moves to .mp-foot, which is now the element actually touching the bottom. */
.gdo .gpanel-body{flex:1;min-height:0;overflow:hidden;padding:12px;display:flex;flex-direction:column}
/* Only in the drawer. The standalone /match-ops/match-panel/[id] page is a document that scrolls
   with the window, and giving it a viewport height there would trap it in a box. */
.gdo .gpanel-body>.mp{min-height:0;flex:1 1 auto;display:flex}
.gdo .gpanel-body>.mp>.mp-panel{height:100%}
/* THE FIELDSET IS THE FLEX CHILD, not .mp-body. .mp-body lives inside <fieldset class="mp-fs">,
   which wraps the whole form so a read-only viewer gets a genuinely disabled control set rather
   than one that only looks disabled. Without this the fieldset takes its content height, .mp-body
   never shrinks (measured 2626px inside an 864px panel) and the foot is pushed off the bottom —
   which is what the first attempt at this fix missed. */
.gdo .gpanel-body>.mp>.mp-panel>.mp-fs{flex:1 1 auto;min-height:0;display:flex;flex-direction:column}
.gdo .gpanel-body>.mp>.mp-panel>.mp-fs>.mp-body{flex:1 1 auto;min-height:0}
.gdo .panel{background:#fff;border:1px solid #DCE5E0;border-radius:14px}
.gdo .head{padding:18px 20px 16px;margin-bottom:14px;position:relative}
.gdo .r1{display:flex;align-items:baseline;gap:12px}.gdo h1{margin:0;font-size:23px;letter-spacing:-.2px}
/* The lede and the duplicate date beside the title were removed (cosmetic pass): the chips row
   now supplies the gap the paragraph used to, so the header closes up instead of leaving a hole. */
.gdo .chips{margin-top:12px}
.gdo .chips{display:flex;gap:7px;flex-wrap:wrap;align-items:center}
.gdo .daynav{display:flex;align-items:center;gap:8px;margin-right:4px}
.gdo .arw{width:34px;height:34px;border-radius:8px;border:1px solid #DCE5E0;background:#fff;color:#20372C;line-height:1;font-size:16px}
/* The match drawer's WHEN > DATE field, in this page's palette — same 1px border, same radius,
   same white ground, sized to sit level with .arw rather than towering over it. Native picker;
   nothing custom is drawn. */
.gdo .daypick{height:34px;border:1px solid #DCE5E0;border-radius:8px;background:#fff;color:#20372C;
  font:inherit;font-size:13.5px;padding:0 10px;min-width:0}
.gdo .daypick:focus{outline:2px solid #4FE07E;outline-offset:-1px}
.gdo .arw:hover{background:#F2F7F4}
.gdo .daylab{min-width:184px;text-align:center}.gdo .daylab b{display:block;font-size:14.5px}.gdo .daylab i{display:block;font-style:normal;font-size:10px;letter-spacing:.1em;color:#046B45;font-weight:700;min-height:12px}
.gdo .chip{border:1px solid #DCE5E0;background:#fff;border-radius:20px;padding:8px 14px;color:#1B3227;font-size:14px;min-height:34px}
.gdo .chip:hover{background:#F2F7F4}.gdo .chip.on{background:#003326;border-color:#003326;color:#fff;font-weight:600}
.gdo .chip:disabled{opacity:.45}.gdo .chip.att{border-color:#E9B6AC;color:#A83120}.gdo .chip.att.on{background:#A83120;border-color:#A83120;color:#fff}
.gdo .chip .b{display:inline-block;margin-left:6px;font-weight:700;font-size:12px}
.gdo .filters{display:flex;gap:7px}
.gdo .row2{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-top:12px;padding-top:12px;border-top:1px solid #E9EFEB}
.gdo .row2 .lb{font-size:10.5px;letter-spacing:.12em;color:#5C6B62;font-weight:700;margin-right:2px}
.gdo .cityf{display:flex;gap:7px;flex-wrap:wrap}
.gdo .pill{position:absolute;top:18px;right:20px;font-size:10.5px;font-weight:800;letter-spacing:.06em;border-radius:20px;padding:4px 10px}
.gdo .pill.live{background:#E5121B;color:#fff;display:inline-flex;align-items:center;gap:6px}.gdo .pill.live i{width:7px;height:7px;border-radius:50%;background:#fff}
.gdo .pill.stg{background:#F2E31D;color:#231F00}
.gdo .rows{display:flex;flex-direction:column;gap:8px}
.gdo .row{display:block;width:100%;text-align:left;color:inherit;background:#fff;border:1px solid #DCE5E0;border-radius:12px;padding:11px 13px 10px;cursor:pointer}
.gdo .row:hover{border-color:#9FC4B2;box-shadow:0 2px 8px rgba(0,42,28,.08)}
.gdo .row:focus-visible{outline:2px solid #046B45;outline-offset:2px}
.gdo .row.sel{box-shadow:0 0 0 3px #2CDB87,0 6px 18px rgba(0,42,28,.18)}
.gdo .row.done{opacity:.66;background:#FAFBFA;box-shadow:inset 4px 0 0 #C3CCC7}
.gdo .row.warn{background:#FEF9EF;border-color:#E3C88A}
.gdo .row.crit{background:#FDF1EE;border-color:#E9B6AC;box-shadow:inset 3px 0 0 #A83120}
/* CANCELLED — unmissable: red left rail + red-tinted bg, NOT dimmed. */
.gdo .row.cx{background:#FBE4E0;border-color:#E9A79F;box-shadow:inset 4px 0 0 #A83120}.gdo .row.cx .nm{text-decoration:line-through;text-decoration-color:#C98B83}
.gdo .hdr{display:grid;grid-template-columns:118px minmax(0,1fr) auto auto 18px;gap:12px;align-items:center}
.gdo .hdr>*{min-width:0}
.gdo .when b{font-size:15.5px;font-weight:700;letter-spacing:-.2px;font-variant-numeric:tabular-nums}
.gdo .when .tz{font-size:10px;font-weight:800;letter-spacing:.07em;color:#5C6B62;margin:0 4px}
.gdo .when .cd{font-size:12px;color:#5C6B62;font-variant-numeric:tabular-nums;display:block}
.gdo .when .cd.soon{color:#A83120;font-weight:700}.gdo .when .cd.live{color:#046B45;font-weight:700}
.gdo .ttl .nm{font-weight:700;font-size:16px;letter-spacing:-.15px}
.gdo .cxb{font-size:10px;font-weight:800;letter-spacing:.06em;background:#A83120;color:#fff;border:1px solid #A83120;border-radius:5px;padding:2px 7px;margin-left:7px}
.gdo .minlab .tag.cxtag{background:#A83120;color:#fff;border:1px solid #A83120}
.gdo .price{font-size:15px;font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap}
.gdo .veob{display:inline-flex;align-items:center;justify-content:center;border-radius:6px;padding:6px 10px;font-size:10.5px;font-weight:800;letter-spacing:.06em;border:1px solid #C3CDC7;background:#fff;color:#41514A;cursor:pointer;min-height:32px}
.gdo .veob.on{background:#F2E31D;border-color:#F2E31D;color:#231F00}
.gdo .veob:focus-visible{outline:2px solid #046B45;outline-offset:1px}
.gdo .go{color:#5C6B62;text-align:right;font-size:15px}
.gdo .meta{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin-top:9px;padding-top:9px;border-top:1px solid #E9EFEB}
.gdo .meta>span{min-width:0}
.gdo .meta .k{display:block;font-size:10px;letter-spacing:.09em;font-weight:700;color:#5C6B62;margin-bottom:3px}
.gdo .meta .v{display:block;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gdo .meta .v.none{color:#A83120;font-weight:700}
.gdo .stats{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,.85fr) minmax(0,1.3fr);gap:14px;align-items:start;margin-top:9px;padding-top:9px;border-top:1px solid #E9EFEB}
.gdo .st .k{display:flex;align-items:center;font-size:10px;letter-spacing:.09em;font-weight:700;color:#5C6B62;margin-bottom:6px}
.gdo .rosterlink{margin-left:auto;display:inline-flex;align-items:center;cursor:pointer;border:1px solid #DCE5E0;background:#fff;border-radius:6px;padding:4px 8px;font-size:10px;font-weight:800;letter-spacing:.06em;color:#046B45;text-transform:none;min-height:26px}
.gdo .rosterlink:hover{background:#EAF9F1;border-color:#A9E3C6}.gdo .rosterlink:focus-visible{outline:2px solid #046B45;outline-offset:1px}
.gdo .barwrap{display:block;position:relative;margin:16px 0 5px}
.gdo .bar{position:relative;display:flex;height:11px;border-radius:5px;overflow:hidden;background:#E4EAE7}
.gdo .bar i{display:block;height:100%}.gdo .bar .r{background:#046B45;transition:width .2s}.gdo .bar .f{background:#F2E31D}
.gdo .bar.cleared .r{background:linear-gradient(90deg,#046B45 0%,#0E7A50 70%,#17945F 100%)}
.gdo .bar .gap{position:absolute;top:0;bottom:0;background:repeating-linear-gradient(-45deg,rgba(168,49,32,.34) 0 3px,rgba(168,49,32,.12) 3px 6px)}
.gdo .barwrap .min{position:absolute;top:-3px;height:17px;width:2px;background:#0B1F17;border-radius:1px;z-index:2}
.gdo .barwrap .min::after{content:attr(data-n);position:absolute;left:50%;transform:translateX(-50%);bottom:calc(100% + 3px);background:#0B1F17;color:#fff;font-size:9.5px;font-weight:800;line-height:1;padding:3px 5px;border-radius:4px;white-space:nowrap}
.gdo .barwrap .min.hit{background:#046B45;box-shadow:0 0 0 3px rgba(44,219,135,.28)}
.gdo .barwrap .min.hit::after{content:"✓ " attr(data-n);background:#046B45}
.gdo .nums{font-size:12.5px;color:#5C6B62;font-variant-numeric:tabular-nums}.gdo .nums b{color:#0B1F17}.gdo .nums .fk{color:#7A5200;font-weight:700}.gdo .nums .ofcap{color:#5C6B62}
.gdo .minlab{display:block;margin-top:4px;font-size:11px;color:#5C6B62}
.gdo .minlab .tag{display:inline-flex;align-items:center;gap:4px;border-radius:20px;padding:2px 9px;font-size:10.5px;font-weight:800;letter-spacing:.05em}
.gdo .minlab .tag.made{background:#E4F8EE;color:#046B45;border:1px solid #A9E3C6}
.gdo .minlab .tag.togo{background:#FDEEEB;color:#A83120;border:1px solid #E9B6AC}
.gdo .minlab .nn{margin-left:7px}.gdo .minlab .nn b{color:#0B1F17}
.gdo .rungs{display:flex;gap:7px}
/* .rung / .rung.next / .rung.dash WERE HERE. Dead since the row rebuild — nothing carried the
   class, and the word is off the screen now anyway. */
.gdo .nx{display:block;font-size:11.5px;color:#1B4F9C;margin-top:5px;font-variant-numeric:tabular-nums}.gdo .nx.none{color:#5C6B62}
/* DECIDE BY on the card (21b item 3): absolute clock leads, then "N left"/"passed". */
.gdo .ac .clk{display:block;font-size:14px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.1px}
.gdo .ac .clk em{font-style:normal;font-size:10px;font-weight:800;color:#5C6B62;letter-spacing:.06em;margin-left:3px}
.gdo .ac .line{display:block;font-size:12.5px;font-variant-numeric:tabular-nums;margin-top:1px}.gdo .ac .line b{font-weight:700}.gdo .ac .line.dash{color:#5C6B62}
.gdo .ac .line .lead{color:#5C6B62;font-weight:400}
.gdo .ac .cnt{display:block;font-size:12px;color:#5C6B62;font-variant-numeric:tabular-nums;margin-top:2px}
.gdo .ac.ok .cnt{color:#046B45;font-weight:600}
.gdo .ac.ok .line b{color:#5C6B62;font-weight:600}
.gdo .ac.warn .line b,.gdo .ac.warn .cnt{color:#7A5200}
.gdo .ac.crit .line b,.gdo .ac.crit .cnt{color:#A83120}
.gdo .row.warn .k,.gdo .row.crit .k{color:#5A6560}
.gdo .flags{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.gdo .fl{font-size:11px;font-weight:700;letter-spacing:.04em;border-radius:5px;padding:2px 8px}
.gdo .fl.bad{background:#FDEEEB;color:#A83120;border:1px solid #E9B6AC}
.gdo .fl.warn{background:#FBF0DC;color:#7A5200;border:1px solid #E3C88A}
.gdo .fl.info{background:#F2F7FE;color:#1B4F9C;border:1px solid #C9DBF3}
.gdo .empty{padding:22px;text-align:center;color:#5C6B62;font-size:14px;border:1px dashed #DCE5E0;border-radius:12px;background:#fff}
.gdo .empty.err{color:#A83120;border-color:#E9B6AC;background:#FDEEEB}
.gdo .toast{position:fixed;left:50%;top:16px;transform:translateX(-50%);background:#003326;color:#fff;padding:10px 19px;border-radius:10px;font-size:14px;z-index:90;box-shadow:0 6px 20px rgba(0,32,21,.28)}
.gdo .toast.bad{background:#A83120}

/* ── header: refresh + freshness ──────────────────────────────────────────────
   The old "now HH:MM" span sat in .r1 and collided with the absolutely-positioned
   PRODUCTION — LIVE EDITS pill, which covered half of it at 1600. The block now sits at the row
   end with right padding reserved for the pill, so the two can never share pixels. */
.gdo .head .r1{position:relative;padding-right:220px}
.gdo .fresh{margin-left:auto;display:inline-flex;align-items:center;gap:8px}
.gdo .refresh{display:inline-flex;align-items:center;gap:6px;min-height:32px;border:1px solid #D8E2DC;
  border-radius:9px;background:#fff;color:#20402F;font:inherit;font-size:12px;font-weight:700;padding:0 10px;
  cursor:pointer}
.gdo .refresh:disabled{opacity:.6;cursor:default}
/* the spinner replaces the glyph IN PLACE — a fixed 12px box, so nothing shifts while it spins */
@keyframes gdspin{to{transform:rotate(360deg)}}
.gdo .stamp{font-size:12px;color:#3D5349;white-space:nowrap}
.gdo .stamp.stale{color:#7C8A83}
.gdo .stamp.failed{color:#A8391A;font-weight:600}
@media(prefers-reduced-motion:reduce){.gdo .rspin.on{animation:none}}

/* ── Snapshot view: one line per match, whole day on one screen ── */
.gdo .seg{display:inline-flex;background:#E4EAE7;border-radius:10px;padding:3px;gap:3px;margin-left:auto}
.gdo .seg button{border:0;background:transparent;border-radius:8px;padding:7px 15px;min-height:34px;font-size:13px;font-weight:700;color:#5C6B62;cursor:pointer;white-space:nowrap}
.gdo .seg button.on{background:#fff;color:#0B1F17;box-shadow:0 1px 2px rgba(0,0,0,.10)}
.gdo .legend{display:flex;gap:16px;flex-wrap:wrap;align-items:center;margin:0 2px 10px;color:#5C6B62;font-size:12px}
.gdo .legend .lg{display:inline-flex;align-items:center;gap:6px}
.gdo .legend .sw{width:11px;height:11px;border-radius:3px;display:inline-block;flex:0 0 11px}
.gdo .legend .sw.red{background:#A83120}.gdo .legend .sw.amb{background:#B8860B}.gdo .legend .sw.grn{background:#046B45}
/* the decide-by mechanism, stated ONCE (§7e) instead of on every row */
.gdo .legend .legnote{flex-basis:100%;margin-top:2px;color:#3D5349;font-size:11.5px}
.gdo .chip.sm{padding:5px 11px;font-size:12px;min-height:30px}.gdo .chip.sm.on{background:#003326;border-color:#003326;color:#fff}
.gdo .sheet{background:#fff;border:1px solid #DCE5E0;border-radius:14px;overflow:hidden}
.gdo .colhead,.gdo .sheet .r{display:grid;align-items:center;gap:12px;grid-template-columns:5px 108px minmax(150px,1fr) minmax(232px,1.6fr) 94px 122px 78px 56px}
.gdo .colhead{padding:9px 14px 9px 0;border-bottom:1px solid #DCE5E0;background:#FAFCFB;font-size:10px;font-weight:800;letter-spacing:.11em;color:#536258}
.gdo .colhead .ra{text-align:right}
/* Rows grow to ~76px to carry the marker + printed minimum under the bar (§2). A firm
   min-height keeps EVERY row (todo, in-play, cancelled, finished, special-event) the same
   height within a pixel — the marker content fits inside it, so nothing overflows past ~76px. */
.gdo .sheet .r{padding:0 14px 0 0;border:0;border-bottom:1px solid #DCE5E0;background:#fff;width:100%;text-align:left;font:inherit;color:inherit;cursor:pointer;min-height:76px}
.gdo .sheet .r:last-child{border-bottom:0}.gdo .sheet .r:hover{background:#F7FBF9}
.gdo .sheet .r:focus-visible{outline:2px solid #046B45;outline-offset:-2px}
.gdo .sheet .r.sel{background:#EAF9F1}
.gdo .sheet .rail{align-self:stretch;display:block;background:#CCD7D1}
/* Three distinct rail colours (§6): green over-min, amber at-line/short-far, red short-and-
   imminent. The at-min tier joins amber (snapRail), so exactly-on-the-line never reads green. */
.gdo .sheet .r.tier-red .rail{background:#A83120}.gdo .sheet .r.tier-amber .rail{background:#B8860B}.gdo .sheet .r.tier-green .rail{background:#046B45}
.gdo .sheet .r.tier-red{background:#FDEEEB}.gdo .sheet .r.tier-red:hover{background:#FBE2DF}
/* snapshot CANCELLED — red rail + red bg, struck name; FINISHED — grey rail, muted. */
.gdo .sheet .r.cxrow .rail{background:#A83120}.gdo .sheet .r.cxrow{background:#FBE4E0}.gdo .sheet .r.cxrow:hover{background:#F7D6D0}.gdo .sheet .r.cxrow .m1{text-decoration:line-through;text-decoration-color:#C98B83}
.gdo .sheet .r.donerow .rail{background:#C3CCC7}.gdo .sheet .r.donerow{opacity:.66}
.gdo .sheet .c1.dash{color:#536258;font-weight:600}
.gdo .grouphd{margin:0 0 9px 3px;font-size:12px;letter-spacing:.11em;color:#55635B;font-weight:700;display:flex;align-items:center;gap:8px}
.gdo .grouphd .n{color:#4E5A54;letter-spacing:0;font-weight:600;font-size:12.5px}
.gdo .sheet .grp{margin-top:18px}.gdo .sheet .grp:first-of-type{margin-top:8px}
.gdo .sheet .cell{display:block;padding:9px 0;min-width:0}
.gdo .sheet .t1{display:block;font-weight:700;font-variant-numeric:tabular-nums}.gdo .sheet .t1 em{font-style:normal;font-size:10px;font-weight:800;color:#536258;letter-spacing:.06em;margin-left:4px}
.gdo .sheet .t2{display:block;font-size:12px;color:#536258;font-variant-numeric:tabular-nums}
.gdo .sheet .m1{display:block;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gdo .sheet .m2{display:block;font-size:12px;color:#536258;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gdo .sheet .flag{display:inline-block;margin-left:6px;vertical-align:1px;background:#FBF0DC;color:#7A5200;border:1px solid #E3C88A;font-size:9.5px;font-weight:800;letter-spacing:.05em;padding:1px 5px;border-radius:4px;white-space:nowrap}
/* ── the bar + the minimum MARKER + the printed minimum (§2/§3/§4) ──
   Bar in normal flow; the marker (centred on it) and the "min N" label (hanging just below)
   are its children, and the counts sit under the bar with a fixed gap. overflow:visible so the
   17px marker isn't clipped by the 10px bar. */
.gdo .sheet .barwrap{display:block;position:relative;padding:2px 0 0}
.gdo .sheet .bar{display:block;position:relative;height:10px;border-radius:6px;background:#E7EEEA;overflow:visible}
.gdo .sheet .seg1,.gdo .sheet .seg2{position:absolute;top:0;bottom:0;display:block;border-radius:6px}
.gdo .sheet .seg1{left:0;background:#046B45;z-index:2}
.gdo .sheet .seg2{background:repeating-linear-gradient(135deg,#E5A83A 0 4px,#F3CD8E 4px 8px);z-index:1}
/* the ~17px marker, centred on the minimum. GLYPH + FILL both change with state, never colour
   alone (§3): solid green ✓ over-min; hollow white/amber ✓ AT the line; solid amber ! below.
   Driven only by (real − min) — the hatch may run past it and must not change it (§4). */
.gdo .sheet .marker{position:absolute;top:50%;transform:translate(-50%,-50%);z-index:4;width:17px;height:17px;border-radius:5px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:900;line-height:1;border:1.5px solid;box-sizing:border-box}
.gdo .sheet .marker.over{background:#046B45;border-color:#0E5433;color:#fff}
.gdo .sheet .marker.atmin{background:#fff;border-color:#8a5600;color:#8a5600}
.gdo .sheet .marker.short{background:#8a5600;border-color:#6D4400;color:#fff;font-size:12px}
/* the printed minimum, hanging under the marker, clamped to stay inside the bar (§2/§11).
   #4a6157, not the standard muted grey (4.44:1 was just under 4.5 on the row bg). */
.gdo .sheet .minlab{position:absolute;top:100%;margin-top:4px;transform:translateX(-50%);z-index:3;font-size:10px;font-weight:700;color:#4a6157;white-space:nowrap;font-variant-numeric:tabular-nums;letter-spacing:.02em}
/* ── counts line: four numbers, no "open", nothing to subtract (§1). zero fakes render muted. ── */
.gdo .sheet .spotln{display:block;margin-top:20px;font-size:12px;color:#3D5349;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gdo .sheet .spotln b{color:#0B1F17;font-weight:800}
.gdo .sheet .spotln .fk b{color:#7A5200}.gdo .sheet .spotln .fk.z b{color:#4a6157;font-weight:700}
.gdo .sheet .spotln .ofcap{color:#4a6157;font-weight:600;margin-left:3px}
/* ── vs MIN chip (§5): a PROMINENT signed number + one small word, ALL chips the same height. ── */
.gdo .sheet .c-short{display:flex;align-items:center}
.gdo .sheet .vsmin{display:inline-flex;align-items:baseline;gap:5px;height:24px;padding:0 9px;border-radius:8px;font-variant-numeric:tabular-nums;white-space:nowrap;box-sizing:border-box;border:1px solid}
.gdo .sheet .vsmin b{font-size:13px;font-weight:800;line-height:24px}
.gdo .sheet .vsmin .w{font-size:10px;font-weight:700;letter-spacing:.03em}
.gdo .sheet .vsmin.over{background:#E6F4EC;color:#046B45;border-color:#9FD3B6}
.gdo .sheet .vsmin.atmin{background:#FBF0DC;color:#7A5200;border-color:#E3C88A}
.gdo .sheet .vsmin.short{background:#FDEEEB;color:#A83120;border-color:#F0A9A4}
.gdo .sheet .vsmin.none{border-color:transparent;background:transparent;color:#536258;padding:0}
.gdo .sheet .vsmin.cxbadge{border-color:#A83120;background:#A83120;color:#fff;padding:0 9px;font-weight:800;letter-spacing:.05em;align-items:center}
/* ── CANCEL TIME (cancel-time-v1) ───────────────────────────────────────────
   A DURATION, then what it is a countdown to. 15px against kickoff's inherited
   16px: strictly smaller, so the two stop reading as the same kind of fact. The
   clock is in the cell's title attribute, not in the cell. */
.gdo .sheet .cxbig{display:block;font-size:15px;font-weight:800;color:#8A5A00;font-variant-numeric:tabular-nums;line-height:1.05}
.gdo .sheet .cxcap{display:block;font-size:11.5px;color:#536258;margin-top:1px;line-height:1.3}
.gdo .sheet .cxcap b{color:#8A5A00;font-weight:700}
/* mobile-only members of the status stack */
.gdo .sheet .mcnt,.gdo .sheet .mnoac{display:none}
/* .c2 still styles the "no auto-cancel" caption, the one remaining user of this cell's sub
   line. The shortfall-tinted variants (.cleared/.atmin/.short/.short.hot) and .c1.clk went with
   the clock they coloured — prominence now comes from the countdown's own weight, not from
   re-stating the shortfall a third time in the same row. */
.gdo .sheet .c2{display:block;font-size:11.5px;margin-top:1px;color:#536258;line-height:1.35}
.gdo .sheet .mgr{display:block;font-size:13px;color:#3D5349;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gdo .sheet .price{display:block;text-align:right;font-weight:700;font-variant-numeric:tabular-nums}
.gdo .sheet .cxlmob{display:none}
/* cancelled time slot reads "was due" (red), never blank — both views. */
.gdo .sheet .r.cxrow .t2{color:#A83120;font-weight:700}

/* ── PHONE header + prod strip: built here, hidden on desktop (the .head card and
      the legend own the ≥760px layout). Kept out of the media block so the desktop
      default is unambiguously "not shown". ── */
.gdo .mfresh{margin-left:auto;display:inline-flex;align-items:center;gap:7px}
.gdo .mstamp{font-size:11.5px;color:#41514A;font-variant-numeric:tabular-nums;white-space:nowrap}
.gdo .mstamp.stale{color:#5C6B62}  /* muted vs #41514A, but still >=4.5:1 on the bar */
.gdo .mstamp.failed{color:#A8391A;font-weight:700}
.gdo .mrefresh{width:44px;height:44px;flex:none;display:inline-flex;align-items:center;justify-content:center;
  border:1px solid #D3DED8;border-radius:11px;background:#EEF3F0;color:#20402F;cursor:pointer}
.gdo .ricon{display:block;transform-origin:50% 50%}
.gdo .ricon.on{animation:gdspin .8s linear infinite}
.gdo .mrefresh:disabled{opacity:.6;cursor:default}
.gdo .prodstrip,.gdo .mhead{display:none}

/* ── Phone: this is used one-handed at a field. Edge to edge, cities scroll. ── */
@media (max-width: 759px){
  /* desktop chrome off; phone chrome on */
  .gdo .head{display:none}
  .gdo .legend{display:none}                      /* sort moved into the header band */
  .gdo .prodstrip{display:block;position:sticky;top:0;z-index:40;height:3px}
  .gdo .prodstrip.live{background:#C0201B}.gdo .prodstrip.stg{background:#F2E31D}
  /* Break out of the app shell's horizontal padding (max-w px-8) so the board is
     truly edge to edge — full viewport width regardless of the parent's inset. */
  .gdo{width:100vw;margin-left:calc(50% - 50vw);margin-right:calc(50% - 50vw)}
  .gdo .gmain{padding:0 0 90px;margin-right:0 !important}
  .gdo .gmain.drawering{margin-right:0}
  .gdo .gpanel{width:100vw;right:0 !important}

  /* three 44px bands under the strip */
  .gdo .mhead{display:block;position:sticky;top:3px;z-index:30;background:#F6F9F7;border-bottom:1px solid #D3DED8}
  .gdo .mband{display:flex;align-items:center;gap:10px;padding:0 12px;min-height:44px}
  .gdo .mband + .mband{border-top:1px solid #E9EFEB}
  .gdo .mpick{display:inline-flex;align-items:center;gap:6px;background:none;border:0;padding:4px 2px;color:#0B1F17;cursor:pointer;min-height:36px;font-size:17px;font-weight:700;letter-spacing:-.02em}
  .gdo .mpick .livedot{width:7px;height:7px;border-radius:50%;background:#C0201B;flex:0 0 auto}
  .gdo .mpick .caret{font-size:11px;color:#5C7168}
  .gdo .mseg{margin-left:auto;flex:0 0 auto}
  .gdo .mseg button{padding:0 11px;min-height:32px;font-size:12.5px}
  .gdo .mdaynav{display:flex;align-items:center;gap:4px;min-width:0}
  .gdo .marw{width:32px;height:32px;border:1px solid #D3DED8;background:#fff;border-radius:8px;color:#3D5349;font-size:15px;line-height:1;flex:0 0 auto}
  .gdo .marw:active{background:#EEF4F1}
  .gdo .mdaylab{display:flex;align-items:baseline;gap:6px;font-weight:700;font-size:14px;padding:0 4px;white-space:nowrap}
  .gdo .mdaylab i{font-style:normal;font-size:9.5px;font-weight:800;letter-spacing:.1em;color:#046B45}
  .gdo .mtoday{margin-left:auto;flex:0 0 auto;min-height:34px;padding:0 14px;font-size:12.5px}
  .gdo .mtoday:disabled{opacity:.45}
  .gdo .mchips{display:flex;align-items:center;gap:7px;overflow-x:auto;padding:6px 12px;min-height:44px;scrollbar-width:none;-webkit-overflow-scrolling:touch;background:#F6F9F7}
  .gdo .mchips::-webkit-scrollbar{display:none}
  .gdo .mchips .chip{flex:0 0 auto;min-height:32px;padding:0 12px;display:inline-flex;align-items:center;font-size:12.5px}
  .gdo .mchips .msep{flex:0 0 auto;width:1px;align-self:stretch;background:#D3DED8;margin:6px 3px}

  /* the day's list, edge to edge — no cards, no side margins, no radius */
  .gdo .sheet{border:0;border-radius:0;background:transparent}
  .gdo .sheet{overflow:visible}
  /* group subheads: full-bleed, sticky UNDER the header */
  .gdo .sheet .grp,.gdo .sheet .grp:first-of-type,.gdo .band{margin:0}
  .gdo .grouphd{position:sticky;top:var(--gd-hdrh,135px);z-index:20;margin:0;display:flex;align-items:baseline;gap:8px;
    padding:6px 12px;background:#EEF3F0;border-top:1px solid #D3DED8;border-bottom:1px solid #D3DED8;
    font-size:10.5px;letter-spacing:.12em;color:#3D5349}
  .gdo .grouphd .n{margin-left:auto;color:#5C7168;letter-spacing:.04em}
  .gdo .rows{gap:0}
  .gdo .row{border-radius:0;border-left:0;border-right:0;border-top:0;border-bottom:1px solid #DCE5E0;padding:12px 12px 11px}
  .gdo .hdr{grid-template-columns:1fr auto auto 14px;grid-template-areas:"when price veo go" "ttl ttl ttl ttl";gap:8px 10px}
  .gdo .when{grid-area:when;display:flex;align-items:baseline;gap:7px;flex-wrap:wrap}.gdo .when .cd{display:inline}
  .gdo .ttl{grid-area:ttl}.gdo .ttl .nm{white-space:normal}
  .gdo .price{grid-area:price}.gdo .veocell{grid-area:veo}.gdo .go{grid-area:go}
  .gdo .veob{padding:9px 13px;font-size:11px}
  .gdo .meta{grid-template-columns:1fr 1fr;gap:10px 14px}
  .gdo .stats{grid-template-columns:1fr;gap:12px}
  .gdo .st{border-top:1px solid #E9EFEB;padding-top:10px}.gdo .st.fill{border-top:0;padding-top:0}
  .gdo .rosterlink{min-height:32px;padding:6px 10px}
  .gdo .bar{height:14px}
  .gdo .toast{left:12px;right:12px;transform:none;text-align:center}
  /* ── SNAPSHOT rows: four-line stack, full-bleed, names WRAP (never truncated). ── */
  .gdo .colhead{display:none}
  .gdo .sheet .r{grid-template-columns:5px 1fr auto;grid-template-areas:"rail time short" "rail match short" "rail spots spots" "rail cxl cxl";gap:0 11px;padding:0 12px 0 0;min-height:0}
  .gdo .sheet .rail{grid-area:rail}
  .gdo .sheet .c-time{grid-area:time;padding:8px 0 0}
  .gdo .sheet .c-match{grid-area:match;padding:0}
  .gdo .sheet .c-spots{grid-area:spots;padding:7px 0 0}
  /* THE STATUS STACK — the shortfall pill and its deadline, top right, where the eye
     already goes. Column so the countdown sits directly under the pill. */
  .gdo .sheet .c-short{grid-area:short;padding:8px 0 0;align-self:start;display:flex;flex-direction:column;align-items:flex-end;gap:5px}
  .gdo .sheet .mcnt{display:block;font-size:13px;font-weight:800;color:#8A5A00;white-space:nowrap;font-variant-numeric:tabular-nums}
  /* The mockup mutes "cancels in" with a lighter amber (#A8813A). Measured on the real card
     backgrounds that is 3.17–3.58:1 — below 4.5. WEIGHT carries the hierarchy instead, at the
     same accessible amber as the duration. */
  .gdo .sheet .mcnt .w{font-weight:600;color:#8A5A00}
  .gdo .sheet .mnoac{display:block;font-size:12px;font-weight:700;color:#5C6B62;white-space:nowrap}
  .gdo .sheet .c-cxl{grid-area:cxl;padding:4px 0 9px}
  .gdo .sheet .c-mgr,.gdo .sheet .c-price{display:none}
  /* The desktop cell's contents are ALL hidden on the phone — the duration and its caption
     included. Missing them here put "cancels in 7m" in the stack AND "7m until auto-cancel" in
     the cell: two countdowns on one card, which is the bug in a new costume. */
  .gdo .sheet .c-cxl .c1,.gdo .sheet .c-cxl .c2,.gdo .sheet .c-cxl .cxbig,.gdo .sheet .c-cxl .cxcap{display:none}
  .gdo .sheet .cxlmob{display:block;font-size:12px;color:#536258;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .gdo .sheet .m1{white-space:normal;overflow:visible;text-overflow:clip}   /* match name never truncates */
  .gdo .sheet .t1{display:inline}.gdo .sheet .t2{display:inline;margin-left:8px}
}

/* ══ THE REBUILT GAMEDAY SURFACE ═══════════════════════════════════════════════════════════════
   NO BACKTICK MAY APPEAR ANYWHERE BELOW. This whole block is a template literal, so one backtick
   inside a comment ends the stylesheet and the rest becomes JavaScript. It has cost a broken build
   before; the guard in gameday-strip-test.ts now scans for it. */

/* ── the stat strip ── */
.gdo .gstrip{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-bottom:12px}
.gdo .gtile{background:#fff;border:1px solid #DCE5E0;border-radius:11px;padding:11px 13px;
  text-align:left;display:block;position:relative;font:inherit;color:inherit;width:100%}
.gdo button.gtile{cursor:pointer}
.gdo button.gtile:hover{border-color:#c9d3cc}
.gdo .gtile.on{border-color:#046B45;box-shadow:0 0 0 1px #046B45 inset}
.gdo .gtile .k{font-size:10.5px;letter-spacing:.7px;text-transform:uppercase;color:#66786E;font-weight:600}
.gdo .gtile .v{font-size:25px;font-weight:700;letter-spacing:-.8px;margin-top:3px;line-height:1;
  font-variant-numeric:tabular-nums}
.gdo .gtile .s{font-size:11px;color:#66786E;margin-top:3px}
/* RED ONLY WHEN NON-ZERO. A tile that is permanently red reading 0 trains the eye to skip it. */
.gdo .gtile.warn{background:#FDF3F2;border-color:#f2d3d0}
.gdo .gtile.warn .v,.gdo .gtile.warn .k{color:#A83120}
.gdo .gtile.warn.zero{background:#fff;border-color:#DCE5E0}
.gdo .gtile.warn.zero .v{color:inherit}
.gdo .gtile.warn.zero .k{color:#66786E}

/* ── the alert banner ── */
.gdo .galert{border:1px solid #f0cfcb;background:linear-gradient(180deg,#fef4f3,#fff);border-radius:12px;
  padding:14px 16px;margin-bottom:12px;display:flex;align-items:center;gap:18px;cursor:pointer;
  text-align:left;width:100%}
.gdo .galert:hover{background:linear-gradient(180deg,#fdecea,#fff)}
.gdo .gbang{width:30px;height:30px;flex:0 0 30px;border-radius:99px;background:#C0392B;color:#fff;
  display:flex;align-items:center;justify-content:center;font-weight:800;font-size:16px}
.gdo .gtxt{min-width:0;flex:1 1 auto}
.gdo .gt1{font-weight:700;font-size:14.5px;color:#A83120;letter-spacing:-.15px}
.gdo .gmeta{font-size:11.5px;color:#66786E;margin-top:3px}
/* THREE DISCRETE STATS, not a sentence. The hairlines are what make them read as three. */
.gdo .gfacts{display:flex;align-items:center;gap:13px;margin-top:8px;flex-wrap:wrap}
.gdo .gf{display:flex;align-items:baseline;gap:4px;font-size:11.5px;color:#66786E;white-space:nowrap}
.gdo .gf b{font-size:15px;font-weight:700;color:#1B3227;letter-spacing:-.3px;font-variant-numeric:tabular-nums}
.gdo .gf.bad b{color:#A83120}
.gdo .gf.moved b{color:#046B45}
.gdo .gf em{font-style:normal;font-size:10.5px;color:#66786E;text-decoration:line-through}
.gdo .gfacts>i{width:1px;height:15px;background:#efd2cf;display:block;flex:0 0 1px}
.gdo .gclock{text-align:right;flex:0 0 auto;cursor:default}
.gdo .gclock .n{font-size:22px;font-weight:700;letter-spacing:-.6px;color:#A83120;font-variant-numeric:tabular-nums}
.gdo .gclock .l{font-size:9.5px;letter-spacing:.8px;text-transform:uppercase;color:#66786E;font-weight:600}
.gdo .gacts{display:flex;align-items:center;gap:8px;flex:0 0 auto;flex-wrap:wrap;cursor:default}
.gdo .gbtn{border:1px solid #DCE5E0;background:#fff;border-radius:8px;padding:6px 11px;font-size:12.5px;
  font-weight:600;color:#20372C;text-decoration:none;white-space:nowrap}
.gdo .gbtn:hover{background:#F2F7F4}
.gdo .gstep{display:flex;align-items:center;gap:2px;border:1px solid #DCE5E0;background:#fff;
  border-radius:8px;padding:3px 4px 3px 11px;font-size:12.5px;color:#20372C;white-space:nowrap}
.gdo .gstep b{min-width:20px;text-align:center;font-size:13.5px;font-weight:700;color:#1B3227;
  font-variant-numeric:tabular-nums}
.gdo .gsb{border:0;background:#f1f4f2;border-radius:6px;width:22px;height:22px;line-height:1;font-size:14px;
  font-weight:700;color:#20372C;display:flex;align-items:center;justify-content:center;padding:0;cursor:pointer}
.gdo .gsb:hover:not(:disabled){background:#e2e8e4}
.gdo .gsb:disabled{opacity:.35;cursor:not-allowed}
.gdo .gpri{border:1px solid #DCE5E0;background:#fff;color:#20372C;border-radius:8px;padding:6px 12px;
  font-size:12.5px;font-weight:700;white-space:nowrap;cursor:pointer}
/* GREEN ONLY WHEN THE SHORTFALL ACTUALLY REACHES ZERO. An adjustment that still leaves the match
   short does not rescue it, and must not look like it does. */
.gdo .gpri.ok{background:#046B45;border-color:#046B45;color:#fff}
.gdo .gpri:disabled{opacity:.45;cursor:not-allowed}
.gdo .gverdict{font-size:11.5px;font-weight:700;border-radius:7px;padding:4px 9px;white-space:nowrap}
.gdo .gverdict.landed{background:#DCF6E8;color:#046B45}
.gdo .gverdict.failed{background:#FBD9D6;color:#A83120}
.gdo .gverdict.unknown{background:#FFF6E3;color:#8A5A08}

/* ── compact city chips ── */
.gdo .gcities .gchip{padding:4px 11px;font-size:12px;min-height:0;border-radius:99px;
  display:inline-flex;align-items:center;gap:6px;line-height:1.3}
.gdo .gchip u{text-decoration:none;color:#66786E;font-size:11px;font-variant-numeric:tabular-nums}
.gdo .gchip.on u{color:#8fd3ab}
.gdo .gchip.risk{border-color:#f0cfcb;background:#FDF3F2;color:#A83120}
.gdo .gchip.risk u{color:#A83120}
.gdo .gchip.on.risk{background:#A83120;border-color:#A83120;color:#fff}
.gdo .gchip.on.risk u{color:#ffd9d6}

/* ── the card, its sections and its rows ── */
/* THE CARD IS A SIZE CONTAINER, and the row grid keys off IT rather than the viewport.
   The tracks are chosen by how much room the TABLE has, and the table is not the window: with the
   match panel open at a 1500px viewport the card is 558px, the four fixed tracks need 612, and
   minmax(0,1fr) did exactly what it is asked to and collapsed the match column to ZERO WIDTH.
   The name and the price then rendered outside a zero-wide track. A viewport media query cannot
   see that, which is why it shipped: every panel-closed width was fine.

   The banner already uses this pattern for the same reason (gbanner, below). */
.gdo .gcard{background:#fff;border:1px solid #DCE5E0;border-radius:14px;overflow:hidden;
  container-type:inline-size;container-name:gtable}
/* ── B. EACH ROW IS A BAND, NOT A SLAB OF TINT TO BOTH EDGES ─────────────────────────────────
 * Two adjacent at-risk matches read as one block — Scissortail and Onion Creek do exactly that on
 * a live board. A band with its own border and its own ground cannot merge with the one below it.
 *
 * THE COLUMNS DO NOT MOVE, which is the constraint this lives or dies on. The header's horizontal
 * padding is therefore DERIVED from the band's geometry rather than guessed: list padding 8 +
 * band border 1 + band padding 14 = 23px, so a band's first column starts exactly where the header
 * says it does.
 *
 * MANAGER 128 -> 164 and the avatar 21 -> 23. ONE MOVEMENT, STATED TWICE, NOT TWO TO BE SUMMED:
 * the spec says "manager goes to 164px" and, separately, "give the kebab's 34px to the manager
 * column" - and 128 + 34 = 162, while the name's own requirement is 130px for "Peter
 * Rocha-Ramirez" + a 23px avatar + the 7px gap = 160. Both roads arrive at ~164, so 164 IS the
 * reallocated kebab column; adding another 34 on top would be double-counting it and would take
 * the width off the flexible match column for nothing. "RM" also overflowed a 21px circle. */
.gdo .gcolhead,.gdo .grow{display:grid;grid-template-columns:96px minmax(0,1fr) 310px 164px;gap:14px;align-items:center}
.gdo .gcolhead{padding:9px 23px;font-size:10px;letter-spacing:.9px;text-transform:uppercase;
  color:#8C9E93;font-weight:700;background:#F7FAF8;border-bottom:1px solid #DCE5E0}
.gdo .glist{padding:8px;display:flex;flex-direction:column;gap:6px}
.gdo .gsec{display:flex;align-items:center;gap:9px;width:100%;border:0;background:#f7f9f7;
  padding:7px 16px;border-top:1px solid #DCE5E0;text-align:left;cursor:pointer;font:inherit}
.gdo .gsec .tw{font-size:10.5px;letter-spacing:.9px;text-transform:uppercase;font-weight:700;color:#20372C}
.gdo .gsec .n{background:#e4eae6;color:#20372C;border-radius:99px;padding:1px 7px;font-size:10.5px;font-weight:700}
.gdo .gsec .car{margin-left:auto;color:#66786E;font-size:11px}
.gdo .gsec.live .tw{color:#046B45}
/* ROWS UNDER 62px. 9px padding + a 21px avatar + the meter's 8px bar and 13px label gutter. */
.gdo .grow{padding:10px 14px;border:1px solid #DCE5E0;border-radius:10px;background:#fff;cursor:pointer}
.gdo .grow:hover{background:#fafcfa;border-color:#c9d3cc}
/* THE RISK TINT AND ITS RED EDGE, CONTAINED. Same signal, inside the band's own rounded box. */
.gdo .grow.risk{background:#FDF3F2;border-color:#f0cfcb;box-shadow:inset 3px 0 0 #C0392B}
.gdo .grow.risk:hover{background:#fce5e3}
.gdo .grow.done{opacity:.62}
.gdo .grow.sel{background:#F2F7F4}
.gdo .gk{font-variant-numeric:tabular-nums}
.gdo .gk b{font-size:13.5px;font-weight:700;letter-spacing:-.2px}
.gdo .gk b i{font-style:normal;font-size:10px;color:#66786E;font-weight:600;margin-left:2px}
.gdo .gk span{display:block;font-size:11px;color:#66786E;margin-top:1px}
/* THE MATCH CELL IS A GRID so the CANCELS chip can sit beside the name on desktop and drop to the
   field line on a phone, as ONE element rather than two with one test id. */
.gdo .gm{min-width:0;display:grid;grid-template-columns:minmax(0,1fr) auto;
  grid-template-areas:"n chip" "sub sub";align-items:baseline;column-gap:6px}
.gdo .gm .n{grid-area:n}
.gdo .gm > .gtag{grid-area:chip;align-self:center}
.gdo .gm .sub{grid-area:sub}
.gdo .gm .n{font-weight:600;font-size:13.5px;display:flex;align-items:center;gap:6px;min-width:0}
.gdo .gm .n s{text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.gdo .gm .sub{font-size:11.5px;color:#66786E;margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gdo .gtag{flex:0 0 auto;font-size:9.5px;font-weight:800;letter-spacing:.4px;text-transform:uppercase;
  border-radius:5px;padding:2px 6px;background:#EEF1EF;color:#66786E;
  /* NOWRAP. The chip sits in an auto-sized grid track, and once the match column is tight enough
     that the track cannot take its max-content width, "CANCELS IN 19H 0M" broke across two lines
     and took the whole band from 64px to 73px. A chip is one token; it has no second line. */
  white-space:nowrap}
.gdo .gtag.hot{background:#FBD9D6;color:#A83120}
.gdo .gpz{flex:0 0 auto;font-size:11px;color:#66786E;font-variant-numeric:tabular-nums}
.gdo .gs{display:flex;align-items:center;gap:9px;min-width:0;overflow:hidden}
/* THE METER. 104px track, 8px bar, and a 13px gutter beneath it for the min label. */
/* THE SPACE BELOW THE BAR MUST FIT THE LABEL'S OWN BOX, not just its baseline.
 *
 * It was 13px against a label at top:12px that renders 14.25px tall — so the label ended 5.25px
 * past its container and .gs (overflow:hidden, added to stop the delta chip spilling into the
 * manager cell at 768px) sheared exactly that sliver off. One fix created the other.
 *
 * 28 = 12 top offset + 14.25 rendered height + a little. NOT FIXED BY REMOVING THE OVERFLOW: that
 * container clips for a reason, and trading a clipped label for a delta chip on top of the manager
 * name is a worse defect that the overlap walk would then have to catch again. */
.gdo .gmeter{position:relative;flex:0 0 104px;padding-bottom:28px}
.gdo .gbar{position:relative;height:8px;border-radius:99px;background:#e6eae7;overflow:hidden}
.gdo .gbar .r{position:absolute;left:0;top:0;bottom:0;background:#35c77f;border-radius:99px}
.gdo .gbar.short .r{background:#C0392B}
/* FAKE IS HATCHED and does not count toward the minimum. */
.gdo .gbar .f{position:absolute;top:0;bottom:0;background-color:#fbe9cb;
  background-image:repeating-linear-gradient(-45deg,#e8b96a 0 3px,transparent 3px 6px)}
/* THE NOTCH: 1px, square-ended, spanning exactly the bar height, with a 1px white edge each side so
   it stays legible over the solid fill, over the hatch and over the bare track alike. No overhang
   (which would read as a range) and no rounded cap (which would read as a draggable handle). */
.gdo .gbar .mn{position:absolute;top:0;bottom:0;width:1px;border-radius:0;background:#0b1d15;
  box-shadow:-1px 0 0 rgba(255,255,255,.9),1px 0 0 rgba(255,255,255,.9)}
/* THE LABEL sits directly beneath the notch. No connector stub: proximity does that work. */
.gdo .gmnl{position:absolute;top:12px;transform:translateX(-50%);white-space:nowrap;font-size:9.5px;
  font-weight:400;letter-spacing:.2px;color:#66786E;font-variant-numeric:tabular-nums}
.gdo .grow.risk .gmnl{color:#A83120}
/* LEFT-ALIGNED, NOT CENTRED. It describes the whole bar, not a point on it, so it starts where the
   track starts and carries no transform to pull it off the left edge. */
.gdo .gnomin{color:#9AA8A0;font-style:italic;left:0;transform:none}
.gdo .gnum{font-size:11.5px;color:#66786E;font-variant-numeric:tabular-nums;white-space:nowrap}
.gdo .gnum b{color:#1B3227;font-weight:600}
.gdo .gdelta{margin-left:auto;flex:0 0 auto;font-size:11px;font-weight:700;border-radius:6px;padding:2px 7px;
  font-variant-numeric:tabular-nums;background:#DCF6E8;color:#046B45}
.gdo .gdelta.bad{background:#FBD9D6;color:#A83120}
.gdo .gdelta.mut{background:#EEF1EF;color:#66786E}
/* THE MANAGER NAME IS NOT TRUNCATED. "Moncho P..." was the old 96px cell; this one is 128px and
   the name wins the space over the avatar. */
.gdo .gmg{display:flex;align-items:center;gap:7px;min-width:0}
.gdo .gmg span:last-child{font-size:12.5px;white-space:nowrap}
.gdo .gav{width:23px;height:23px;flex:0 0 23px;border-radius:99px;background:#dde5e0;color:#046B45;
  display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700}
/* THE KEBAB'S STYLING WAS HERE AND IS GONE, with its element and its column. Dead rules for a
   deleted control are how a removed affordance comes back by accident. */
.gdo .gmore{display:block;width:100%;border:1px dashed #E9B6AC;background:#FDF3F2;color:#A83120;
  border-radius:10px;padding:9px 14px;font:inherit;font-size:12.5px;font-weight:700;cursor:pointer;
  margin-bottom:12px;text-align:left}
.gdo .gmore:hover{background:#fce5e3}
.gdo .gfoot{margin:10px 2px 0;font-size:11.5px;color:#66786E;line-height:1.5}


/* ══ PHONE FIRST BELOW 640px ═══════════════════════════════════════════════════════════════════
   NO BACKTICK MAY APPEAR IN THIS BLOCK - it is inside a template literal.

   BREAKPOINTS: phone under 640, tablet 640-1023, desktop 1024 and up.

   THE FIVE-COLUMN GRID DOES NOT SURVIVE A 390px SCREEN and must not be made to scroll sideways -
   a horizontal scroll on a row is how you lose the delta chip and never know it. Each match
   becomes a stacked card, and the METER KEEPS ITS NOTCH, ITS LABEL AND ITS CLAMP: it is the
   reason the page exists and it is not the thing that gets dropped on the small screen. It stops
   being 104px and takes the width it is given. */
@media (max-width: 639.98px) {
  /* THE STRIP: three across, not five. */
  .gdo .gstrip{grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
  .gdo .gtile{padding:9px 10px}
  .gdo .gtile .v{font-size:20px}
  .gdo .gtile .k{font-size:9.5px;letter-spacing:.5px}
  .gdo .gtile .s{font-size:10px}

  /* THE BANNER RESTACKS. Countdown under the facts, actions full-width and stacked. */
  .gdo .galert{flex-direction:column;align-items:stretch;gap:12px;padding:13px 14px}
  .gdo .gbang{display:none}
  .gdo .gfacts{gap:9px 12px}
  .gdo .gclock{text-align:left;display:flex;align-items:baseline;gap:8px}
  .gdo .gclock .n{font-size:19px}
  .gdo .gacts{flex-direction:column;align-items:stretch;gap:8px}
  .gdo .gacts>*{width:100%}
  .gdo .gbtn,.gdo .gpri{text-align:center;padding:11px 12px;font-size:13.5px}
  .gdo .gstep{justify-content:space-between;padding:5px 6px 5px 13px;font-size:13.5px}
  /* 44x44 MINIMUM. These were 22px squares - a target you miss twice before you hit it, on a
     control that changes what a match costs a player. */
  .gdo .gstep .gsb{width:44px;height:44px;font-size:19px;border-radius:9px}
  .gdo .gstep b{min-width:34px;font-size:16px}

  /* SECTION HEADERS STAY PUT while the list scrolls under them. */
  .gdo .gsec{position:sticky;top:0;z-index:3}
  .gdo .gfoot{font-size:11px}
}

/* THE CITY CHIPS SCROLL IN THEIR OWN CONTAINER at every width, with momentum and no visible
   scrollbar. The PAGE never scrolls sideways - that is the point of confining it here. */
.gdo .gcities .cityf{display:flex;flex-wrap:nowrap;overflow-x:auto;overflow-y:hidden;
  -webkit-overflow-scrolling:touch;scrollbar-width:none;gap:7px;padding-bottom:2px;max-width:100%}
.gdo .gcities .cityf::-webkit-scrollbar{display:none}
.gdo .gcities .gchip{flex:0 0 auto}
.gdo .gcities{flex-wrap:nowrap;min-width:0}

/* THE COMPACT GRID. It used to fire at 1023.98px of VIEWPORT, a breakpoint chosen for the name of
   a device rather than for where the columns stop fitting: at a 1024px window the page chrome left
   652px of row, the match column was handed FORTY PIXELS and every name wrapped to three lines -
   measured 87px bands against a 62px bar.

   TABLET: the grid survives, but the SPOTS COLUMN MUST STILL FIT ITS CONTENTS. At 232px it did
   not - meter 84 + numbers + delta needs about 246 - and the delta chip spilled into the manager
   cell on every row. The overlap walk caught it at 768; eleven content assertions had not. The
   match column gives up the width instead, because a truncated field name has a tooltip and a
   collided delta chip has nothing. */
/* CARD WIDTH, NOT WINDOW WIDTH — and three tiers, derived rather than named after devices.
   A card of width W gives its bands W - 48 of track room (2 card border + 16 list padding +
   2 band border + 28 band padding). The wide tier's fixed tracks are 96 + 310 + 164 + 42 of gap
   = 612, so it needs W >= 810 before the match column clears 150px. The compact tier's are
   76 + 258 + 156 + 30 = 520, needing W >= 640 for the same. Below that no four-track grid fits and
   the band stacks instead — see the card tier further down. */
@container gtable (max-width: 810px) {
  .gdo .gcolhead,.gdo .grow{grid-template-columns:76px minmax(0,1fr) 258px 156px;gap:10px}
  .gdo .gmeter{flex:0 0 76px}
  .gdo .gnum{font-size:11px}
  /* THE CHIP GIVES BACK ~20px HERE, and the price is what gets it. The match column is ~132px at
     1024; the cancels chip sits in an auto track and takes its max-content width first, so a
     full-size "CANCELS IN 1H 19M" left the price rendering as "$8." and, on one row, as "$".
     Shrinking the chip is the right giver: it is a duration anyone can still read at 8.5px, and
     the price is a figure that is wrong if it is cut. */
  .gdo .gm > .gtag{font-size:8.5px;padding:2px 4px;letter-spacing:.2px}
}

/* THE STAT STRIP AND THE STICKY SECTION HEADER KEEP THE OLD 1023.98 BOUNDARY. They are about how
   much horizontal room the PAGE has, not about whether the table's four tracks fit, and the two
   answers stopped being the same when the row grid's boundary moved to 1184. Folded together, a
   1024px screen lost its five-across strip to a change that was only ever about the table. */
@media (min-width: 640px) and (max-width: 1023.98px) {
  .gdo .gstrip{grid-template-columns:repeat(3,minmax(0,1fr))}
  .gdo .gsec{position:sticky;top:0;z-index:3}
}

/* ── THE CARD TIER: BELOW 640px OF CARD, A BAND STOPS BEING A ROW ─────────────────────────────
 * KEYED ON THE CARD, NOT THE WINDOW, and that is the whole reason it is a container query. A
 * 390px phone reaches this tier, but so does a 1500px desktop WITH THE MATCH PANEL OPEN: the panel
 * leaves the card 576px, and at 1280 it leaves it 356px. Under the old viewport media query those
 * desktop cases kept the four-track grid, minmax(0,1fr) did what it is asked to, and the match
 * column collapsed to ZERO WIDTH — the name and the price rendered outside a zero-wide track. No
 * viewport query can see that, which is why every panel-closed width looked fine.
 *
 * THE FOUR-TRACK GRID DOES NOT SURVIVE THIS WIDTH and must not be made to scroll sideways - a
 * horizontal scroll on a band is how you lose the delta chip and never know it. Each match becomes
 * a stacked card, and the METER KEEPS ITS NOTCH, ITS LABEL AND ITS CLAMP: it is the reason the page
 * exists and it is not the thing that gets dropped when the room runs out. It stops being 104px
 * and takes the width it is given. */
@container gtable (max-width: 640px) {
  .gdo .gcolhead{display:none}
  /* THE ROW BECOMES A CARD. Areas rather than source order, so the price can sit on line 1 with
     the kickoff while staying a single element in the DOM - two prices, one hidden per
     breakpoint, would mean two elements answering to one test id. */
  /* ── A. EACH MATCH IS A CARD ────────────────────────────────────────────────────────────────
   * A match's tint used to run to both screen edges with a 1px divider, so two adjacent at-risk
   * matches read as one block. A card with its own ground, border and radius cannot merge with the
   * one below it — and the risk signal moves to the HEADER STRIP so the whole card is not washed
   * red, which is what made adjacent ones indistinguishable.
   *
   * THE BETWEEN-CARD GAP MUST EXCEED THE LARGEST GAP INSIDE A CARD. That ratio is what makes the
   * boundary read; the absolute number is not the point. 12px out, 11px the largest within. */
  .gdo .glist{padding:4px 12px 16px;gap:12px}
  .gdo .grow{
    grid-template-columns:minmax(0,1fr);
    grid-template-areas:"k" "m" "s" "mg";
    gap:0;padding:0;align-items:stretch;position:relative;
    border:1px solid #DCE5E0;border-radius:14px;overflow:hidden;
    background:#fff;box-shadow:0 1px 2px rgba(16,40,28,.05)}
  .gdo .grow:hover{background:#fff}
  /* AN AT-RISK CARD TAKES A RED BORDER, not a red bleed. */
  .gdo .grow.risk{background:#fff;border-color:#f0cfcb;box-shadow:0 1px 2px rgba(120,20,14,.09)}
  .gdo .grow.risk:hover{background:#fff}

  /* A3. THE HEADER STRIP — kickoff, relative time and price on their own tinted band. */
  .gdo .gk{grid-area:k;display:flex;align-items:center;gap:8px;
    padding:8px 13px;background:#F7F9F8;border-bottom:1px solid #EFF3EF}
  .gdo .grow.risk .gk{background:#FBE3E0;border-bottom-color:#F3D2CE}
  .gdo .gk span{margin-top:0;font-size:11.5px}
  .gdo .grow.risk .gk span{color:#9a6560}
  /* The price rides the header strip, pushed right — still one element, positioned not duplicated. */
  .gdo .gm .gpz{position:absolute;top:9px;right:13px;font-size:12px;font-weight:700;color:#20372C}

  /* THE BODY. */
  .gdo .gm{grid-area:m;padding:11px 13px 0;grid-template-areas:"n n" "sub chip";
    grid-template-columns:minmax(0,1fr) auto;row-gap:2px}
  .gdo .gm .n{font-size:15.5px;letter-spacing:-.2px;line-height:1.25}
  .gdo .gm .n s{white-space:normal;overflow:visible;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  .gdo .gm .sub{font-size:12px}
  .gdo .gs{grid-area:s;gap:11px;padding:11px 13px 12px;overflow:visible}

  /* A4. THE FOOTER STRIP — the manager on their own faintly tinted band. */
  .gdo .gmg{grid-area:mg;align-self:auto;padding:8px 13px;
    border-top:1px solid #EFF3EF;background:#FCFDFC}
  .gdo .grow.risk .gmg{background:#FEF7F6;border-top-color:#F6E0DD}

  /* A6. THE METER takes the card's width and reserves room for its label. 15px clips it. */
  .gdo .gmeter{flex:1 1 auto;min-width:0;padding-bottom:28px}
  .gdo .gnum{font-size:12px}

}

/* THE EDITOR IS A BOTTOM SHEET ON A PHONE, not a 600px side drawer on a 390px screen. Full height,
   every field kept including the highlighted minimum, and the footer pinned so Save and Cancel are
   reachable without scrolling past the form. */
@media (max-width: 639.98px) {
  .gdo .gpanel{position:fixed;inset:0;left:0;right:0;width:100vw;max-width:100vw;
    border-radius:14px 14px 0 0;display:flex;flex-direction:column;z-index:60}
  .gdo .gpanel-body{flex:1 1 auto;min-height:0;overflow:hidden}
  .gdo .gpanel-bar{flex:0 0 auto}
  .gdo .gpanel-body>.mp>.mp-panel>.mp-fs>.mp-foot{position:sticky;bottom:0;background:#fff;
    border-top:1px solid #DCE5E0;padding-bottom:max(env(safe-area-inset-bottom),10px)}
}


/* THE MOBILE CHIP ROW is the one a phone actually shows - the desktop .row2 is hidden there. Same
   contract: it scrolls inside itself, with momentum and no visible scrollbar, so the PAGE never
   scrolls sideways. */
.gdo .mchips{display:flex;flex-wrap:nowrap;overflow-x:auto;overflow-y:hidden;
  -webkit-overflow-scrolling:touch;scrollbar-width:none;gap:7px;max-width:100%}
.gdo .mchips::-webkit-scrollbar{display:none}
.gdo .mchips>*{flex:0 0 auto}


/* ── THE PANEL'S TWO TABS ──────────────────────────────────────────────────────────────────── */
.gdo .gpanel-tabs{display:flex;gap:2px;padding:0 12px;border-bottom:1px solid #DCE5E0;flex:0 0 auto;background:#fff}
.gdo .gpanel-tabs button{border:0;background:none;font:inherit;font-size:12.5px;font-weight:700;
  color:#66786E;padding:9px 14px;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px}
.gdo .gpanel-tabs button:hover{color:#1B3227}
.gdo .gpanel-tabs button.on{color:#046B45;border-bottom-color:#046B45}
/* HIDDEN, NOT UNMOUNTED - display:none keeps the React tree alive so unsaved edits survive. */
.gdo .gpanel-hide{display:none !important}
.gdo .gpanel-chat{padding:0;display:flex;flex-direction:column;min-height:0}

/* THE ACTION AREA IS A 2x2 GRID. Four controls in one row measured 608px and crushed the banner
   text; as a 2x2 it is 324px and the banner holds its height down to 1280. */
/* minmax(0,auto) SO A SPANNING ITEM CANNOT WIDEN THE TRACKS. With plain auto, the direction
   sentence and the save button span both columns and their min-content is distributed across them,
   so the whole grid grew to 498px the moment a value was stepped. The tracks size to the two
   controls that actually sit in them; everything spanning wraps inside that width. */
.gdo .gacts{display:grid;grid-template-columns:minmax(0,auto) minmax(0,auto);gap:8px;
  align-items:center;justify-items:stretch;flex:0 0 auto}
.gdo .gacts .gsave,.gdo .gacts [data-testid="gday-spotstep"]{min-width:0}
/* A SPANNING ITEM STILL SIZES THE TRACKS IT SPANS. The explanatory sentence spans both columns, so
   its max-content was distributed across them and pushed the grid from 308px to 498px — measured,
   after two wrong guesses at the cause. width:0 with min-width:100% removes it from intrinsic
   sizing entirely while still laying it out across the full row. */
.gdo .gdirection{overflow-wrap:anywhere;width:0;min-width:100%}
/* THREE CONTROLS, NOT FOUR, AND THE THIRD SPANS. "Spots left now − 8 + · 5 fake" is the widest of
   the three; leaving it in a column forced BOTH columns to its width — the action area went from
   324px to 498px and the banner from 101px to 180px at 1280. Spanning it sizes the two columns by
   the narrower pair and puts it on its own row, which is where three items want to sit anyway. */
.gdo .gacts .gsave,.gdo .gacts .gdirection,.gdo .gacts [data-testid="gday-spotstep"]{grid-column:1 / -1}
.gdo .gstep .glab{display:inline-flex;align-items:baseline;gap:3px;white-space:nowrap}
.gdo .gstep .glab b{min-width:0;font-size:13.5px}
.gdo .gstep .glab i{font-style:normal;font-size:11px;color:#66786E;font-weight:600}
.gdo .gtrail{font-style:normal;font-size:11px;color:#66786E;font-weight:600;white-space:nowrap;margin-left:2px}
.gdo .gladdernote{font-size:11px;color:#8A5A08;background:#FFF6E3;border:1px solid #F0DFB8;
  border-radius:7px;padding:4px 9px;text-align:center}
@media (max-width: 639.98px) {
  .gdo .gacts{grid-template-columns:1fr}
  .gdo .gpanel-tabs button{padding:12px 16px;font-size:14px}
}


/* ── C. THE BANNER RESTACKS ON ITS OWN WIDTH, NOT THE WINDOW'S ────────────────────────────────
   With the match panel open the board narrows to roughly 900px inside a 1500px window, and the
   headline collapsed to one word per line — "The / Hattrick / (Leander) / is 6 / players / short"
   — while the action grid held its width and crushed the text block to a sliver.

   A MEDIA QUERY CANNOT SEE THIS. The trigger is the panel, not the screen: the viewport never
   changed. A CONTAINER QUERY asks the right question — how much room does this banner actually
   have — and answers it identically whether the width was taken by a small screen or by a panel.

   The alert-slot is the container; the banner queries it. Below 860px the banner becomes a column:
   text block full width first, then the countdown, then the action grid beneath. */
.gdo [data-testid="gday-alertslot"]{container-type:inline-size;container-name:gbanner}
@container gbanner (max-width: 860px) {
  .gdo .galert{flex-direction:column;align-items:stretch;gap:12px}
  .gdo .galert .gbang{display:none}
  .gdo .galert .gclock{text-align:left;display:flex;align-items:baseline;gap:8px}
  /* minmax(0,…) SO THE COLUMNS CAN SHRINK. auto auto sizes to content and, on a 390px phone,
     pushed the page into a horizontal scroll — the container query fires there too, and a track
     that cannot shrink is a track that overflows. */
  .gdo .galert .gacts{grid-template-columns:minmax(0,1fr) minmax(0,1fr);justify-items:stretch}
}
/* AND A PHONE STILL GETS ONE COLUMN. This sits after the container query on purpose: below 640px
   the viewport is the binding constraint, whatever the container says. */
@media (max-width: 639.98px) { .gdo .galert .gacts{grid-template-columns:1fr} }
/* THE TEXT BLOCK NEVER GETS CRUSHED — but only where there is room for the floor to mean anything.
   280px on a 390px screen is the whole width; the phone layout stacks instead and needs no floor. */
@container gbanner (min-width: 640px) { .gdo .gtxt{min-width:280px} }
.gdo .galert .gacts{flex:0 1 auto;min-width:0}
.gdo .gdirection{font-size:10.5px;color:#66786E;line-height:1.45}

`;

/* ── THE STAT STRIP ─────────────────────────────────────────────────────────────────────────────
 * Five tiles across the top, replacing the All / Needs attention / Still to come pill row.
 *
 * ONLY THREE OF THEM FILTER. All matches and Real spots filled are read-outs, and they are
 * rendered as <div>, never as a disabled <button> — a control that looks live and does nothing is
 * the one thing this estate does not ship, and the cheapest way to keep that promise is for the
 * non-controls not to be controls in the DOM.
 *
 * NEEDS ATTENTION IS RED ONLY WHEN IT IS NON-ZERO. A permanently red tile reading 0 trains the
 * operator to ignore the colour, which is the only thing the colour is for.
 */
type StripStats = {
  soon: ApiMatch[]; live: ApiMatch[]; risk: ApiMatch[];
  fill: { pct: number | null; real: number; cap: number; fake: number; bumped: number };
  cityCount: number; nextKick: ApiMatch | null; allCount: number;
};
function StatStrip({ s, active, onPick, clockOf }: {
  s: StripStats & { riskSub: string }; active: StripKey | null; onPick: (k: StripKey) => void; clockOf: (m: ApiMatch) => string;
}) {
  const pct = s.fill.pct;
  const T: { k: StripKey; lab: string; val: string; sub: string; can: boolean; warn?: boolean }[] = [
    { k: "all", lab: "All matches", val: String(s.allCount),
      sub: `${s.cityCount} ${s.cityCount === 1 ? "city" : "cities"}`, can: false },
    { k: "risk", lab: "Needs attention", val: String(s.risk.length),
      sub: s.riskSub, can: true, warn: true },
    { k: "soon", lab: "Still to come", val: String(s.soon.length),
      sub: s.nextKick ? `next at ${clockOf(s.nextKick)}` : "none left today", can: true },
    { k: "live", lab: "In play", val: String(s.live.length), sub: "kicked off", can: true },
    /* THE FILL IS A RATIO OF SUMS, computed in the model — see realFillPct. "—" and not "0%" when
     * nothing has capacity, because 0% is a claim about a day that had no spots to fill. */
    { k: "fill", lab: "Real spots filled", val: pct == null ? "—" : `${Math.round(pct)}%`,
      /* THE BUMP COUNT, ONLY WHEN THERE IS ONE. A match that grew to four teams grew its own
       * denominator with it on the manual convert path, so the percentage can fall while the night
       * improves. Saying nothing when none have bumped keeps the line short on an ordinary night. */
      sub: pct == null ? "no capacity today"
        : `${s.fill.real} of ${s.fill.cap} · ${s.fill.fake} fake`
          + (s.fill.bumped > 0 ? ` · ${s.fill.bumped} match${s.fill.bumped === 1 ? "" : "es"} bumped` : ""),
      can: false },
  ];
  return (
    <div className="gstrip" data-testid="gday-strip">
      {T.map((t) => {
        const on = t.can && active === t.k;
        const cls = "gtile"
          + (t.warn ? (Number(t.val) > 0 ? " warn" : " warn zero") : "")
          + (on ? " on" : "") + (t.can ? "" : " static");
        const inner = (<>
          <div className="k">{t.lab}</div>
          <div className="v" data-testid={`gtile-v-${t.k}`}>{t.val}</div>
          <div className="s" data-testid={`gtile-s-${t.k}`}>{t.sub}</div>
        </>);
        return t.can
          ? <button key={t.k} type="button" className={cls} data-testid={`gtile-${t.k}`} data-on={on ? "1" : "0"}
              aria-pressed={on} onClick={() => onPick(t.k)}>{inner}</button>
          : <div key={t.k} className={cls} data-testid={`gtile-${t.k}`} data-static="1">{inner}</div>;
      })}
    </div>
  );
}

/* ── THE MIN LABEL, CLAMPED BY ITS OWN MEASURED WIDTH ─────────────────────────────────────────
 * C2. The clamp was a hard-coded 12-88%, chosen for "min 9" and wrong for anything longer — the
 * same class of defect as the vertical clip: a magic number that happened to fit the string it was
 * written for. A wider clamp would just be a bigger magic number.
 *
 * THE RULE IS DERIVED, NOT GUESSED: the label's centre must sit at least HALF ITS OWN RENDERED
 * WIDTH from each end of the track, so its edges land exactly on the track's edges in the worst
 * case and inside it everywhere else. That needs the rendered width, which only the browser knows,
 * so it is measured in a layout effect and applied before paint.
 *
 * Before the measurement lands the label renders at its unclamped position; useLayoutEffect runs
 * before the browser paints, so there is no flash of a mispositioned label. */
function MinLabel({ pct, n }: { pct: number; n: number }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [clamped, setClamped] = useState(pct);
  useLayoutEffect(() => {
    const el = ref.current;
    const track = el?.parentElement?.querySelector(".gbar") as HTMLElement | null;
    if (!el || !track) { setClamped(pct); return; }
    const tw = track.offsetWidth;
    if (tw <= 0) { setClamped(pct); return; }
    const halfPct = (el.offsetWidth / 2 / tw) * 100;
    /* A LABEL WIDER THAN ITS TRACK cannot satisfy both bounds; centre it and let it use the full
     * width rather than pinning it to one edge. */
    const lo = Math.min(halfPct, 50), hi = Math.max(100 - halfPct, 50);
    setClamped(Math.max(lo, Math.min(hi, pct)));
  }, [pct, n]);
  return (
    <div ref={ref} className="gmnl" data-testid="gday-minlabel" data-min={n}
      data-pct={clamped.toFixed(4)} data-raw={pct.toFixed(4)}
      style={{ left: `${clamped}%` }}>min {n}</div>
  );
}

/* ── A ROW ──────────────────────────────────────────────────────────────────────────────────────
 * Four columns: kickoff 96 / match·field flex / spots 310 / manager 164. The standalone
 * vs MIN, CANCEL TIME and PRICE columns are gone — the first two are now the delta chip and the
 * "cancels in" chip, and price is a muted chip beside the name, which is where it is read.
 *
 * THE MINIMUM IS A NOTCH, NOT A MARKER. A 1px square-ended hairline spanning exactly the bar
 * height, with a 1px white edge each side via box-shadow so it stays legible over the solid fill,
 * over the hatch and over the bare track alike. No overhang and no rounded cap: a marker that
 * overhangs reads as a range, and a rounded one reads as a handle you can drag.
 *
 * THE LABEL SITS DIRECTLY BENEATH IT with no connector stub — proximity does that work, and a stub
 * at this size is three more pixels of ink saying what adjacency already says.
 */
function GRow({ m, now, selected, onOpen, money, atRiskRow }: {
  m: ApiMatch; now: number; selected: boolean; onOpen: (id: number) => void;
  money: (c: number | null | undefined) => string; atRiskRow: boolean;
}) {
  const b = dayBucket(m, now);
  const cap = capacity(m), real = realCount(m), fk = fakeCount(m);
  const min = Number(m.minPlayerCount ?? 0);
  const g = meter(m);
  const d = vsMinDelta(m);
  const t = minsUntil(m, now);
  const when = b === "live" ? "in play" : b === "done" ? "finished" : b === "cx" ? "cancelled" : `in ${fmtDur(t)}`;
  /* THE CHIP FOLLOWS showsDeadline, NOT "is it armed". A match 25 players over its minimum carried
   * a countdown before this — see the model. */
  const ac = showsDeadline(m, now) ? minsToDeadline(m, now) : null;
  const mgr = m.manager ? [m.manager.firstName, m.manager.lastName].filter(Boolean).join(" ").trim() : "";
  /* THE FULL NAME, NEVER TRUNCATED. "Moncho P..." and "Chama🔥 r..." were what the old 96px cell
   * produced. Initials are stripped of non-letters first so an emoji in a name cannot become one. */
  const initials = (mgr || "—").replace(/[^A-Za-z ]/g, "").trim().split(/\s+/).filter(Boolean)
    .map((w) => w[0]).join("").slice(0, 2).toUpperCase() || "—";
  const clock = localClock(m);
  const [hh, ap] = [clock.replace(/\s*(AM|PM)$/i, ""), (clock.match(/(AM|PM)$/i) ?? [""])[0]];

  return (
    <div className={"grow" + (atRiskRow ? " risk" : "") + (b === "done" ? " done" : "") + (selected ? " sel" : "")}
      data-testid="gday-row" data-id={m.id} data-city={m.field?.city?.name ?? ""} data-bucket={b}
      data-risk={atRiskRow ? "1" : "0"} role="button" tabIndex={0}
      onClick={() => onOpen(m.id)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(m.id); } }}>

      <div className="gk"><b>{hh}<i>{ap}</i></b><span data-testid="gday-when">{when}</span></div>

      <div className="gm">
        <div className="n">
          <s data-testid="gday-name">{m.name}</s>
          {/* THE "MORE FAKE" CHIP WAS HERE AND IS GONE. It fired when fake exceeded real, which
              on a real board is almost exactly the set of rows already styled red — and the spots
              cell two columns over says the same thing with the actual numbers
              ("3 real · 9 fake · 12/18"). A chip restating a fact stated better beside it, at the
              cost of width the field name needs. The counts themselves are untouched. */}
          <span className="gpz" data-testid="gday-price">{money(m.registrationPrice)}</span>
        </div>
        {/* THE CHIP IS A DIRECT CHILD OF .gm, NOT OF .n, AND THAT IS THE WHOLE POINT.
            Inside .n it shared the title's inline flow, so a long name pushed it onto a line of its
            own — "STAR Soccer Complex Field 13" does exactly that. Out here it is placed by GRID
            AREA, which lets the two layouts put it in different places from one DOM: desktop keeps
            it on the title row (areas "n chip" / "sub sub"), mobile drops it onto the field · city
            row (areas "n n" / "sub chip") so the title gets the full card width.

            PAST THE DEADLINE IT READS "now" RATHER THAN VANISHING — a chip that disappears at the
            moment the thing becomes true is the wrong way round, and it would also break the
            chip/banner agreement, since the banner does not stop at zero either. */}
        {ac != null && <span className="gtag hot" data-testid="gday-cancels">{ac > 0 ? `cancels in ${fmtDur(ac)}` : "cancels now"}</span>}
        <div className="sub">{m.field?.title ?? "—"} · {m.field?.city?.name ?? "—"}</div>
      </div>

      <div className="gs">
        {g ? (
          <div className="gmeter">
            <div className={"gbar" + (d < 0 ? " short" : "")}>
              <div className="r" data-testid="gday-real" style={{ width: `${g.realPct}%` }} />
              <div className="f" data-testid="gday-fake" style={{ left: `${g.realPct}%`, width: `${g.fakePct}%` }} />
              {/* NO MINIMUM, NO NOTCH — see meter(). A tick at 0% claims a threshold that is not set. */}
              {g.hasMin && <div className="mn" data-testid="gday-notch" data-pct={g.minPct.toFixed(4)} style={{ left: `${g.minPct}%` }} />}
            </div>
            {g.hasMin
              ? <MinLabel pct={g.minPct} n={min} />
              : /* C1. A MATCH WITH NO MINIMUM HAS NO NOTCH, so the label has nothing to be centred
                   on. It describes the whole bar, so it is LEFT-ALIGNED to the start of the track
                   and not clamped at all. Centre-positioning it at a 12% clamp is what sheared
                   "no min" down to "o min": ~32px of text with its centre 12.5px from the left edge
                   puts its left edge at about -3.5px. */
                <div className="gmnl gnomin" data-testid="gday-nomin">no min</div>}
          </div>
        ) : <div className="gmeter" />}
        <div className="gnum" data-testid="gday-nums">
          <b>{real}</b> real{fk > 0 ? <> · {fk} fake</> : null} · {real + fk}/{cap ?? "—"}
        </div>
        <div className={"gdelta" + (d < 0 ? " bad" : b === "done" ? " mut" : "")} data-testid="gday-delta" data-d={d}>
          {d >= 0 ? "+" : "−"}{Math.abs(d)}
        </div>
      </div>

      <div className="gmg" data-testid="gday-mgr"><span className="gav">{initials}</span><span>{mgr || "none"}</span></div>

      {/* THE KEBAB WAS HERE AND IS GONE. It read as the affordance for opening the editor and was
          the one element on the row that did NOT open it — the click guard excludes buttons, and
          nothing was ever wired behind it. An affordance that does nothing is worse than no
          affordance. Its 34px went to the manager column, which was clipping names. */}
    </div>
  );
}

/* ── THE ALERT BANNER ───────────────────────────────────────────────────────────────────────────
 * One per at-risk match, and rendered only when at least one exists — an empty banner slot that
 * always occupies space teaches the operator to stop looking at it.
 *
 * IT IS NOT A SENTENCE. Headline, meta line and a three-stat facts row are separate elements on
 * purpose: an operator scanning this at 10pm needs the shortfall, the kickoff and the three
 * numbers to be findable individually, and a paragraph makes all three equally hard to find.
 *
 * THE FACTS ROW IS THREE DISCRETE STATS separated by hairlines, each a bold number over a muted
 * label. Collapsing it back into "3 real, 9 minimum, 11 of 14 fake" is the thing not to do.
 */
function AlertBanner({ m, now, pending, pendingSpots, onStep, onStepSpots,
  onSave, onSaveSpots, onOpen, onChat, saveState, canEdit, stepperReason }: {
  m: ApiMatch; now: number; pending: number | null; pendingSpots: number | null;
  onStep: (id: number, d: number) => void;
  onStepSpots: (id: number, d: number) => void;
  onSave: (id: number) => void; onSaveSpots: (id: number) => void;
  onOpen: (id: number) => void; onChat: (id: number) => void;
  saveState?: { s: "saving" | "landed" | "failed" | "unknown"; msg: string };
  canEdit: boolean; stepperReason: string | null;
}) {
  const real = realCount(m), fk = fakeCount(m), cap = capacity(m) ?? 0;
  const savedMin = Number(m.minPlayerCount ?? 0);
  const shownMin = pending ?? savedMin;
  const moved = pending != null && pending !== savedMin;
  const shortNow = Math.max(0, shownMin - real);
  const ac = minsToDeadline(m, now);
  const minsToKick = minsUntil(m, now);
  /* THE RUNG IN FORCE — the value the one control steps, read from hours-to-kickoff. */
  const ladder: Ladder = {
    fakeSpotLeft36h: Number(m.fakeSpotLeft36h ?? 0), fakeSpotLeft24h: Number(m.fakeSpotLeft24h ?? 0),
    fakeSpotLeft12h: Number(m.fakeSpotLeft12h ?? 0), fakeSpotLeft6h: Number(m.fakeSpotLeft6h ?? 0),
    fakeSpotLeft3h: Number(m.fakeSpotLeft3h ?? 0),
  };
  const savedSpots = spotsLeftNow(ladder, minsToKick / 60);
  const shownSpots = pendingSpots ?? savedSpots;
  const spotsMoved = pendingSpots != null && pendingSpots !== savedSpots;

  /* THE HEADLINE FOLLOWS THE PENDING VALUE. Stepping the minimum below the real count turns
   * "is 6 players short" into "clears its minimum at 3" — the operator sees the consequence of the
   * change before committing it, which is the whole reason the stepper is inline and not a modal. */
  const head = shortNow > 0
    ? `${m.name} is ${shortNow} player${shortNow === 1 ? "" : "s"} short`
    : `${m.name} clears its minimum at ${shownMin}`;

  const mgr = m.manager ? [m.manager.firstName, m.manager.lastName].filter(Boolean).join(" ").trim() : "";
  const stop = (e: React.MouseEvent) => e.stopPropagation();

  return (
    <div className="galert" data-testid="gday-alert" data-id={m.id} data-moved={moved ? "1" : "0"}
      role="button" tabIndex={0}
      onClick={() => onOpen(m.id)}
      onKeyDown={(e) => { if (e.key === "Enter") onOpen(m.id); }}>
      <div className="gbang" aria-hidden>!</div>
      <div className="gtxt">
        <div className="gt1" data-testid="gday-alert-head">{head}</div>
        <div className="gmeta" data-testid="gday-alert-meta">
          {localClock(m)} kickoff · {m.field?.title ?? "—"} · {m.field?.city?.name ?? "—"} · {mgr || "no manager"}
        </div>
        <div className="gfacts" data-testid="gday-alert-facts">
          <span className="gf bad" data-testid="gday-fact-real"><b>{real}</b> real</span>
          <i aria-hidden />
          <span className={"gf" + (moved ? " moved" : "")} data-testid="gday-fact-min">
            <b data-testid="gday-fact-minv">{shownMin}</b> minimum
            {moved && <em data-testid="gday-fact-minwas">was {savedMin}</em>}
          </span>
          <i aria-hidden />
          {/* A. THE SAME UNITS AND ORDER AS THE TABLE ROW — "3 real · 9 fake · 12/18". Two phrasings
              for one set of facts on one screen was the defect; the sentence form is gone. */}
          <span className="gf" data-testid="gday-fact-fake"><b>{fk}</b> fake</span>
          <i aria-hidden />
          <span className="gf" data-testid="gday-fact-filled"><b>{real + fk}</b>/{cap}</span>
        </div>
      </div>
      <div className="gclock" onClick={stop}>
        <div className="n" data-testid="gday-countdown">{ac > 0 ? fmtDur(ac) : "now"}</div>
        <div className="l">until auto-cancel</div>
      </div>
      {/* ── THE ACTION AREA IS A 2x2 GRID, NOT A ROW ────────────────────────────────────────────
       * Four controls in one row measured 608px - half the banner - and crushed the text: the meta
       * line wrapped at 1500 and the banner grew to 187px at 1280. As a 2x2 it is 324px and the
       * banner holds at 101px down to 1280. */}
      <div className="gacts" data-testid="gday-acts" onClick={stop}>
        <a className="gbtn" data-testid="gday-chat" data-chat-id={String(m.id)}
          href={`/match-ops/match-chats?chatId=${encodeURIComponent(String(m.id))}`}
          onClick={(e) => { stop(e); e.preventDefault(); onChat(m.id); }}>Open match chat</a>

        <span className="gstep" data-testid="gday-stepper" title={stepperReason ?? "Below this many real players the match auto-cancels"}>
          {/* E. THE CONSEQUENCE, NOT THE FIELD NAME. "Adjust min" is ambiguous — minimum what. The
              editor already says "MIN PLAYERS — below this, it cancels"; this is that, at a glance. */}
          Cancels below
          <button type="button" className="gsb" data-testid="gday-step-down" aria-label="Lower the minimum"
            disabled={!canEdit || shownMin <= 2}
            onClick={(e) => { stop(e); onStep(m.id, -1); }}>−</button>
          <b data-testid="gday-step-value">{shownMin}</b>
          <button type="button" className="gsb" data-testid="gday-step-up" aria-label="Raise the minimum"
            disabled={!canEdit || shownMin >= cap}
            onClick={(e) => { stop(e); onStep(m.id, 1); }}>+</button>
        </span>

        {/* ── ONE FAKE CONTROL, AND IT STEPS THE VALUE THAT PERSISTS ────────────────────────────
         * SPOTS-SHOWN-AS-LEFT IS STORED; the fake count is derived from it and DRIFTS as real
         * players join. A stepper on a drifting number reads as a save that came undone — set
         * 5 fakes, two people sign up, and it says 3 with nothing having gone wrong. So the control
         * steps the rung and shows the fake count as a read-out beside it.
         *
         * ONE CONTROL, NOT TWO. Setting a different value for the 3h band than for now is no longer
         * possible from the banner — accepted deliberately; the full ladder stays in the editor. */}
        <span className="gstep" data-testid="gday-spotstep"
          title="How many spots the match shows as left, now and through to kickoff. Fewer spots shown means more fake spots.">
          <span className="glab">Spots left now</span>
          <button type="button" className="gsb" data-testid="gday-spots-down" aria-label="Show fewer spots left"
            disabled={!canEdit || shownSpots <= 0}
            onClick={(e) => { stop(e); onStepSpots(m.id, -1); }}>−</button>
          <b data-testid="gday-spots-value">{shownSpots}</b>
          <button type="button" className="gsb" data-testid="gday-spots-up" aria-label="Show more spots left"
            disabled={!canEdit || shownSpots >= Math.max(0, cap - real)}
            onClick={(e) => { stop(e); onStepSpots(m.id, 1); }}>+</button>
          {/* READ-ONLY. What the setting does to the match, not a second thing to adjust. */}
          <i className="gtrail" data-testid="gday-spots-fakes">· {fakesFor(cap, shownSpots, real)} fake</i>
        </span>

        {/* ONE SAVE, FOR WHICHEVER VALUE MOVED. Green only when the minimum change actually clears
            the shortfall - an adjustment is not a rescue. */}
        {(moved || spotsMoved) && (
          <button type="button" className={"gpri gsave" + (moved && shortNow === 0 ? " ok" : "")}
            data-testid={moved ? "gday-save-min" : "gday-save-spots"}
            data-clears={moved ? (shortNow === 0 ? "1" : "0") : null}
            disabled={saveState?.s === "saving"}
            title={moved
              ? (shortNow === 0
                ? `Sets the minimum to ${shownMin}, which ${real} real players already meet — this prevents the auto-cancel.`
                : `Sets the minimum to ${shownMin}. Still ${shortNow} short of ${real} real players, so the auto-cancel will still fire.`)
              : `Holds ${shownSpots} spot${shownSpots === 1 ? "" : "s"} showing as left through to kickoff.`}
            onClick={(e) => { stop(e); if (moved) onSave(m.id); else onSaveSpots(m.id); }}>
            {saveState?.s === "saving" ? "Saving…"
              : moved ? `Save min ${shownMin}`
              : `Save ${shownSpots} left`}
          </button>
        )}
        {/* ONE SENTENCE, STATING WHAT PERSISTS. The old pair needed a paragraph explaining which
            control fed which; one control needs one line. */}
        {spotsMoved && (
          <span className="gdirection" data-testid="gday-direction">
            Holds {shownSpots} spot{shownSpots === 1 ? "" : "s"} showing as left through to kickoff.
            Fakes come off automatically as real players join.
          </span>
        )}
        {saveState && saveState.s !== "saving" && (
          <span className={"gverdict " + saveState.s} data-testid="gday-save-verdict" data-state={saveState.s}>
            {saveState.msg}
          </span>
        )}
      </div>
    </div>
  );
}
