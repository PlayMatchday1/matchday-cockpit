"use client";

// MATCH PROMOTION — the weekly push plan. Spec: mockups/mktg-v3.html.
//
// THREE THINGS ON ONE PAGE, and the reason they are on one page:
//   The week      city-grouped 7-day grid. Click a match to plan it.
//   Cancel        four weeks of cancellations folded into one grid, city down, weekday across.
//   patterns      Unnumbered — it is the evidence you consult while marking, not a later stage.
//   Coverage      a TAB beside Plan. Same week, different question: where is nothing going out.
//
// THE POINT OF PUTTING THE TWO GRIDS TOGETHER is NOT PROMOTED: a slot that died 2+ of the last four
// weeks and has no push planned this week. Neither grid can say that alone.
//
// WALL CLOCK vs TRUE UTC, on one screen. Match times arrive already parsed component-wise by
// fetchVeoWeek and are venue-local; nothing here re-parses one. push_at is a timestamptz we write
// ourselves — a real instant — and is the ONLY value on this page that new Date() may touch.

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import PageComments from "@/components/PageComments";
import MatchPromotionMobile from "@/components/MatchPromotionMobile";
import { useMatchData } from "@/lib/useMatchData";
import { useFinanceData } from "@/lib/useFinanceData";
import { getCancelPatterns } from "@/lib/cancelPatterns";
import { mostRecentCompletedWeekMonday } from "@/lib/weekWindow";
import {
  CHANNELS, CHANNEL_KEYS, NEW_FLAG_LABEL, coverageCaption, coverageStateOf, coverageSummary,
  type ChannelKey, type PromoMatch, type PromoWeek,
} from "@/lib/matchPromotion";

const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/**
 * BELOW 768px THE PHONE LAYOUT, AT AND ABOVE THE DESKTOP ONE. There is deliberately no state in
 * between: all three desktop views are city × weekday grids and seven columns do not survive a
 * narrow screen by getting narrower, so the middle ground would be a third layout nobody asked for.
 *
 * Starts false so the server and the first client paint agree on the desktop tree; matchMedia can
 * only be asked in a browser, so the phone swaps in on mount.
 */
function useIsMobile(): boolean {
  const [m, setM] = useState(false);
  useEffect(() => {
    const q = window.matchMedia("(max-width: 767px)");
    const on = () => setM(q.matches);
    on();
    q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }, []);
  return m;
}

function fmtPushLocal(iso: string): { day: string; time: string } {
  const d = new Date(iso);
  let h = d.getHours();
  const m = d.getMinutes();
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return { day: DOW[(d.getDay() + 6) % 7], time: `${h}:${String(m).padStart(2, "0")} ${ap}` };
}

/** Lead time between the push and kick-off, in the words the tile uses. */
function leadLabel(pushIso: string, weekStart: string, dayIdx: number, minutes: number): string {
  const [y, mo, da] = weekStart.split("-").map(Number);
  const kick = new Date(y, mo - 1, da + dayIdx, Math.floor(minutes / 60), minutes % 60);
  const diff = kick.getTime() - new Date(pushIso).getTime();
  if (diff <= 0) return "after kick-off";
  const h = Math.round(diff / 3600000);
  if (h < 48) return `${h}h before`;
  return `${Math.floor(h / 24)}d ${h % 24}h before`;
}

