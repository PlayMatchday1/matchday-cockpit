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
import { getCancelPatterns, rollUpSlotRisk, clustersForField, slotRiskKey, type SlotRisk } from "@/lib/cancelPatterns";
import { normalizeMatchName } from "@/lib/venueNormalization";
import { TAG_KEYS, TAG_META, splitTags, tagsInUse, isTagKey, type TagKey } from "@/lib/promoTags";
import { weekQueueEntries, weekQueues, isPastWeek, defaultDayIdx, tabCounts, type QueueEntry } from "@/lib/promoDayQueue";
import {
  CHANNELS, NEW_FLAG_LABEL, channelsOn, codeFor, coverageCaption, coverageStateOf, coverageSummary,
  coverageOf, coverLabel, generalsCovering, generalPushDayIdx, type GeneralPush,
  datedPushes, draftFromPlan, draftToPushes, fmtPushIn, isPushOverdue, isPushSent, leadToKickoff,
  sentStamp, venueOffsetMs,
  type PromoMatch, type PromoPush, type PromoWeek, type PushDraft, type ZoneMode,
} from "@/lib/matchPromotion";
import MarkPushSent from "@/components/MarkPushSent";
import PushPlanEditor from "@/components/PushPlanEditor";

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

/** This match's own venue offset, derived from its own wall/UTC pair. Never a map, never a guess. */
const offsetOf = (m: PromoMatch): number | null => venueOffsetMs(m.startDate ?? null, m.startDateUtc);

/** One push, in whichever clock is on screen. */
const fmtPush = (m: PromoMatch, p: PromoPush, zone: ZoneMode) => fmtPushIn(p.pushAt, zone, offsetOf(m));

/** The lead time, which is timezone free — two instants subtracted. */
const leadOf = (m: PromoMatch, p: PromoPush): string => leadToKickoff(p.pushAt, m.startDateUtc)?.text ?? "";

/* THE TILE SUMMARISES, IT DOES NOT LIST SIX LINES. First push, then how many more. A match can now
 * carry three channels and five dates; printing all of them turns a 96px day cell into a page. */