const dtLocalValue = (iso: string | null): string => {
  if (!iso) return "";
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

type Draft = {
  channels: Record<ChannelKey, boolean>;
  pushAt: string; // datetime-local value; "" = needs a decision
  promoCode: string;
};

const draftFrom = (m: PromoMatch): Draft => ({
  channels: Object.fromEntries(
    CHANNEL_KEYS.map((k) => [k, m.plan?.channels[k] === true]),
  ) as Record<ChannelKey, boolean>,
  pushAt: dtLocalValue(m.plan?.pushAt ?? null),
  promoCode: m.plan?.promoCode ?? "",
});

export default function MatchPromotionView() {
  const [week, setWeek] = useState<PromoWeek | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"plan" | "coverage">("plan");
  // THE PHONE OPENS ON DUE; desktop opens on Plan and is untouched. Separate state because "due"
  // is not a desktop view and must never leak into the desktop tab set.
  const [mTab, setMTab] = useState<"due" | "week" | "coverage">("due");
  const isMobile = useIsMobile();
  const [weekRef, setWeekRef] = useState("");
  const [openId, setOpenId] = useState<number | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ msg: string; bad: boolean } | null>(null);

  const load = useCallback(async (ref: string) => {
    setLoading(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      const url = ref ? `/api/match-promotion?week=${encodeURIComponent(ref)}` : "/api/match-promotion";
      const res = await fetch(url, { cache: "no-store", headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setWeek((await res.json()) as PromoWeek);
      setError("");
    } catch {
      setError("Couldn't load the promotion week. Try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(""); }, [load]);

  const open = week?.matches.find((m) => m.apiId === openId) ?? null;

  /**
   * KEEP THE CLICKED TILE WHERE IT IS. Opening a panel inserts a block into the flow, and closing
   * one removes it. Neither should move the thing you just clicked: if a panel is already open in
   * a city ABOVE this one, closing it shortens the page and the whole grid jumps up under the
   * pointer. So the tile's viewport offset is measured before the state change and restored after
   * paint — which is also what makes "closing returns you to the same scroll position" true.
   */
  function anchor(el: HTMLElement | null, mutate: () => void) {
    const before = el?.getBoundingClientRect().top ?? null;
    mutate();
    if (before === null || !el) return;
    requestAnimationFrame(() => {
      const after = el.getBoundingClientRect().top;
      if (after !== before) window.scrollBy(0, after - before);
    });
  }

  function openMatch(m: PromoMatch, el: HTMLElement) {
    anchor(el, () => { setOpenId(m.apiId); setDraft(draftFrom(m)); });
  }

  function closePanel() {
    const el = openId != null
      ? (document.querySelector(`[data-testid="match-tile"][data-api-id="${openId}"]`) as HTMLElement | null)
      : null;
    anchor(el, () => { setOpenId(null); setDraft(null); });
  }

  async function save() {
    if (!open || !draft) return;
    setSaving(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      const res = await fetch("/api/match-promotion", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({
          matchApiId: open.apiId,
          channels: draft.channels,
          // "" means NEEDS A DECISION, and must reach the route as null so it stores SQL NULL. An
          // empty string here would be a third state nothing knows how to render.
          pushAt: draft.pushAt === "" ? null : new Date(draft.pushAt).toISOString(),
          promoCode: draft.promoCode,
          /* match_promotion_plan.comment IS NO LONGER WRITTEN. Comments are one attributed list for
           * the page (slate_notes kind='comment'), not a single unowned string per plan that
           * whoever saved last overwrote. The column is left in place and never sent — measured
           * 2026-08-25, it had never held a value: 2 plan rows, 0 comments, 9 audit entries, none
           * setting one. It is not rendered either; an unreachable read-only fallback guarding a
           * case that has never occurred is a thing someone deletes in six months wondering what
           * it was for. */
        }),
      });
      const json = (await res.json()) as { outcome?: string; error?: string };
      if (json.outcome === "LANDED") {
        setToast({ msg: "Plan saved.", bad: false });
        closePanel();
        await load(weekRef);
      } else {
        setToast({ msg: `${json.outcome ?? "FAILED"} — ${json.error ?? "nothing was written."}`, bad: true });
      }
    } catch {
      setToast({ msg: "Network error — nothing was written.", bad: true });
    } finally {
      setSaving(false);
    }
  }

  const nav = async (delta: number) => {
    if (!week) return;
    const [y, m, d] = week.weekStart.split("-").map(Number);
    const t = new Date(y, m - 1, d + delta * 7);
    const p = (n: number) => String(n).padStart(2, "0");
    const ref = `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
    setWeekRef(ref); setOpenId(null); setDraft(null);
    await load(ref);
  };

  /* ── the numbers in the strip, derived from the SAME array the strip renders ─────────────── */
  const jobs = useMemo(() => {
    if (!week) return [];
    return week.matches
      .filter((m) => m.plan?.pushAt)
      .map((m) => ({ m, at: new Date(m.plan!.pushAt!).getTime() }))
      .sort((a, b) => a.at - b.at);
  }, [week]);
  const now = Date.now();
  const overdue = jobs.filter((j) => j.at < now).length;
  const noPlan = week?.matches.filter((m) => m.state === "none").length ?? 0;

  // THE PHONE'S CANCEL RANKING — the desktop matrix's own numbers, flattened and ordered. 1-of-4
  // slots are dropped on the phone only: a list has to be short to be read, and one bad week is
  // not a pattern. The desktop grid still shows them.
  const cancels = useCancelRanking();
  const { all: rankAll, headline: rankTotal, ready: rankReady } = cancels;
  const ranking = useMemo(
    () => rankAll.filter((s) => s.n >= 2).sort((a, b) => b.n - a.n || b.booked - a.booked),
    [rankAll],
  );

  const byCity = useMemo(() => {
    const map = new Map<string, PromoMatch[]>();
    for (const m of week?.matches ?? []) {
      if (!map.has(m.city)) map.set(m.city, []);
      map.get(m.city)!.push(m);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [week]);

  if (loading && !week) return <div className="p-8 text-sm text-deep-green/60">Loading the week…</div>;
  if (error) return <div className="p-8 text-sm text-coral">{error}</div>;
  if (!week) return null;

  if (isMobile) {
    return (
      <MatchPromotionMobile
        week={week} tab={mTab} setTab={setMTab}
        jobs={jobs} overdue={overdue}
        openId={openId} draft={draft} setDraft={setDraft}
        onOpen={openMatch} onClose={closePanel} onSave={() => void save()}
        saving={saving} toast={toast}
        onNav={(d) => void nav(d)} weekLabel={weekLabel(week)}
        fmtPush={fmtPushLocal} leadLabel={leadLabel}
        ranking={ranking} rankingReady={rankReady} rankingTotal={rankTotal}
      />
    );
  }

  return (
    <div className="mx-auto max-w-[1560px] px-4 pb-16">
      <div className="mb-2 text-[10.5px] font-extrabold uppercase tracking-[0.1em] text-deep-green/45">
        Match Ops · Match Promotion
      </div>

      <div className="rounded-2xl border border-cream-line bg-white">
        <div className="flex items-start justify-between gap-5 px-5 pb-3 pt-[18px]">
          <div>
            <h1 className="m-0 text-[28px] font-black uppercase tracking-[-0.03em]">Match Promotion</h1>
            <p className="mt-1.5 max-w-[620px] text-[13px] text-deep-green/65">
Which matches get promoted, on which channels, and when the push goes out.
            </p>
          </div>
        </div>

        {/* week nav + the tabs */}
        <div className="flex flex-wrap items-center gap-2.5 px-5 pb-3.5">
          <button onClick={() => void nav(-1)} className="h-8 w-8 rounded-[9px] border border-cream-line bg-white text-[15px] text-deep-green/65">‹</button>
          <div className="text-[16px] font-extrabold">{weekLabel(week)}</div>
          <button onClick={() => void nav(1)} className="h-8 w-8 rounded-[9px] border border-cream-line bg-white text-[15px] text-deep-green/65">›</button>
          <span className="ml-1.5 inline-flex rounded-full border border-cream-line bg-[#f2f5f3] p-0.5" data-testid="view-tabs">
            {(["plan", "coverage"] as const).map((t) => (
              <button key={t} onClick={() => setTab(t)}
                className={`rounded-full px-3.5 py-[5px] text-[13px] font-bold capitalize ${tab === t ? "bg-deep-green text-white" : "text-deep-green/65"}`}>
                {t}
              </button>
            ))}
          </span>
        </div>

        {!week.planTableReady && (
          <div className="mx-5 mb-4 rounded-[11px] border border-amber-300 bg-amber-50 px-3.5 py-2.5 text-[12.5px] text-amber-900">
            <b>match_promotion_plan is not in the database yet.</b> Every match reads as “no plan”
            until migration 0128 is applied. Saving will refuse rather than pretend.
          </div>
        )}

        {/* ── NEXT 48 HOURS ─────────────────────────────────────────────────────────────────── */}
        <div className="mx-5 mb-4 rounded-[11px] border border-cream-line bg-[#fbfdfc] px-3.5 py-3">
          <div className="mb-2.5 flex items-baseline gap-2.5">
            <span className="text-[9.5px] font-extrabold uppercase tracking-[0.09em] text-deep-green/45">Next 48 hours</span>
            <span className="text-[12px] font-bold text-deep-green/65" data-testid="strip-counts">
              {jobs.length} push{jobs.length === 1 ? "" : "es"} · {overdue} overdue · {noPlan} match{noPlan === 1 ? "" : "es"} with no plan
            </span>
          </div>
          <div className="flex flex-wrap gap-2" data-testid="jobs">
            {jobs.length === 0 && <span className="text-[12px] text-deep-green/40">Nothing scheduled this week.</span>}
            {jobs.map(({ m, at }) => {
              const late = at < now;
              const p = fmtPushLocal(m.plan!.pushAt!);
              return (
                <div key={m.apiId} data-testid="job"
                  className={`flex items-center gap-2.5 rounded-[9px] border px-2.5 py-[7px] text-[12.5px] ${
                    late ? "border-coral/40 bg-coral-soft/40" : "border-cream-line bg-white"}`}>
                  <span className={`whitespace-nowrap text-[12.5px] font-extrabold ${late ? "text-coral" : ""}`}>
                    {late ? "Overdue · " : ""}{p.day} {p.time}
                  </span>
                  <span className="text-deep-green/65">{m.venue} · {DOW[m.dayIdx]} {m.time}</span>
                  {/* ONLY LIT CHANNELS HERE. In a worklist an unsent channel is not work. */}
                  <span className="flex flex-wrap gap-[3px]">
                    {CHANNELS.filter((c) => m.plan!.channels[c.key]).map((c) => (
                      <i key={c.key} className="inline-flex h-[18px] min-w-[24px] items-center justify-center rounded-[5px] border border-mint/40 bg-mint-soft/40 px-1 text-[9.5px] font-extrabold not-italic text-emerald-700">{c.short}</i>
                    ))}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* ONE LIST FOR THE PAGE, ABOVE THE GRID, ON BOTH TABS. Comments are about the week's
            promotion plan, not about a city or a fixture — so they sit here rather than inside a
            match panel, and the same list is present whichever tab is open. */}
        <PageComments weekStart={week.weekStart}
          placeholder="Suggestion about this week — anyone reviewing can add one" />

        {tab === "coverage"
          ? <Coverage week={week} />
          : <Plan week={week} byCity={byCity} openId={openId} onOpen={openMatch}
                   openCity={open?.city ?? null}
                   panel={tab === "plan" && open && draft ? (
            <div className="mb-4 rounded-xl border border-cream-line bg-[#fbfdfc] px-[13px] pb-[9px] pt-[9px]" data-testid="panel">
              <div className="mb-1.5 flex items-baseline gap-2">
                <h3 className="m-0 text-[13.5px] font-extrabold">{open.venue} · {DOW[open.dayIdx]} {open.time}</h3>
                <span className="text-[11.5px] font-bold text-deep-green/45">{open.city}</span>
              </div>
              <div className="grid grid-cols-1 overflow-hidden rounded-[10px] border border-cream-line bg-white md:grid-cols-[1.15fr_1fr_1fr]">
                <div className="border-b border-cream-line px-[13px] pb-[9px] pt-[9px] md:border-b-0 md:border-r">
                  <div className="mb-1 text-[9px] font-extrabold uppercase tracking-[0.09em] text-deep-green/45">Channels</div>
                  <div className="flex flex-col gap-[3px]">
                    {CHANNELS.map((c) => (
                      // The input stays a real checkbox — visually hidden, not replaced — so the
                      // control is still keyboard-reachable and still reports checked state.
                      <label key={c.key} data-testid={`ch-${c.key}`}
                        className="flex cursor-pointer items-center gap-2 text-[12.5px] font-semibold leading-none text-deep-green/70">
                        <input type="checkbox" className="peer sr-only" checked={draft.channels[c.key]}
                          onChange={(e) => setDraft({ ...draft, channels: { ...draft.channels, [c.key]: e.target.checked } })} />
                        <span className="relative h-[17px] w-[30px] flex-none rounded-full bg-[#e6eae8] transition after:absolute after:left-0.5 after:top-0.5 after:h-[13px] after:w-[13px] after:rounded-full after:bg-white after:shadow-sm after:transition peer-checked:bg-mint peer-checked:after:left-[15px]" />
                        {c.label}
                      </label>
                    ))}
                  </div>
                </div>

                <div className="border-b border-cream-line px-[13px] pb-[9px] pt-[9px] md:border-b-0 md:border-r">
                  <div className="mb-1 text-[9px] font-extrabold uppercase tracking-[0.09em] text-deep-green/45">Push</div>
                  <div className="mb-[7px] flex items-center gap-2">
                    <label className="w-12 flex-none text-[12px] font-bold text-deep-green/45">When</label>
                    <input type="datetime-local" data-testid="push-at" value={draft.pushAt}
                      onChange={(e) => setDraft({ ...draft, pushAt: e.target.value })}
                      className="rounded-[7px] border border-cream-line px-2 py-1 text-[12.5px] font-bold" />
                    {/* The lead time is a fragment, not a sentence and not a box. */}
                    <span data-testid="lead"
                      className={`whitespace-nowrap text-[11px] font-bold ${draft.pushAt ? "text-deep-green/45" : "text-amber-700"}`}>
                      {draft.pushAt
                        ? leadLabel(new Date(draft.pushAt).toISOString(), week.weekStart, open.dayIdx, open.minutes)
                        : "needs a decision"}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="w-12 flex-none text-[12px] font-bold text-deep-green/45">Code</label>
                    <input type="text" data-testid="promo-code" value={draft.promoCode} placeholder="none"
                      onChange={(e) => setDraft({ ...draft, promoCode: e.target.value })}
                      className="w-[132px] rounded-[7px] border border-cream-line px-2 py-1 text-[12.5px] font-bold" />
                  </div>
                </div>

              </div>
              <div className="mt-2 flex items-center gap-3">
                <button onClick={() => void save()} disabled={saving} data-testid="save"
                  className="rounded-full bg-deep-green px-[15px] py-1 text-[12.5px] font-extrabold text-white disabled:opacity-50">
                  {saving ? "Saving…" : "Save plan"}
                </button>
                <span onClick={closePanel} className="cursor-pointer text-[12.5px] font-bold text-deep-green/65">Cancel</span>
                {toast && <span className={`text-[12px] font-bold ${toast.bad ? "text-coral" : "text-emerald-700"}`}>{toast.msg}</span>}
              </div>
            </div>
                   ) : null} />}

        {tab === "plan" && (
          <CancelGrid c={cancels} />
        )}
      </div>
      {toast && !open && (
        <div className={`fixed bottom-6 left-1/2 -translate-x-1/2 rounded-full px-4 py-2 text-[13px] font-bold text-white ${toast.bad ? "bg-coral" : "bg-deep-green"}`}>{toast.msg}</div>
      )}
    </div>
  );
}

/** "Mon 17 Aug – Sun 23 Aug" for a Monday ISO date. Built component-wise from the string: these
 *  are calendar dates with no zone, and re-parsing one through a Date with a time is the trap. */
function weekRangeLabel(mondayIso: string): string {
  const [y, m, d] = mondayIso.split("-").map(Number);
  if (!y || !m || !d) return mondayIso;
  const mon = new Date(y, m - 1, d);
  const sun = new Date(y, m - 1, d + 6);
  const M = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${DOW[0]} ${mon.getDate()} ${M[mon.getMonth()]} – ${DOW[6]} ${sun.getDate()} ${M[sun.getMonth()]}`;
}

function weekLabel(w: PromoWeek): string {
  const [y, m, d] = w.weekStart.split("-").map(Number);
  const mon = new Date(y, m - 1, d);
  const sun = new Date(y, m - 1, d + 6);
  const M = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${DOW[0]} ${mon.getDate()} ${M[mon.getMonth()]} – ${DOW[6]} ${sun.getDate()} ${M[sun.getMonth()]} ${sun.getFullYear()}`;
}

/* ── THE WEEK ───────────────────────────────────────────────────────────────────────────────── */
function Plan({ week, byCity, openId, onOpen, openCity, panel }: {
  week: PromoWeek; byCity: [string, PromoMatch[]][]; openId: number | null;
  onOpen: (m: PromoMatch, el: HTMLElement) => void;
  // THE PANEL OPENS INLINE, UNDER THE CITY WHOSE TILE WAS CLICKED — not at the foot of the page.
  // Rendering it once at page level meant clicking an Atlanta match scrolled you past every other
  // city to reach the editor. A panel that is correct but a page away is the bug.
  openCity: string | null; panel: React.ReactNode;
}) {
  const priorLabel = weekRangeLabel(week.priorWeekStart);
  return (
    <>
      <div className="px-5 pb-0.5 pt-1">
        <h2 className="m-0 text-[15px] font-extrabold uppercase tracking-[0.02em]">The week</h2>
        <p className="mt-1.5 max-w-[930px] text-[12.5px] text-deep-green/65">
          Click a match to plan it. A tile shows only what is planned — a channel chip means that
          channel is selected, and a tile with nothing on it has no plan.
        </p>
        {/* THE RULE, ON THE PAGE. Marketing has to be able to read what NEW means without asking,
            and printing the dates it compared makes a wrong week visible instead of silent. */}
        <p className="mt-1.5 max-w-[930px] text-[12.5px] text-deep-green/65" data-testid="new-rule">
          <b className="rounded-[4px] bg-deep-green px-[5px] py-px text-[8.5px] font-extrabold tracking-[0.04em] text-white align-[2px]">NEW</b>{" "}
          marks a slot that was not on <b>last week&apos;s slate for the same city</b> — the same seven
          weekdays one week earlier ({priorLabel}), <b>including matches that were cancelled</b>,
          because a cancelled slot was still scheduled and still published. Compared per field:{" "}
          <b>NEW FIELD</b>{" "}the pitch is new to the city, <b>NEW DAY</b>{" "}the pitch is not new but this
          weekday is, <b>NEW TIME</b>{" "}the pitch and weekday ran but at another time. Nothing here
          reads a match&apos;s creation date — a match booked last month for a slot that has never run
          is still new to a player.
        </p>
      </div>
      {byCity.map(([city, matches]) => {
        const planned = matches.filter((m) => m.state === "planned").length;
        const check = matches.filter((m) => m.state === "needs-decision").length;
        const none = matches.filter((m) => m.state === "none").length;
        // Counted from the SAME rows the grid renders, so the header can never describe a
        // different set of tiles than the one below it.
        const fresh = matches.filter((m) => m.newFlag !== null).length;
        return (
          <div key={city} className="px-5 pb-1" data-testid="city-block">
            <div className="flex items-baseline gap-2.5 pb-2 pt-3">
              <h2 className="m-0 text-[15px] font-extrabold">{city}</h2>
              <span className="text-[11.5px] font-bold text-deep-green/45">
                {planned} planned{check ? ` · ${check} needs a decision` : ""}{none ? ` · ${none} no plan` : ""}
              </span>
              {fresh > 0 && (
                <span className="text-[11.5px] font-extrabold text-deep-green" data-testid="city-new-count">
                  {fresh} new
                </span>
              )}
            </div>
            <div className="grid grid-cols-7 gap-2 pb-2.5">
              {week.days.map((d, i) => {
                const dayMatches = matches.filter((m) => m.dayIdx === i);
                return (
                  <div key={d.iso} data-testid="day-cell"
                    className={`min-h-[96px] rounded-[11px] border bg-white p-2 ${d.today ? "border-mint shadow-[0_0_0_2px_var(--color-mint-soft,#effaf3)]" : "border-cream-line"}`}>
                    <div className="mb-[7px] flex items-baseline justify-between text-[9.5px] font-extrabold uppercase tracking-[0.08em] text-deep-green/45">
                      <span>{d.dow}</span><b className="text-[12.5px] tracking-normal text-deep-green/65">{d.date}</b>
                    </div>
                    {dayMatches.length === 0 && <div className="pt-1.5 text-[11.5px] text-deep-green/30">No sessions</div>}
                    {dayMatches.map((m) => <Tile key={m.apiId} m={m} open={m.apiId === openId} onOpen={onOpen} weekStart={week.weekStart} />)}
                  </div>
                );
              })}
            </div>
            {city === openCity && panel}
          </div>
        );
      })}
    </>
  );
}

/* THE TILE SHOWS WHAT IS THERE, AND NOTHING ELSE.
 *
 * It used to render all six channel chips, a "No code" pill and a "No push planned" line on EVERY
 * tile — three rows of chrome on 109 matches, of which the great majority carry no plan at all. An
 * unlit chip, an absent code and an absent push are all the same fact stated three times, and the
 * city header already counts planned against no-plan.
 *
 * SO: a chip appears only when its channel is selected, the code pill only when there is a code,
 * and the push line only when there is something to say. A tile with no plan is the time, the
 * field, and — if it is new — its badge.
 *
 * PLANNED TILES STAY DISTINCT BY WEIGHT, NOT BY LABEL. A tile with a plan carries chips and a push
 * line and a solid left rail; a tile without carries a dashed border and almost no ink. The eye
 * finds the planned ones because they are the only ones with anything in them. */
function Tile({ m, open, onOpen, weekStart }: { m: PromoMatch; open: boolean; onOpen: (m: PromoMatch, el: HTMLElement) => void; weekStart: string }) {
  const lit = CHANNELS.filter((c) => m.plan?.channels[c.key] === true);
  const border =
    m.state === "needs-decision" ? "border-amber-300 bg-amber-50"
    : m.state === "none" ? "border-dashed border-cream-line"
    : "border-cream-line border-l-[3px] border-l-mint";
  return (
    <div data-testid="match-tile" data-state={m.state} data-api-id={m.apiId} data-open={open ? "1" : "0"}
      data-new={m.newFlag ?? ""}
      onClick={(e) => onOpen(m, e.currentTarget as HTMLElement)}
      className={`mb-1.5 cursor-pointer rounded-[9px] border bg-white p-[7px_8px] last:mb-0 ${border} ${open ? "border-deep-green shadow-[0_0_0_2px_#e6efe9]" : ""}`}>
      <div className="flex items-baseline justify-between gap-1.5">
        <span className="text-[12.5px] font-extrabold">{m.time}</span>
        {m.newFlag && (
          <i data-testid="new-badge" data-flag={m.newFlag}
            title={`This ${m.newFlag === "field" ? "field" : m.newFlag === "day" ? "weekday for this field" : "kick-off time for this field and weekday"} was not on last week's slate for ${m.city}.`}
            className="shrink-0 rounded-[4px] bg-deep-green px-[5px] py-px text-[8.5px] font-extrabold not-italic tracking-[0.04em] text-white">
            {NEW_FLAG_LABEL[m.newFlag]}
          </i>
        )}
      </div>
      <div className="mt-px text-[11px] leading-[1.25] text-deep-green/65">{m.venue}</div>
      {/* ONLY THE LIT CHANNELS. flex-wrap + min-w-0 still stops the widest chip running off the
          tile edge at seven columns — the failure this layout had before, and the reason the
          overflow measurement in verify-match-promotion is kept. */}
      {(lit.length > 0 || m.plan?.promoCode) && (
        <div className="mt-[5px] flex min-w-0 flex-wrap items-center gap-1.5">
          {lit.length > 0 && (
            <span className="flex min-w-0 flex-wrap gap-[3px]" data-testid="chipset">
              {lit.map((c) => (
                <i key={c.key} data-testid="chip" data-on="1"
                  className="inline-flex h-[18px] min-w-[24px] items-center justify-center rounded-[5px] border border-mint/40 bg-mint-soft/40 px-1 text-[9.5px] font-extrabold not-italic text-emerald-700">
                  {c.short}
                </i>
              ))}
            </span>
          )}
          {m.plan?.promoCode && (
            <span className="rounded-[5px] border border-amber-300 bg-amber-50 px-[5px] py-px text-[9.5px] font-extrabold text-amber-800">
              {m.plan.promoCode}
            </span>
          )}
        </div>
      )}
      {/* NO "No push planned". An empty tile already says it, and the city header counts it. */}
      {m.state === "planned" && m.plan?.pushAt && (
        <div className="mt-[5px] text-[10px] font-bold text-deep-green/45">
          Push <b className="text-deep-green/70">{fmtPushLocal(m.plan.pushAt).day} {fmtPushLocal(m.plan.pushAt).time}</b> · {leadLabel(m.plan.pushAt, weekStart, m.dayIdx, m.minutes)}
        </div>
      )}
      {m.state === "needs-decision" && (
        <div className="mt-[5px] text-[10px] font-bold text-amber-700">Needs a decision · no push date set</div>
      )}
    </div>
  );
}

/* ── COVERAGE ─────────────────────────────────────────────────────────────────────────────────
 *
 * COLOUR MARKS THE EXCEPTION. Every open cell used to be a filled coral block reading OPEN, so on
 * a week with no plans at all — which is most of them before anyone starts — the entire grid was
 * coral and the colour said nothing. See the note on coverageSummary in lib/matchPromotion.
 *
 * THE COVERED CELL IS THE LOUD ONE, always: mint fill, mint rail, the push time and its channels.
 * An open cell is quiet — its field and time in normal weight, with a thin coral edge ONLY when
 * there is coverage for it to be an exception to.
 *
 * THE DISTINCTION THIS VIEW EXISTS FOR IS CARRIED BY CONTENT, NOT COLOUR: an open cell prints a
 * field and a time, an empty one prints a dash. That holds when nothing is coloured at all. */
function Coverage({ week }: { week: PromoWeek }) {
  const cities = [...new Set(week.matches.map((m) => m.city))].sort();
  const summary = coverageSummary(week);
  return (
    <>
      <div className="px-5 pb-0.5 pt-1">
        <h2 className="m-0 text-[15px] font-extrabold uppercase tracking-[0.02em]">Push coverage</h2>
        {/* SAID ONCE, ABOVE THE GRID, RATHER THAN IN EVERY CELL. */}
        <p className={`mt-1.5 max-w-[930px] text-[12.5px] ${summary.anyPlanned ? "text-deep-green/65" : "font-bold text-deep-green"}`}
          data-testid="coverage-caption" data-any-planned={summary.anyPlanned ? "1" : "0"}>
          {coverageCaption(summary)}
        </p>
        {summary.anyPlanned && (
          <p className="mt-1 max-w-[930px] text-[12px] text-deep-green/55">
            A mint cell is covered. A coral edge is a day with matches and no push. A dash is a day
            with no matches.
          </p>
        )}
      </div>
      <div className="mx-5 mb-1.5 overflow-x-auto">
        <table className="w-full table-fixed border-collapse" data-testid="coverage-grid">
          <colgroup><col className="w-24" />{week.days.map((d) => <col key={d.iso} />)}</colgroup>
          <thead>
            <tr>
              <th className="border-b border-cream-line px-2.5 py-2 text-left text-[10px] font-extrabold uppercase tracking-[0.08em] text-deep-green/45">Push</th>
              {week.days.map((d) => (
                <th key={d.iso} className="whitespace-nowrap border-b border-cream-line px-2.5 py-2 text-left text-[10px] font-extrabold uppercase tracking-[0.08em] text-deep-green/45">{d.dow} {d.date}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cities.map((city) => (
              <tr key={city} data-testid="coverage-row">
                <td className="border-b border-cream-line/60 py-1.5 pl-0.5 align-middle text-[12.5px] font-extrabold tracking-[0.03em]">{city}</td>
                {week.days.map((d, i) => {
                  const dayMatches = week.matches.filter((m) => m.city === city && m.dayIdx === i);
                  const planned = dayMatches.filter((m) => m.plan?.pushAt);
                  const state = coverageStateOf(dayMatches);
                  if (state === "none") {
                    return <td key={d.iso} data-testid="coverage-day" data-cov="none" className="border-b border-l border-cream-line/60 p-1.5 align-top"><span className="block py-2 text-center text-[13px] text-deep-green/25">—</span></td>;
                  }
                  if (state === "open") {
                    return (
                      <td key={d.iso} data-testid="coverage-day" data-cov="open" className="border-b border-l border-cream-line/60 p-1.5 align-top">
                        {/* NORMAL WEIGHT, NO FILL, NO "OPEN". The thin coral edge appears only when
                            some day in the week IS covered — otherwise open is the rule, not the
                            exception, and the caption above has already said so once. */}
                        <div data-testid="coverage-open" data-marked={summary.anyPlanned ? "1" : "0"}
                          className={`px-2 py-1.5 ${summary.anyPlanned ? "rounded-r-lg border-l-2 border-coral/70 bg-coral-soft/20" : ""}`}>
                          <div className="text-[11.5px] leading-[1.2] text-deep-green/80">{dayMatches[0].venue}</div>
                          <div className="mt-px text-[10.5px] text-deep-green/55">
                            {dayMatches[0].time}
                            {dayMatches.length > 1 && <span className="text-deep-green/40"> · +{dayMatches.length - 1} more</span>}
                          </div>
                        </div>
                      </td>
                    );
                  }
                  return (
                    <td key={d.iso} data-testid="coverage-day" data-cov="planned" className="border-b border-l border-cream-line/60 p-1.5 align-top">
                      {/* THE ONE THE EYE SHOULD LAND ON — the only filled cell in the grid. */}
                      {planned.map((m) => (
                        <div key={m.apiId} data-testid="coverage-cell" className="mb-1 rounded-lg border-l-[3px] border-mint bg-mint-soft/60 px-2 py-1.5 last:mb-0">
                          <div className="text-[11.5px] font-extrabold leading-[1.2]">{m.venue}</div>
                          <div className="mb-1 mt-px text-[10.5px] text-deep-green/65">
                            {m.time} · push {fmtPushLocal(m.plan!.pushAt!).day} {fmtPushLocal(m.plan!.pushAt!).time}
                          </div>
                          <span className="flex flex-wrap gap-[2px]">
                            {CHANNELS.filter((c) => m.plan!.channels[c.key]).map((c) => (
                              <i key={c.key} className="inline-flex h-[15px] min-w-[22px] items-center justify-center rounded-[5px] border border-mint/40 bg-mint-soft/40 px-[3px] text-[8.5px] font-extrabold not-italic text-emerald-700">{c.short}</i>
                            ))}
                          </span>
                        </div>
                      ))}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ── CANCEL PATTERNS ────────────────────────────────────────────────────────────────────────── */
const TIER: Record<number, string> = {
  4: "bg-[#c0392b] text-white",
  3: "bg-[#7d3220] text-white",
  2: "bg-[#e6a532] text-[#3d2a05]",
  1: "bg-[#eef0ee] text-deep-green/65 border border-cream-line",
};

/**
 * THE WINDOW, DERIVED. The mockup prints "Jul 20 – Aug 16" because a mockup is a photograph; on a
 * live page a hardcoded range is a lie from next Monday. Anchored on the SAME helper
 * getCancelPatterns uses, so the caption cannot drift from the data underneath it.
 */
function cancelWindowLabel(now: Date = new Date()): string {
  const M = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const newest = mostRecentCompletedWeekMonday(now);
  const from = new Date(newest.getFullYear(), newest.getMonth(), newest.getDate() - 21);
  const to = new Date(newest.getFullYear(), newest.getMonth(), newest.getDate() + 6);
  return `${M[from.getMonth()]} ${from.getDate()} – ${M[to.getMonth()]} ${to.getDate()}`;
}

/**
 * ONE DERIVATION, TWO LAYOUTS. The desktop matrix and the phone ranking are the same numbers seen
 * two ways, so the computation is lifted here rather than written twice. The body below is the
 * memo that used to sit inside CancelGrid, moved verbatim — desktop renders from exactly what it
 * rendered from before.
 */
export function useCancelRanking() {
  const { rows, meta, loading } = useMatchData();
  const { data: finData } = useFinanceData();
  const aliases = useMemo(() => finData?.venueAliases ?? new Map<string, string>(), [finData]);

  // One call per city — getCancelPatterns is city-agnostic, so scoping the rows before it sees them
  // is how CancelPatterns.tsx does it too. Folded here into ONE grid: city down, weekday across.
  const cities = useMemo(() => [...new Set(rows.map((r) => r.city).filter(Boolean))].sort(), [rows]);
  const grid = useMemo(() => {
    return cities.map((city) => {
      const res = getCancelPatterns(rows.filter((r) => r.city === city), aliases, "patterns");
      // Fold the four weeks into one row: a slot appears once per weekday, carrying its cancelCount
      // (identical on every pill of that slot) and the largest booked count seen.
      const byDay: { code: string; canonical: string; time: string; booked: number; n: number; slot: string }[][] =
        [[], [], [], [], [], [], []];
      const seen = new Set<string>();
      for (const w of res.weeks) {
        for (let d = 0; d < 7; d++) {
          for (const s of w.byDay[d]) {
            const key = `${s.canonicalField}|${d}|${s.timeMinutes}`;
            if (seen.has(key)) {
              const found = byDay[d].find((x) => x.slot === key);
              if (found) found.booked = Math.max(found.booked, s.bookedCount);
              continue;
            }
            seen.add(key);
            byDay[d].push({
              code: s.venueCode, canonical: s.canonicalField, time: s.time,
              booked: s.bookedCount, n: s.cancelCount, slot: key,
            });
          }
        }
      }
      for (const d of byDay) d.sort((a, b) => b.n - a.n || a.time.localeCompare(b.time));
      const total = byDay.flat().length;
      return { city, byDay, total };
    }).filter((c) => c.total > 0);
  }, [cities, rows, aliases]);

  const headline = grid.reduce((s, c) => s + c.total, 0);
  const all = grid.flatMap((c) => c.byDay.flat().map((s) => ({ ...s, city: c.city })));
  const worst = all.slice().sort((a, b) => b.n - a.n || b.booked - a.booked)[0] ?? null;
  const worstDay = useMemo(() => {
    const c = [0, 0, 0, 0, 0, 0, 0];
    for (const g of grid) g.byDay.forEach((d, i) => { c[i] += d.length; });
    const max = Math.max(...c);
    return max === 0 ? null : { dow: DOW[c.indexOf(max)], n: max };
  }, [grid]);

  return { grid, all, headline, worst, worstDay, ready: !loading && !!meta };
}

/** Desktop matrix. Takes the derivation as a prop so it is computed once for both layouts. */
function CancelGrid({ c }: { c: ReturnType<typeof useCancelRanking> }) {
  const { grid, headline, worst, worstDay, ready } = c;
  if (!ready) return <div className="px-5 py-6 text-[12.5px] text-deep-green/45">Loading cancel patterns…</div>;

  return (
    <div data-testid="cancel-patterns">
      <div className="mt-2 border-t border-cream-line px-5 pb-0.5 pt-5">
        <h2 className="m-0 text-[15px] font-extrabold uppercase tracking-[0.02em]">Cancel patterns</h2>
        <p className="mt-1.5 max-w-[930px] text-[12.5px] text-deep-green/65">
Last 4 completed weeks · Jul 20 – Aug 16. Chip reads field, time, spots booked, and how many
          of the four weeks it died.
        </p>
      </div>

      <div className="mx-5 mt-3 grid grid-cols-1 overflow-hidden rounded-[11px] border border-cream-line bg-white md:grid-cols-3">
        <Stat label="Cancelled slots" value={String(headline)} note={`over 4 weeks · ${grid.length} cities`} testid="stat-total" />
        <Stat label="Worst slot" small value={worst ? `${worst.canonical} · ${DOW[Number(worst.slot.split("|")[1])]} ${worst.time}` : "—"}
          note={worst ? `${worst.n} of 4 weeks · ${worst.booked} spots booked` : ""} testid="stat-worst" />
        <Stat label="Worst day" small value={worstDay?.dow ?? "—"} note={worstDay ? `${worstDay.n} cancelled slots` : ""} testid="stat-worstday" />
      </div>

      <div className="mx-5 mt-3 overflow-x-auto">
        <table className="w-full table-fixed border-collapse">
          <colgroup><col className="w-28" />{DOW.map((d) => <col key={d} />)}</colgroup>
          <thead>
            <tr>
              <th className="border-b border-cream-line px-2.5 py-2.5 text-left text-[10px] font-extrabold uppercase tracking-[0.08em] text-deep-green/45">City</th>
              {DOW.map((d) => <th key={d} className="border-b border-cream-line px-2.5 py-2.5 text-left text-[10px] font-extrabold uppercase tracking-[0.08em] text-deep-green/45">{d}</th>)}
            </tr>
          </thead>
          <tbody>
            {grid.map((c) => (
              <tr key={c.city} data-testid="cancel-row">
                <td className="border-b border-cream-line/60 py-2 pl-0.5 align-middle">
                  <div className="text-[12.5px] font-extrabold tracking-[0.03em]">{c.city}</div>
                  <div className="mt-px text-[10.5px] font-bold text-deep-green/45" data-testid="cancel-row-count">{c.total} slots</div>
                </td>
                {c.byDay.map((day, i) => (
                  <td key={i} className="border-b border-l border-cream-line/60 p-2 align-top">
                    {day.length === 0 && <span className="block py-1.5 text-center text-[13px] text-deep-green/25">—</span>}
                    {day.map((s) => (
                        <div key={s.slot} data-testid="cancel-chip"
                          className={`mb-1 flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[10.5px] leading-[1.15] last:mb-0 ${TIER[s.n]}`}>
                          <span className="font-extrabold tracking-[0.02em]">{s.code}</span>
                          <span className="font-semibold opacity-90">{s.time}</span>
                          <span className="ml-auto font-bold opacity-80">{s.booked}</span>
                          {/* N OF 4 AS TEXT, not shade alone — 3/4 against 2/4 is unreadable across a
                              wide screen and gone entirely in print. */}
                          <span className={`whitespace-nowrap rounded px-1 font-extrabold ${s.n >= 3 ? "bg-white/25" : "bg-black/10"}`}>{s.n}/4</span>
                        </div>
                    ))}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-4 px-5 py-3 text-[12px] text-deep-green/65">
        {[4, 3, 2, 1].map((t) => (
          <span key={t} className="flex items-center gap-1.5">
            <i className={`inline-block h-3 w-5.5 rounded ${TIER[t]}`} style={{ width: 22, height: 12 }} />
            {t === 4 ? "cancelled all 4 weeks" : t === 1 ? "1 of 4 — once" : `${t} of 4`}
          </span>
        ))}
        <span className="text-deep-green/45">The number to the right of each chip is spots already booked when it died.</span>
      </div>
    </div>
  );
}

function Stat({ label, value, note, small, testid }: { label: string; value: string; note: string; small?: boolean; testid: string }) {
  return (
    <div className="border-r border-cream-line px-3.5 py-2.5 last:border-r-0">
      <div className="text-[9.5px] font-extrabold uppercase tracking-[0.09em] text-deep-green/45">{label}</div>
      <div data-testid={testid} className={`mt-0.5 font-extrabold tracking-[-0.02em] ${small ? "text-[16px]" : "text-[22px]"}`}>{value}</div>
      <div className="mt-0.5 text-[11.5px] text-deep-green/65">{note}</div>
    </div>
  );
}