function tileSummary(m: PromoMatch, zone: ZoneMode): { first: string; lead: string; more: number } | null {
  const all = datedPushes(m.plan);
  if (all.length === 0) return null;
  const f = fmtPush(m, all[0], zone);
  return { first: `${f.day} ${f.time}`, lead: leadOf(m, all[0]), more: all.length - 1 };
}

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
  const [draft, setDraft] = useState<PushDraft | null>(null);
  /* THE ZONE IS PAGE STATE, NOT PANEL STATE. The strip, the tiles and the editor all print push
   * instants, and three of them disagreeing about which clock they are in is the failure this
   * whole feature exists to prevent. The CONTROL lives in the editor; the ANSWER lives here. */
  const [zone, setZone] = useState<ZoneMode>("me");
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
    anchor(el, () => { setOpenId(m.apiId); setDraft(draftFromPlan(m.plan)); });
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
          /* THE COMPLETE SET, EVERY CHANNEL. The route replaces this match's rows with exactly
           * this list, so a channel left out is a channel deleted — which is what turning one off
           * means. Sending a diff instead would make "off" unrepresentable. */
          pushes: draftToPushes(draft),
          /* match_promotion_plan.comment IS NO LONGER WRITTEN, and from 0176 neither are its six
           * booleans, push_at, promo_code, pushed_at or pushed_by. They are inert. A column
           * nothing reads and something still writes is exactly the drift 0176 exists to end. */
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
  /* ONE ENTRY PER PUSH, NOT PER MATCH. A match with three pushes is three lines of work, each with
   * its own time, its own topic and its own sent state — which is the whole point of 0176. */
  /* THE PHONE'S DUE LIST READS THE SAME SOURCE THE DESKTOP QUEUE DOES. It flattened
   * week.matches itself before, which meant a general push — a row with no match — existed on the
   * desktop queue and nowhere on the phone. One derivation, both surfaces: weekQueueEntries is
   * where a push being in the week is decided, and this is the only consumer of `jobs`. */
  const jobs = useMemo<QueueEntry[]>(() =>
    (week ? weekQueueEntries(week).sort((a, b) => a.at - b.at) : []), [week]);
  const now = Date.now();
  /* OVERDUE IS push_at IN THE PAST AND NOT YET SENT, PER PUSH. Marking the WhatsApp one sent
   * leaves the Klaviyo one overdue, because they are separate rows with separate stamps. */
  const overdue = jobs.filter((j) => isPushOverdue(j.p, now)).length;
  const sentCount = jobs.filter((j) => isPushSent(j.p)).length;
  /* ── COVERAGE, DERIVED ONCE ──────────────────────────────────────────────────────────────
   * The tile's rail, the city header's three figures and the page headline all read THIS map, so
   * they cannot disagree about which matches a general push carried. A second derivation is how a
   * header and the tiles under it end up describing different sets. */
  const coverage = useMemo(() => {
    const out = new Map<number, ReturnType<typeof coverageOf>>();
    if (!week) return out;
    for (const m of week.matches) out.set(m.apiId, coverageOf(m, week.generals, week.days));
    return out;
  }, [week]);
  const coversOf = useCallback((m: PromoMatch) => (week ? generalsCovering(m, week.generals, week.days) : []), [week]);
  /* TAGS ARE KEYED ON THE FIELD, so a pitch reads the same on every tile it appears on rather than
   * being re-tagged each week. A match with no field simply has none. */
  const tagsOf = useCallback((m: PromoMatch): TagKey[] => {
    const raw = m.fieldId != null ? (week?.tagsByField?.[m.fieldId] ?? []) : [];
    return raw.filter(isTagKey);
  }, [week]);
  const [genCity, setGenCity] = useState<string | null>(null);
  const openGeneral = useCallback((city: string) => setGenCity(city), []);

  /* ONE WRITE PER TAG, ADDRESSED TO THE FIELD. Not a bulk save: a tag is a single fact and the
   * unique constraint from 0190 makes the toggle safe against two operators at once. */
  const postPromo = useCallback(async (body: unknown) => {
    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;
    const res = await fetch("/api/match-promotion", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    return { res, j: await res.json().catch(() => ({} as Record<string, unknown>)) };
  }, []);

  const toggleTag = useCallback(async (fieldId: number, tag: TagKey, on: boolean) => {
    setSaving(true);
    try {
      const { res, j } = await postPromo({ tag: { fieldId, tag, on } });
      if (!res.ok || j?.outcome !== "LANDED") {
        setToast({ msg: String(j?.error ?? "That tag did not save."), bad: true });
        return;
      }
      await load(weekRef);
    } finally { setSaving(false); }
  }, [postPromo, weekRef]);

  /* THE HEADLINE, COUNTED UP. `liveCount` excludes cancelled matches: a match that was called off
   * is not a plan anybody still owes, and counting it would make the fraction unreachable. */
  const liveCount = week?.matches.filter((m) => m.state !== "cancelled").length ?? 0;
  /* OWN PUSH PLUS COVERED. A match a general push carried is promoted; counting only its own
   * push would report the week as emptier than it is, which is the failure the positive count was
   * introduced to avoid in the first place. */
  const withPush = week?.matches.filter((m) => {
    const c = coverage.get(m.apiId);
    return c === "planned" || c === "needs-decision" || c === "covered";
  }).length ?? 0;

  // THE PHONE'S CANCEL RANKING — the desktop matrix's own numbers, flattened and ordered. 1-of-4
  // slots are dropped on the phone only: a list has to be short to be read, and one bad week is
  // not a pattern. The desktop grid still shows them.
  /* THE TILE'S CANCEL HISTORY, ANCHORED ON THE WEEK BEING DISPLAYED.
   *
   * cancelPatterns anchors on the last four FULLY COMPLETED weeks relative to a date, so anchoring
   * on TODAY meant that while the current week was on screen every cancellation in front of the
   * operator was outside the window by construction. Live on Sep 21-27: Keswick Park cancelled on
   * the Monday with 9 booked and its chip was empty, while the same field's Friday tile read 1/4
   * from an earlier Friday. Both counts were correct and together they read as broken.
   *
   * Anchoring on the displayed week's Monday makes the chip mean "before the week you are looking
   * at", which is the only reading that survives sitting beside a cancellation, and it steps back
   * with the arrow. It is also MORE deterministic than the default: mostRecentCompletedWeekMonday
   * has a lenient-Sunday special case, and a Monday is never a Sunday, so that branch can never
   * fire here.
   *
   * getCancelPatterns' own default is untouched — the anchor is passed in. */
  const cancels = useTileCancelHistory(week?.weekStart ?? null);
  /* THE TILE'S CANCEL HISTORY. getCancelPatterns keys a slot on (field, weekday, TIME), so a slate
   * time that moves orphans its own history and a chronically cancelled slot renders clean —
   * Ryan's "sometimes that one is hard as it has slate no longer active". rollUpSlotRisk re-keys
   * on field and weekday with the times CLUSTERED rather than dropped; see cancelPatterns.ts for
   * the measurement that ruled dropping them out. getCancelPatterns itself is untouched. */
  const riskByKey = useMemo(() => {
    if (!cancels.ready || !cancels.result) return new Map<string, SlotRisk>();
    return rollUpSlotRisk(cancels.result);
  }, [cancels.ready, cancels.result]);
  const riskOf = useCallback((m: PromoMatch): SlotRisk | null => {
    if (!cancels.ready || !cancels.result) return null;
    const canonical = cancels.canonicalOf(m.fieldRaw);
    if (!canonical) return null;
    const clusters = clustersForField(cancels.result, canonical, m.dayIdx);
    return riskByKey.get(slotRiskKey(canonical, m.dayIdx, m.minutes, clusters)) ?? null;
  }, [cancels, riskByKey]);

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
        jobs={jobs} overdue={overdue} onReload={() => load(weekRef)} riskOf={riskOf}
        coverOf={(m) => coverage.get(m.apiId) ?? "none"} coversOf={coversOf} tagsOf={tagsOf}
        openId={openId} draft={draft} setDraft={setDraft}
        onOpen={openMatch} onClose={closePanel} onSave={() => void save()}
        saving={saving} toast={toast}
        onNav={(d) => void nav(d)} weekLabel={weekLabel(week)}
        zone={zone} setZone={setZone} onError={(msg) => setToast({ msg, bad: true })}
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
                className={`min-h-[32px] rounded-full px-3.5 py-[5px] text-[13px] font-bold capitalize ${tab === t ? "bg-deep-green text-white" : "text-deep-green/65"}`}>
                {t}
              </button>
            ))}
          </span>
        </div>

        {!week.planTableReady && (
          <div className="mx-5 mb-4 rounded-[11px] border border-amber-300 bg-amber-50 px-3.5 py-2.5 text-[12.5px] text-amber-900">
            <b>match_promotion_push is not in the database yet.</b> Every match reads as “no plan”
            until migration 0176 is applied. Saving will refuse rather than pretend.
          </div>
        )}

        {/* ── THE DAY QUEUE ─────────────────────────────────────────────────────────────────
            Ryan: "Maybe it should show matches of the day to push, with a way to easily change the
            day, defaulting to the current day, and tab between days" and "the top part is where
            you see the planned pushes and the operator can mark if they are sent, or if it's past
            due it will show."

            IT REPLACES THE 48-HOUR STRIP, which was one flat list of every push in the week — the
            "ugly and long" list. Same pushes, same Mark sent control, grouped by day with past due
            first and the sent ones folded away.

            IT CREATES NOTHING. The plans are made on the week below; a second way to create a push
            is how two sources of truth start. */}
        <DayQueue week={week} zone={zone} onMarked={() => load(weekRef)}
          onError={(msg) => setToast({ msg, bad: true })} withPush={withPush} liveCount={liveCount} />

        {/* ONE LIST FOR THE PAGE, ABOVE THE GRID, ON BOTH TABS. Comments are about the week's
            promotion plan, not about a city or a fixture — so they sit here rather than inside a
            match panel, and the same list is present whichever tab is open. */}
        <PageComments weekStart={week.weekStart}
          placeholder="Suggestion about this week — anyone reviewing can add one" />

        {tab === "coverage"
          ? <Coverage week={week} zone={zone} />
          : <Plan week={week} byCity={byCity} openId={openId} onOpen={openMatch}
                   openCity={open?.city ?? null} zone={zone} riskOf={riskOf}
                   coverage={coverage} coversOf={coversOf} tagsOf={tagsOf} onAddGeneral={openGeneral}
                   panel={tab === "plan" && open && draft ? (
            <div className="mb-4 rounded-xl border border-cream-line bg-[#fbfdfc] px-[13px] pb-[9px] pt-[9px]" data-testid="panel">
              <div className="mb-1.5 flex items-baseline gap-2">
                <h3 className="m-0 text-[13.5px] font-extrabold">{open.venue} · {DOW[open.dayIdx]} {open.time}</h3>
                <span className="text-[11.5px] font-bold text-deep-green/45">{open.city}</span>
              </div>
              {/* ── TAGS ARE SET HERE, NOT FROM A PILL ON THE TILE ────────────────────────────
                  A "+ tag" control sized to sit beside the others is a 14px tap target, which is a
                  fake affordance. The tile already opens this panel on click, so the toggles live
                  where there is room for them to be pressed. Keyed on the FIELD: tagging this match
                  tags the pitch, on every tile it appears on, this week and next. */}
              {open.fieldId != null && (
                <div className="mb-2 flex flex-wrap items-center gap-1.5" data-testid="tag-editor">
                  <span className="text-[10px] font-extrabold uppercase tracking-[0.08em] text-deep-green/45">Field tags</span>
                  {TAG_KEYS.map((t) => {
                    const on = tagsOf(open).includes(t);
                    return (
                      <button key={t} type="button" data-testid="tag-toggle" data-t={t} data-on={on ? "1" : "0"}
                        disabled={saving} title={TAG_META[t].meaning}
                        onClick={() => void toggleTag(open.fieldId as number, t, !on)}
                        className="min-h-[32px] rounded-[7px] border px-2.5 text-[11px] font-extrabold tracking-[0.03em]"
                        style={on
                          ? { color: "#fff", background: TAG_META[t].colour, borderColor: TAG_META[t].colour }
                          : { color: TAG_META[t].colour, borderColor: TAG_META[t].colour, background: "transparent" }}>
                        {TAG_META[t].label}
                      </button>
                    );
                  })}
                </div>
              )}
              {/* ONE EDITOR, SHARED WITH THE PHONE. Not a desktop copy of a channel block. */}
              <PushPlanEditor m={open} draft={draft} setDraft={setDraft} zone={zone} setZone={setZone} />
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


      </div>
      {genCity && week && (
        <GeneralPushSheet
          city={genCity} week={week} saving={saving}
          onClose={() => setGenCity(null)}
          onSave={async (payload) => {
            setSaving(true);
            try {
              const { res, j } = await postPromo({ general: { ...payload, city: genCity } });
              if (!res.ok || j?.outcome !== "LANDED") {
                setToast({ msg: String(j?.error ?? "That push did not save."), bad: true });
                return false;
              }
              setGenCity(null);
              await load(weekRef);
              return true;
            } finally { setSaving(false); }
          }} />
      )}
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
const DOW_FULL = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/* ── THE DAY QUEUE ────────────────────────────────────────────────────────────────────────────
 *
 * Seven tabs defaulting to today, each carrying what is outstanding so the operator can CHOOSE a
 * day without opening any. Within the day: past due first in its own group, then still to send,
 * then already-sent behind a fold.
 *
 * DERIVED FROM THE WEEK, NEVER CARRIED BESIDE IT. Every entry comes from dayQueue(), which is a
 * projection of week.matches. A push on the queue and a push on a tile that disagree is the one
 * failure this page cannot afford.
 *
 * ARROW KEYS MOVE BETWEEN DAYS AND STOP AT THE ENDS. Wrapping from Sunday to Monday inside one
 * week reads as having moved to the next week, which it has not. */
function DayQueue({ week, zone, onMarked, onError, withPush, liveCount }: {
  week: PromoWeek; zone: ZoneMode; onMarked: () => void; onError: (msg: string) => void;
  /** Matches carrying a push of their own, and every match the week holds that was not cancelled. */
  withPush: number; liveCount: number;
}) {
  const now = Date.now();
  const past = isPastWeek(week, now);
  const [sel, setSel] = useState(() => defaultDayIdx(week));
  const [showDone, setShowDone] = useState(false);
  // THE WEEK CAN CHANGE UNDER THE TAB. Stepping back a week has no "today", so the selection
  // returns to the first day rather than pointing at a day the new week does not highlight.
  useEffect(() => { setSel(defaultDayIdx(week)); setShowDone(false); }, [week.weekStart]);

  const queues = useMemo(() => weekQueues(week, now), [week, now]);
  const q = queues[sel];
  const total = q.late.length + q.todo.length + q.done.length;

  const move = (d: number) => {
    const next = Math.min(6, Math.max(0, sel + d));   // STOPS AT THE ENDS, never wraps
    setSel(next);
    requestAnimationFrame(() => {
      (document.querySelector(`[data-testid="day-tab"][data-d="${next}"]`) as HTMLElement | null)?.focus();
    });
  };

  return (
    <div className="mx-5 mb-4 rounded-[11px] border border-cream-line bg-[#fbfdfc] px-3.5 py-3" data-testid="day-queue">
      <div className="mb-2.5 flex flex-wrap items-baseline gap-2.5">
        <span className="text-[9.5px] font-extrabold uppercase tracking-[0.09em] text-deep-green/45">Pushes by day</span>
        {/* COUNTED UP, NOT DOWN. "65 matches with no plan" reads as a failure report and buries
            the work that has been done; the operator wants to know where the week stands. Same
            set, stated positively, and the denominator excludes cancelled matches because a
            cancelled match is not work anybody still owes. */}
        <span className="text-[12px] font-bold text-deep-green/65" data-testid="strip-counts">
          {withPush} of {liveCount} match{liveCount === 1 ? "" : "es"} have a push
        </span>
      </div>
      {/* THE TABS CARRY THE OUTSTANDING WORK, so choosing a day never means opening one. */}
      <div className="mb-2.5 flex flex-wrap gap-1.5" role="tablist" aria-label="Day" data-testid="day-tabs">
        {week.days.map((d, i) => {
          const c = tabCounts(queues[i]);
          const on = i === sel;
          return (
            <button key={d.iso} role="tab" aria-selected={on} tabIndex={on ? 0 : -1}
              data-testid="day-tab" data-d={i} data-today={d.today ? "1" : "0"}
              onClick={() => setSel(i)}
              onKeyDown={(e) => {
                if (e.key === "ArrowRight") { e.preventDefault(); move(1); }
                if (e.key === "ArrowLeft") { e.preventDefault(); move(-1); }
              }}
              className={`flex min-h-[32px] flex-col items-start rounded-[9px] border px-2.5 py-1 text-left ${
                on ? "border-deep-green bg-deep-green text-white"
                   : d.today ? "border-mint bg-white" : "border-cream-line bg-white"}`}>
              <span className="text-[11px] font-extrabold uppercase tracking-[0.06em]">
                {d.dow} <b className="tracking-normal" data-testid="day-tab-date">{d.date}</b>
              </span>
              <span className={`flex gap-1.5 text-[9.5px] font-bold ${on ? "text-white/75" : "text-deep-green/45"}`}>
                {c.late > 0 && <i data-testid="pip-late" className="not-italic text-coral">{c.late} past due</i>}
                {c.late === 0 && c.todo > 0 && <i data-testid="pip-todo" className="not-italic">{c.todo} to send</i>}
                {c.late === 0 && c.todo === 0 && c.done > 0 && <i data-testid="pip-done" className="not-italic">{c.done} sent</i>}
                {c.late === 0 && c.todo === 0 && c.done === 0 && <i className="not-italic opacity-60">none</i>}
                {c.cancelled > 0 && <i data-testid="pip-cx" className="not-italic text-coral">{c.cancelled} cancelled</i>}
              </span>
            </button>
          );
        })}
      </div>

      <div data-testid="queue-panel">
        <div className="mb-1.5 flex flex-wrap items-baseline gap-2.5">
          <span className="text-[13.5px] font-extrabold" data-testid="queue-title">
            {DOW_FULL[sel]} {week.days[sel].date}{week.days[sel].today ? " · today" : ""}
          </span>
          <span className="text-[12px] font-bold text-deep-green/55" data-testid="queue-count">
            {total} push{total === 1 ? "" : "es"} · {q.done.length} sent
            {q.late.length > 0 ? ` · ${q.late.length} past due` : q.todo.length > 0 ? ` · ${q.todo.length} to send` : ""}
          </span>
        </div>
        {/* PAST DUE FIRST, IN ITS OWN GROUP. A push whose moment has gone is late; one whose moment
            has not arrived is not, however soon it is. */}
        {q.late.length > 0 && <div className="mb-1 mt-1.5 text-[9.5px] font-extrabold uppercase tracking-[0.08em] text-coral">Past due</div>}
        {q.late.map((e) => <QueueRow key={`l${e.p.id}`} e={e} zone={zone} late past={past} week={week} onMarked={onMarked} onError={onError} />)}
        {q.todo.length > 0 && <div className="mb-1 mt-1.5 text-[9.5px] font-extrabold uppercase tracking-[0.08em] text-deep-green/45">To send</div>}
        {q.todo.map((e) => <QueueRow key={`t${e.p.id}`} e={e} zone={zone} past={past} week={week} onMarked={onMarked} onError={onError} />)}
        {total === 0 && (
          <div className="py-1.5 text-[12px] text-deep-green/40" data-testid="queue-empty">
            Nothing planned for this day. Plan it on the week below.
          </div>
        )}
        {total > 0 && q.late.length === 0 && q.todo.length === 0 && (
          <div className="py-1.5 text-[12px] font-bold text-emerald-700" data-testid="queue-clear">
            Everything planned for this day has gone out.
          </div>
        )}
        {/* SENT GOES QUIET, NOT AWAY. Ryan: "they still show so everyone has visibility." */}
        {q.done.length > 0 && (
          <>
            <button data-testid="queue-fold" aria-expanded={showDone} onClick={() => setShowDone((v) => !v)}
              className="mt-1.5 min-h-[32px] rounded-[9px] border border-cream-line bg-white px-2.5 text-[12px] font-bold text-deep-green/65">
              {showDone ? "Hide" : "Show"} {q.done.length} already sent
            </button>
            {showDone && q.done.map((e) => <QueueRow key={`d${e.p.id}`} e={e} zone={zone} past={past} week={week} onMarked={onMarked} onError={onError} />)}
          </>
        )}
      </div>
    </div>
  );
}

/* ONE ROW. Mark sent stays exactly as good as it is — Ryan volunteered that the current format
 * makes marking done easy — so it is the same full-size control, on the row, unchanged. */
function QueueRow({ e, zone, late, past, week, onMarked, onError }: {
  e: QueueEntry; zone: ZoneMode; late?: boolean; past: boolean; week: PromoWeek;
  onMarked: () => void; onError: (msg: string) => void;
}) {
  const { m, p, general } = e;
  const sent = isPushSent(p);
  /* A GENERAL PUSH HAS NO MATCH TO TAKE A VENUE OFFSET FROM, so its time renders in the reader's
   * own clock rather than in a venue clock that does not exist for it. */
  const t = m ? fmtPush(m, p, zone) : fmtPushIn(p.pushAt, "me", null);
  const chan = CHANNELS.find((c) => c.key === p.channel);
  /* THE CODE RENDERS ON ITS CHANNEL CHIP, not on the row. WA ATX10WA beside SMS ATX10SMS is how
   * the operator sees the test is actually set up rather than sharing one code between them. A
   * push with no code shows its channel bare; nothing is invented. */
  const code = p.promoCode?.trim() || null;
  /* THE REACH A GENERAL PUSH ACTUALLY HAS, counted from the week rather than claimed. */
  const reach = general && week ? generalReach(general, week) : 0;
  return (
    <div data-testid="queue-row" data-push-id={p.id} data-channel={p.channel}
      data-sent={sent ? "1" : "0"} data-late={late ? "1" : "0"}
      className={`mb-1.5 flex flex-wrap items-center gap-2.5 rounded-[9px] border px-2.5 py-[7px] text-[12.5px] ${
        sent ? "border-cream-line bg-[#f4f7f5]" : late ? "border-coral/40 bg-coral-soft/40" : "border-cream-line bg-white"}`}>
      <span className={`whitespace-nowrap text-[12.5px] font-extrabold ${sent ? "text-deep-green/45 line-through" : late ? "text-coral" : ""}`}>
        {t.time}
      </span>
      {general ? (
        <>
          {/* THE SCOPE, SAID OUT LOUD. A general push looks like a match push at a glance and is
              not one; the label is what stops it being read as a push for a fixture. */}
          <i data-testid="queue-scope" className="rounded-[5px] border border-deep-green/25 bg-[#eef3f0] px-[5px] py-px text-[9px] font-extrabold not-italic tracking-[0.05em] text-deep-green/70">
            {general.scope === "city" ? "CITY" : "FIELD"}
          </i>
          <span className={sent ? "text-deep-green/45" : "text-deep-green/65"}>
            {general.scope === "city" ? general.city : `${fieldNameOf(general, week)} · ${general.city}`}
          </span>
          {general.audience && (
            <span data-testid="queue-audience" className={`text-[12px] ${sent ? "text-deep-green/40" : "text-deep-green/55"}`}>
              {general.audience}
            </span>
          )}
          <span data-testid="queue-reach" className="text-[11.5px] font-bold text-deep-green/45">
            {reach} match{reach === 1 ? "" : "es"}
          </span>
        </>
      ) : (
        <span className={sent ? "text-deep-green/45" : "text-deep-green/65"}>{m!.venue} · {m!.city} · {m!.time}</span>
      )}
      {/* THE CHIP CARRIES ITS OWN CODE. */}
      <span data-testid="queue-chan" className={`inline-flex h-[18px] items-center gap-1 rounded-[5px] border px-1 text-[9.5px] font-extrabold ${
        sent ? "border-cream-line bg-[#eef3f0] text-deep-green/40" : "border-mint/40 bg-mint-soft/40 text-emerald-700"}`}>
        <i className="not-italic">{chan?.short ?? p.channel}</i>
        {code && <i data-testid="queue-code" className="not-italic tracking-[0.03em] opacity-80">{code}</i>}
      </span>
      {p.topic && <span data-testid="queue-topic" className={`min-w-0 truncate text-[12px] ${sent ? "text-deep-green/40" : "text-deep-green/55"}`}>{p.topic}</span>}
      {late && <span data-testid="queue-late" className="rounded-[5px] bg-coral px-[5px] py-px text-[9.5px] font-extrabold text-white">past due</span>}
      {sent && <span data-testid="queue-stamp" className="text-[11.5px] text-deep-green/45">{sentStamp(p)}</span>}
      {/* A PAST WEEK OFFERS NO MARK SENT. Nothing in a week that has been and gone should ask the
          operator to do something they can no longer do. */}
      {!sent && !past && <MarkPushSent push={p} onDone={onMarked} onError={onError} />}
    </div>
  );
}

/** How many of the week's matches this general push actually reaches, on its own day. */
function generalReach(g: GeneralPush, week: PromoWeek): number {
  return week.matches.filter((m) =>
    m.state !== "cancelled" && generalsCovering(m, [g], week.days).length > 0).length;
}

/** The field's name, from the week rather than from a second lookup. */
function fieldNameOf(g: GeneralPush, week: PromoWeek): string {
  return week.matches.find((m) => m.fieldId === g.fieldId)?.venue ?? "field";
}

/* ── THE GENERAL PUSH SHEET ───────────────────────────────────────────────────────────────────
 *
 * Created from the CITY HEADER, because that is the object it is scoped to. A FIELD push is
 * created here too, with the field picked in this sheet, since a field is not an object anywhere
 * else on this page a control could hang off.
 *
 * IT COVERS THE DAY IT IS SENT FOR, and the sheet says so rather than leaving the operator to
 * discover it. Built covering the whole week first and Austin went to zero "no plan" instantly, at
 * which point the column tells nobody anything.
 *
 * THE AUDIENCE IS TYPED, NOT DERIVED. "all registered in Atlanta" is what the operator tells the
 * reader; deriving it would mean this page knowing what a Klaviyo segment holds, which it does not.
 */
function GeneralPushSheet({ city, week, saving, onClose, onSave }: {
  city: string; week: PromoWeek; saving: boolean; onClose: () => void;
  onSave: (p: { scope: "city" | "field"; channel: string; at: string | null; topic: string | null;
                promoCode: string | null; fieldId: number | null; audience: string | null }) => Promise<boolean>;
}) {
  const [scope, setScope] = useState<"city" | "field">("city");
  const [channel, setChannel] = useState<string>(CHANNELS[0]?.key ?? "wa");
  const [at, setAt] = useState("");
  const [topic, setTopic] = useState("");
  const [code, setCode] = useState("");
  const [audience, setAudience] = useState(`all registered in ${city}`);
  const [fieldId, setFieldId] = useState<number | "">("");

  /* THE FIELDS THIS CITY ACTUALLY RUNS THIS WEEK, from the week on screen. A picker listing every
   * field in the estate would offer pitches this city does not use. */
  const fields = useMemo(() => {
    const seen = new Map<number, string>();
    for (const m of week.matches) if (m.city === city && m.fieldId != null) seen.set(m.fieldId, m.venue);
    return [...seen].sort((a, b) => a[1].localeCompare(b[1]));
  }, [week, city]);

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/20 p-0 sm:items-center sm:p-6" data-testid="general-sheet">
      <div className="w-full max-w-[520px] rounded-t-[14px] border border-cream-line bg-white p-4 sm:rounded-[14px]">
        <div className="mb-2 flex items-baseline gap-2">
          <h3 className="m-0 text-[14px] font-extrabold">General push &middot; {city}</h3>
          <span className="text-[11.5px] text-deep-green/55">covers the day it is sent for</span>
        </div>
        <div className="mb-2 flex gap-1.5" role="group" aria-label="Scope">
          {([["city", "Whole city"], ["field", "One field"]] as const).map(([k, label]) => (
            <button key={k} type="button" data-testid={`gen-scope-${k}`} aria-pressed={scope === k}
              onClick={() => setScope(k)}
              className={`min-h-[32px] rounded-[9px] border px-3 text-[12px] font-bold ${
                scope === k ? "border-deep-green bg-deep-green text-white" : "border-cream-line bg-white text-deep-green/70"}`}>
              {label}
            </button>
          ))}
        </div>
        {scope === "field" && (
          <label className="mb-2 block">
            <span className="text-[10px] font-extrabold uppercase tracking-[0.08em] text-deep-green/45">Field</span>
            <select data-testid="gen-field" value={fieldId} onChange={(e) => setFieldId(e.target.value === "" ? "" : Number(e.target.value))}
              className="mt-0.5 block h-8 w-full rounded-lg border border-cream-line bg-white px-2 text-[12.5px]">
              <option value="">Pick a field</option>
              {fields.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
          </label>
        )}
        <div className="mb-2 grid grid-cols-2 gap-2">
          <label>
            <span className="text-[10px] font-extrabold uppercase tracking-[0.08em] text-deep-green/45">Channel</span>
            <select data-testid="gen-channel" value={channel} onChange={(e) => setChannel(e.target.value)}
              className="mt-0.5 block h-8 w-full rounded-lg border border-cream-line bg-white px-2 text-[12.5px]">
              {CHANNELS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
          </label>
          <label>
            <span className="text-[10px] font-extrabold uppercase tracking-[0.08em] text-deep-green/45">When</span>
            <input type="datetime-local" data-testid="gen-at" value={at} onChange={(e) => setAt(e.target.value)}
              className="mt-0.5 block h-8 w-full rounded-lg border border-cream-line bg-white px-2 text-[12.5px]" />
          </label>
        </div>
        <label className="mb-2 block">
          <span className="text-[10px] font-extrabold uppercase tracking-[0.08em] text-deep-green/45">Audience</span>
          <input data-testid="gen-audience" value={audience} onChange={(e) => setAudience(e.target.value)}
            className="mt-0.5 block h-8 w-full rounded-lg border border-cream-line bg-white px-2 text-[12.5px]" />
        </label>
        <div className="mb-2.5 grid grid-cols-2 gap-2">
          <label>
            <span className="text-[10px] font-extrabold uppercase tracking-[0.08em] text-deep-green/45">Topic</span>
            <input data-testid="gen-topic" value={topic} onChange={(e) => setTopic(e.target.value)}
              className="mt-0.5 block h-8 w-full rounded-lg border border-cream-line bg-white px-2 text-[12.5px]" />
          </label>
          <label>
            <span className="text-[10px] font-extrabold uppercase tracking-[0.08em] text-deep-green/45">Code</span>
            {/* NORMALISED ON THE WAY IN, so the 486 mixed-case entries already in production do not
                gain a 487th from this page. */}
            <input data-testid="gen-code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())}
              className="mt-0.5 block h-8 w-full rounded-lg border border-cream-line bg-white px-2 text-[12.5px] uppercase" />
          </label>
        </div>
        <div className="flex items-center gap-3">
          <button type="button" data-testid="gen-save" disabled={saving || (scope === "field" && fieldId === "")}
            onClick={() => void onSave({
              scope, channel, at: at.trim() === "" ? null : at, topic: topic.trim() || null,
              promoCode: code.trim() || null, fieldId: scope === "field" ? Number(fieldId) : null,
              audience: audience.trim() || null,
            })}
            className="min-h-[32px] rounded-full bg-deep-green px-[15px] text-[12.5px] font-extrabold text-white disabled:opacity-50">
            {saving ? "Saving…" : "Save push"}
          </button>
          <button type="button" data-testid="gen-cancel" onClick={onClose}
            className="min-h-[32px] rounded-full px-2 text-[12.5px] font-bold text-deep-green/65">Cancel</button>
        </div>
      </div>
    </div>
  );
}

function Plan({ week, byCity, openId, onOpen, openCity, zone, panel, riskOf, coverage, coversOf, tagsOf, onAddGeneral }: {
  week: PromoWeek; byCity: [string, PromoMatch[]][]; openId: number | null; zone: ZoneMode;
  /** The tile's cancel history, keyed on field and weekday with times CLUSTERED. See cancelPatterns. */
  riskOf: (m: PromoMatch) => SlotRisk | null;
  /** Derived once at page level so the header and the tiles under it cannot describe different sets. */
  coverage: Map<number, ReturnType<typeof coverageOf>>;
  coversOf: (m: PromoMatch) => GeneralPush[];
  tagsOf: (m: PromoMatch) => TagKey[];
  onAddGeneral: (city: string) => void;
  onOpen: (m: PromoMatch, el: HTMLElement) => void;
  // THE PANEL OPENS INLINE, UNDER THE CITY WHOSE TILE WAS CLICKED — not at the foot of the page.
  // Rendering it once at page level meant clicking an Atlanta match scrolled you past every other
  // city to reach the editor. A panel that is correct but a page away is the bug.
  openCity: string | null; panel: React.ReactNode;
}) {
  const priorLabel = weekRangeLabel(week.priorWeekStart);
  const keyTags = tagsInUse(new Map(week.matches
    .filter((m) => m.fieldId != null)
    .map((m) => [m.fieldId as number, tagsOf(m)])));
  return (
    <>
      <div className="px-5 pb-0.5 pt-1">
        <h2 className="m-0 text-[15px] font-extrabold uppercase tracking-[0.02em]">The week</h2>
        {/* ── THE KEY, AND ONLY FOR TAGS ACTUALLY ON SCREEN ─────────────────────────────────
            A key listing every tag that could exist is a key nobody reads, which this codebase
            has already written down once about a permanent caveat. Every tag also carries its
            meaning in a title, so this is a reference rather than a prerequisite. */}
        {keyTags.length > 0 && (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1" data-testid="tag-key">
            {keyTags.map((t) => (
              <span key={t} className="inline-flex items-center gap-1.5 text-[11px] text-deep-green/65" data-testid="tag-key-item">
                <i className="rounded-[4px] border px-[4px] py-px text-[8.5px] font-extrabold not-italic tracking-[0.03em]"
                  style={{ color: TAG_META[t].colour, borderColor: TAG_META[t].colour }}>{TAG_META[t].label}</i>
                {TAG_META[t].meaning}
              </span>
            ))}
          </div>
        )}
        {/* ── TWO PARAGRAPHS DELETED, AND THE RULE KEPT ────────────────────────────────────
            The first restated what clicking a tile does. The second was the whole NEW definition,
            eight lines of prose above the grid, and EVERY BADGE ALREADY CARRIES IT in its own
            title. Ryan: "also remove all this its jus tnoise."

            THE ONE THING THE PARAGRAPH HAD THAT THE BADGE DID NOT was the week it compared
            against, and the reason for printing it was good: a wrong week should be visible rather
            than silent. So the dates moved INTO the badge's title rather than being lost. The rule
            is still checkable, one hover away, on the thing it describes. */}
      </div>
      {byCity.map(([city, matches]) => {
        const planned = matches.filter((m) => m.state === "planned").length;
        const check = matches.filter((m) => m.state === "needs-decision").length;
        /* ── THE FRACTION CARRIES THE SCALE, AND "NO PLAN" STAYS GONE ────────────────────────
           Ryan, twice: "remove the no plan stat from all the cities too, don't need to show no
           plan", and then "keep the denominator the row already has". So the row reads "3 of 4 ·
           1 covered": the fraction says where the city stands, covered is the new fact the
           general-push feature exists to surface, and no plan is derivable as 4 minus 3 minus 1
           without the word appearing anywhere.
           COVERED IS OMITTED WHEN IT IS ZERO, so a city nobody has blasted does not grow a
           permanent "0 covered" - the same rule the sent count on the queue strip follows. */
        const live = matches.filter((m) => m.state !== "cancelled");
        const own = live.filter((m) => { const c = coverage.get(m.apiId); return c === "planned" || c === "needs-decision"; }).length;
        const covered = live.filter((m) => coverage.get(m.apiId) === "covered").length;
        /* CANCELLED IS COUNTED SEPARATELY, as count AND players. It is excluded from "no plan"
           above by being its own state: nothing was missed, the match was called off. */
        const cx = matches.filter((m) => m.state === "cancelled");
        const cxBooked = cx.reduce((a, m) => a + (m.playerCount ?? 0), 0);
        // Counted from the SAME rows the grid renders, so the header can never describe a
        // different set of tiles than the one below it.
        const fresh = matches.filter((m) => m.newFlag !== null).length;
        return (
          <div key={city} className="px-5 pb-1" data-testid="city-block">
            <div className="flex items-baseline gap-2.5 pb-2 pt-3">
              <h2 className="m-0 text-[15px] font-extrabold">{city}</h2>
              <span data-testid="city-counts" data-own={own} data-covered={covered} data-live={live.length}
                className="text-[11.5px] font-bold text-deep-green/45">
                {own} of {live.length}{covered > 0 ? ` · ${covered} covered` : ""}
              </span>
              {fresh > 0 && (
                <span className="text-[11.5px] font-extrabold text-deep-green" data-testid="city-new-count">
                  {fresh} new
                </span>
              )}
              {/* CREATED FROM THE CITY HEADER, because that is the object it is scoped to. A field
                  push is created here too with the field picked in the sheet, since a field is not
                  an object anywhere else on this page a control could hang off. */}
              <button type="button" data-testid="add-general" onClick={() => onAddGeneral(city)}
                className="ml-auto min-h-[32px] rounded-[9px] border border-cream-line bg-white px-2.5 text-[11.5px] font-bold text-deep-green/70">
                + General push
              </button>
              {cx.length > 0 && (
                <span className="text-[11.5px] font-extrabold text-coral" data-testid="city-cx-count">
                  {cx.length} cancelled &middot; {cxBooked} booked
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
                    {dayMatches.map((m) => <Tile key={m.apiId} m={m} open={m.apiId === openId} onOpen={onOpen} zone={zone}
                      priorLabel={priorLabel} risk={riskOf(m)} cover={coverage.get(m.apiId) ?? "none"}
                      covers={coversOf(m)} tags={tagsOf(m)} />)}
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

/** The first push on a covered day, in the clock on screen. */
function coverFirst(m: PromoMatch, zone: ZoneMode): string {
  const first = datedPushes(m.plan)[0];
  if (!first) return "";
  const t = fmtPush(m, first, zone);
  return `${t.day} ${t.time}`;
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
function Tile({ m, open, onOpen, zone, priorLabel, risk, cover, covers, tags }: {
  m: PromoMatch; open: boolean; onOpen: (m: PromoMatch, el: HTMLElement) => void; zone: ZoneMode;
  priorLabel: string; risk?: SlotRisk | null;
  /** planned | covered | none | needs-decision | cancelled, derived once at page level. */
  cover: ReturnType<typeof coverageOf>;
  /** The general pushes that carried it, for the label. Empty unless `cover` is "covered". */
  covers: GeneralPush[];
  tags: TagKey[];
}) {
  /* A CHIP PER CHANNEL THAT HAS A PUSH, or is on with none — which is what "on" is now. */
  const lit = CHANNELS.filter((c) => channelsOn(m.plan).includes(c.key));
  const code = codeFor(m.plan, lit[0]?.key ?? "wa") ?? lit.map((c) => codeFor(m.plan, c.key)).find(Boolean) ?? null;
  const summary = tileSummary(m, zone);
  const cancelled = cover === "cancelled";
  const r = risk?.cancelCount ?? 0;
  const { shown: shownTags, more: moreTags } = splitTags(tags);
  /* THE CANCEL WASH IS THE OUTERMOST STATE except for a cancellation itself. A washed tile keeps
   * its own border colour, which is what stops orange-at-2 colliding with the amber that already
   * means "needs a decision" on this page. */
  /* ── THREE COVERAGE STATES, AND THE MIDDLE ONE IS THE FEATURE ─────────────────────────────
   *   own push   SOLID mint rail    this match got its own push
   *   covered    DOTTED mint rail   a city or field push carried it
   *   no plan    dashed, no rail    nothing at all, not even a slate blast
   * A general push is real promotion, so a match it carried must not read as forgotten; it is not
   * a push written for that match, so it must not read the same either. */
  const border =
    cancelled ? "border-dashed border-cream-line bg-[#f7f8f7]"
    : r > 0 ? WASH[r as 1 | 2 | 3 | 4]
    : cover === "needs-decision" ? "border-amber-300 bg-amber-50"
    /* border-l-dotted IS NOT A TAILWIND CLASS. Tailwind has border-dotted for all four sides and
     * nothing for one, so the first version emitted no rule at all and the covered rail rendered
     * SOLID — identical to an own push, which is the one distinction this state exists to make.
     * The style below is the only way to dot one edge, and the assertion reads the computed value
     * rather than the class list, which is what caught it. */
    : cover === "covered" ? "border-cream-line border-l-[3px] border-l-mint bg-white"
    : cover === "none" ? "border-dashed border-cream-line bg-white"
    : "border-cream-line border-l-[3px] border-l-mint bg-white";
  return (
    <div data-testid="match-tile" data-state={m.state} data-api-id={m.apiId} data-open={open ? "1" : "0"}
      data-new={m.newFlag ?? ""} data-r={r} data-cover={cover}
      data-booked={cancelled ? String(m.playerCount ?? 0) : undefined}
      /* THE EXACT TIME LIVES IN THE TITLE, because the tile is coloured on a slot key whose times
         are clustered — a slot that drifted from 8:00 to 8:30 is one slot to a player and must be
         one slot here, but the operator still needs to see which time this match actually is. */
      title={risk ? `Cancelled in ${r} of the last 4 weeks. Seen at ${risk.times.join(", ")}.` : undefined}
      style={cover === "covered" ? { borderLeftStyle: "dotted" } : undefined}
      onClick={(e) => onOpen(m, e.currentTarget as HTMLElement)}
      /* NO bg-white IN THE BASE. It and the wash class have equal specificity, so which one wins is
         decided by Tailwind's own emission order rather than by this line — the wash lost, and
         every shaded tile rendered white while its chip was coloured. The default background is
         part of the state chain below instead, so exactly one background class is ever applied. */
      className={`mb-1.5 cursor-pointer rounded-[9px] border p-[7px_8px] last:mb-0 ${border} ${open ? "border-deep-green shadow-[0_0_0_2px_#e6efe9]" : ""}`}>
      <div className="flex items-baseline justify-between gap-1.5">
        <span className={`text-[12.5px] font-extrabold ${cancelled ? "text-deep-green/40 line-through" : ""}`}>{m.time}</span>
        {/* THE RATIO, ON EVERY SHADED TILE. #D9452F against #8F2A17 is a hard pair at tile size,
            which is the only real objection to this ramp; printing the number answers it without
            changing the colours. */}
        {r > 0 && (
          <i data-testid="risk-chip" data-r={r}
            className="shrink-0 rounded-[4px] px-[5px] py-px text-[9px] font-extrabold not-italic tracking-[0.03em]"
            style={{ background: RAMP_HEX[r as 1 | 2 | 3 | 4], color: RAMP_INK[r as 1 | 2 | 3 | 4] }}>
            {r}/4
          </i>
        )}
        {m.newFlag && (
          <i data-testid="new-badge" data-flag={m.newFlag}
            /* THE RULE, THE CITY AND THE WEEK IT COMPARED, on the badge itself. The dates are
               what makes a wrong comparison visible instead of silent. */
            title={`This ${m.newFlag === "field" ? "field" : m.newFlag === "day" ? "weekday for this field" : "kick-off time for this field and weekday"} was not on last week's slate for ${m.city} (${priorLabel}). Cancelled matches count, because a cancelled slot was still scheduled and still published.`}
            className="shrink-0 rounded-[4px] bg-deep-green px-[5px] py-px text-[8.5px] font-extrabold not-italic tracking-[0.04em] text-white">
            {NEW_FLAG_LABEL[m.newFlag]}
          </i>
        )}
      </div>
      <div className={`mt-px text-[11px] leading-[1.25] ${cancelled ? "text-deep-green/40" : "text-deep-green/65"}`}>{m.venue}</div>
      {/* EVERY COVERED TILE NAMES WHAT CARRIED IT. A dotted rail with no explanation is a mystery,
          and the operator cannot judge a blast they cannot see. */}
      {cover === "covered" && covers.length > 0 && (
        <div data-testid="cover-tag" className="mt-[3px] text-[10px] font-bold text-emerald-700">
          {coverLabel(covers[0], m.venue)}{covers.length > 1 ? ` +${covers.length - 1}` : ""}
        </div>
      )}
      {/* TAGS: OUTLINED, NEVER FILLED. The tile already spends filled pills on the cancel ratio and
          the NEW badge; a filled tag would read as a 4/4 cancel at a glance. Three render and the
          rest become a count, because five pills on one tile is unreadable. */}
      {shownTags.length > 0 && (
        <div className="mt-[5px] flex flex-wrap gap-1" data-testid="tags">
          {shownTags.map((t) => (
            <i key={t} data-testid="tag" data-t={t} title={TAG_META[t].meaning}
              className="rounded-[4px] border px-[4px] py-px text-[8.5px] font-extrabold not-italic tracking-[0.03em]"
              style={{ color: TAG_META[t].colour, borderColor: TAG_META[t].colour, background: "transparent" }}>
              {TAG_META[t].label}
            </i>
          ))}
          {moreTags > 0 && (
            <i data-testid="tag-more" className="rounded-[4px] border border-cream-line px-[4px] py-px text-[8.5px] font-extrabold not-italic text-deep-green/45">
              +{moreTags}
            </i>
          )}
        </div>
      )}
      {/* A CANCELLED MATCH IS ITS OWN STATE, not a variant of "no plan": nothing was missed, the
          match was called off. THE BOOKED COUNT IS THE POINT and so it is the loudest thing here —
          a cancellation with 16 booked cost sixteen players, one with 1 was never going to run, and
          rendering both as "cancelled" throws away the only number that separates them. */}
      {cancelled && (
        <div className="mt-[5px] flex items-center gap-1.5">
          <i data-testid="cx-tag" className="rounded-[4px] border border-cream-line bg-white px-[5px] py-px text-[8.5px] font-extrabold not-italic uppercase tracking-[0.05em] text-deep-green/45">Cancelled</i>
          <span data-testid="booked" data-heavy={(m.playerCount ?? 0) >= 10 ? "1" : "0"}
            className={`text-[12px] font-extrabold ${(m.playerCount ?? 0) >= 10 ? "text-coral" : "text-deep-green/70"}`}>
            {m.playerCount ?? 0} booked
          </span>
        </div>
      )}
      {/* ONLY THE LIT CHANNELS. flex-wrap + min-w-0 still stops the widest chip running off the
          tile edge at seven columns — the failure this layout had before, and the reason the
          overflow measurement in verify-match-promotion is kept. */}
      {(lit.length > 0 || code) && (
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
          {code && (
            <span className="rounded-[5px] border border-amber-300 bg-amber-50 px-[5px] py-px text-[9.5px] font-extrabold text-amber-800">
              {code}
            </span>
          )}
        </div>
      )}
      {/* NO "No push planned". An empty tile already says it, and the city header counts it. */}
      {summary && (
        <div className="mt-[5px] text-[10px] font-bold text-deep-green/45">
          {/* THE FIRST PUSH AND HOW MANY MORE. Not six lines: a match can carry three channels
              and five dates, and a 96px day cell cannot print them. */}
          Push <b className="text-deep-green/70">{summary.first}</b> · {summary.lead}
          {summary.more > 0 && <span data-testid="tile-more"> and <b className="text-deep-green/70">{summary.more}</b> more</span>}
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
function Coverage({ week, zone }: { week: PromoWeek; zone: ZoneMode }) {
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
                  const planned = dayMatches.filter((m) => datedPushes(m.plan).length > 0);
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
                            {m.time} · push {coverFirst(m, zone)}
                          </div>
                          <span className="flex flex-wrap gap-[2px]">
                            {CHANNELS.filter((c) => channelsOn(m.plan).includes(c.key)).map((c) => (
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

/* ── CANCEL PATTERNS ──────────────────────────────────────────────────────────────────────────
 *
 * RYAN'S RAMP: yellow, orange, light red, dark red for 1, 2, 3, 4. It replaces one that was NOT
 * ORDERED, and that is a fix rather than a preference. The old scale ran #e6a532 amber at 2, then
 * #7d3220 at 3 — a very dark maroon — then #c0392b at 4, which is BRIGHTER than 3. So three read
 * heavier than four, which is why the two reds were impossible to separate.
 *
 * MEASURED luminance, old, 1 to 4: 239.4 > 170.5 > 64.6 > 84.7. It falls and then climbs again.
 * MEASURED luminance, new, 1 to 4: 195.5 > 148.2 > 98.9 > 62.1. Strictly monotonic, and asserted
 * as such so the ordering cannot silently break later.
 *
 * ONE SCALE FOR ONE METRIC. This map is the Cancel tab's too, so changing it changes both, which
 * is intended: a metric with two scales is worse than an imperfect scale. */
const RAMP_HEX: Record<1 | 2 | 3 | 4, string> = { 1: "#F4C430", 2: "#E8862A", 3: "#D9452F", 4: "#8F2A17" };
const RAMP_INK: Record<1 | 2 | 3 | 4, string> = { 1: "#3A2A00", 2: "#2E1B00", 3: "#ffffff", 4: "#ffffff" };
/* TIER IS GONE, AND THE COLOURS ARE NOT. It was a Tailwind-class encoding of exactly the four
 * values above — #F4C430/#3A2A00, #E8862A/#2E1B00, #D9452F/#fff, #8F2A17/#fff — built for the
 * cancel grid's pills, and the grid was its only consumer. RAMP_HEX and RAMP_INK are the same four
 * pairs, owned by the tiles that read them, so nothing about the scale moved; one of two encodings
 * of it did. */

/* THE TILE WASH. Light at 1 and 2 so a board of ones does not read as a board on fire, and the
 * ratio is printed on every chip regardless — nobody reads 2/4 against 3/4 off a shade, and that
 * is exactly the distinction between moving a slot and watching it.
 *
 * TWO IS ORANGE AND "NEEDS A DECISION" IS AMBER on this page (border-amber-300 bg-amber-50), which
 * are neighbours. MEASURED on the live week: 0 tiles are both at once, because needs-decision
 * requires a plan with every push undated and the cancel wash requires a cancellation history, and
 * no match currently holds both. They are separated anyway — a washed tile keeps its cancel border
 * and the needs-decision amber only ever shows on an unwashed one — so the pair cannot collide if
 * the data changes. */
const WASH: Record<1 | 2 | 3 | 4, string> = {
  1: "bg-[#FEF8E7] border-[#F4C430]",
  2: "bg-[#FDF0E3] border-[#E8862A]",
  3: "bg-[#FBE9E6] border-[#D9452F]",
  4: "bg-[#F6E4E0] border-[#8F2A17]",
};

/* ── THE TILE'S CANCEL HISTORY ────────────────────────────────────────────────────────────────
 *
 * WHAT THIS REPLACES. useCancelRanking built a city-by-weekday matrix and a phone ranking for the
 * Cancel section, and grew `result` and `canonicalOf` when the tiles started reading it. The
 * section is gone — the history lives on the tiles now, which is what it was for — so the matrix,
 * the ranking, the headline and the worst-slot figures go with it and only the two things the
 * tiles actually use survive. THE CANCEL SECTION WAS ITS ONLY OTHER CALLER; checked before cutting.
 *
 * ANCHORED ON THE WEEK BEING DISPLAYED, not on today. See the call site for the Keswick Park case
 * that made that necessary. getCancelPatterns' own default is untouched, so any other caller keeps
 * anchoring on today; the anchor is passed in.
 */
function useTileCancelHistory(weekStart: string | null) {
  const { rows, meta, loading } = useMatchData();
  const { data: finData } = useFinanceData();
  const aliases = useMemo(() => finData?.venueAliases ?? new Map<string, string>(), [finData]);

  /* THE DISPLAYED WEEK'S MONDAY, AS A LOCAL DATE. mostRecentCompletedWeekMonday then returns that
   * Monday minus seven, so the window is the four weeks ending the Sunday BEFORE the week on
   * screen. Parsed from the parts rather than Date.parse: "2026-09-21" parses as UTC midnight and
   * would land on the 20th in every western zone, moving the whole window a week. */
  const anchor = useMemo(() => {
    if (!weekStart) return null;
    const [y, m, d] = weekStart.split("-").map(Number);
    return new Date(y, m - 1, d);
  }, [weekStart]);

  const result = useMemo(
    () => (anchor ? getCancelPatterns(rows, aliases, "patterns", anchor) : null),
    [rows, aliases, anchor],
  );
  const canonicalOf = useCallback(
    (fieldRaw: string) => normalizeMatchName(fieldRaw, aliases).canonical, [aliases]);

  return { result, canonicalOf, ready: !loading && !!meta && !!result };
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
