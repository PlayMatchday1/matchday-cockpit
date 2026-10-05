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
import { TAG_KEYS, TAG_KEY_ORDER, TAG_META, splitTags, tagTitle, tagTitleWithDates, tagLiveOn, tagRangeLabel, tagsAtScope, tagsInUse, isTagKey, type TagDates, type TagKey } from "@/lib/promoTags";
import { weekQueueEntries, weekQueues, isPastWeek, defaultDayIdx, tabCounts, type QueueEntry } from "@/lib/promoDayQueue";
import {
  CHANNELS, NEW_FLAG_LABEL, channelsOn, coverageCaption, coverageStateOf, coverageSummary, matchCodes,
  coverageOf, coverLabel, generalsCovering, generalPushDayIdx, type GeneralPush,
  datedPushes, draftFromPlan, draftToPushes, fmtPushIn, isPushOverdue, isPushSent, leadToKickoff,
  sentStamp, venueOffsetMs,
  type PromoMatch, type PromoPush, type PromoWeek, type PushDraft, type ZoneMode,
} from "@/lib/matchPromotion";
import MarkPushSent from "@/components/MarkPushSent";
import PushPlanEditor from "@/components/PushPlanEditor";
import Starting11Control from "@/components/Starting11Control";

/* ── THE FOUR VIEWS, AND WHY THE TAG ONES ARE NOT THEIR OWN COMPONENT ────────────────────────
 *
 * Plan | Coverage | Priority | Starting 11. A tag view is the PLAN grid with the week's matches
 * filtered to those carrying one tag — same city rows, same seven day columns, same tiles, same
 * panel. So it is the same component with a `viewTag`, and the filter is applied ONCE where byCity
 * is built. Two separate implementations of "the grid, but filtered" is how one of them ends up
 * counting cancelled matches and the other does not.
 *
 * THE VIEW IS NAMED BY THE TAG KEY, so adding a third tag adds a view by adding it to TAG_KEYS.
 * Nothing here enumerates "priority" or "starting_11" by hand.
 *
 * WHAT A TAG VIEW DOES NOT TOUCH: the day queue and the Pushes-by-day strip above the grid. Those
 * are the week's outstanding work and filtering them would hide pushes the operator still owes.
 * Ryan's ruling, and it is the right one - a filter on a worklist is a way to forget something. */
export const PROMO_VIEWS = ["plan", "coverage", ...TAG_KEYS] as const;
export type PromoView = (typeof PROMO_VIEWS)[number];
/* ONE LABEL MAP FOR BOTH SURFACES, including the phone's own Due and Week. A view named in two
 * places gets renamed in one of them. TAG_META is the source of a tag view's label, so "STARTING 11"
 * becomes "Starting 11" here and nothing hardcodes either spelling. */
export const VIEW_LABEL: Record<PromoView | "due" | "week", string> = {
  plan: "Plan",
  coverage: "Coverage",
  due: "Due",
  week: "Week",
  /* TITLE CASE PER WORD, not just the first letter: lowercasing "KEY FIELD" and capitalising once
   * gives "Key field", which sits badly next to "Starting 11" in the same strip. */
  ...Object.fromEntries(TAG_KEYS.map((k) => [k, TAG_META[k].label
    .toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase())])) as Record<TagKey, string>,
};

/* THE PHONE'S OWN LIST. Due and Week are shapes the desktop does not have (see
 * MatchPromotionMobile), and the three shared views follow the desktop's own order. */
export const MOBILE_VIEWS = ["due", "week", "coverage", ...TAG_KEYS] as const;
export type MobileView = (typeof MOBILE_VIEWS)[number];

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
  /* ── FOUR VIEWS, AND THE TAG ONES ARE FILTERED PLAN VIEWS ────────────────────────────────
   * Plan stays: it IS the week grid, and the tag views keep its city grouping and day columns, so
   * they are Plan with a filter rather than a relative of Coverage. A tag view is named by its tag
   * key, which is what lets ONE component serve both instead of two implementations drifting. */
  const [tab, setTab] = useState<PromoView>("plan");
  // THE PHONE OPENS ON DUE; desktop opens on Plan and is untouched. Separate state because "due"
  // is not a desktop view and must never leak into the desktop tab set.
  const [mTab, setMTab] = useState<MobileView>("due");
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

  /* ── HAS THIS PANEL BEEN EDITED? DERIVED, NEVER A FLAG ────────────────────────────────────
   * draftFromPlan is deterministic for a given plan — row keys included, since an existing row
   * keys on `p-${id}` — so the draft as loaded can be recomputed and compared rather than stored.
   * A `dirty` boolean set by every onChange in the editor is the same fact kept in two places, and
   * the copy is the one that ends up wrong: a toggle flipped twice leaves it true.
   *
   * THIS IS WHAT STOPS AN UNSAVED PANEL BEING SWAPPED OUT. Losing typed pushes to a stray click on
   * a grid of 88 tiles is the one thing this panel must not do. */
  const dirty = !!open && !!draft
    && JSON.stringify(draft) !== JSON.stringify(draftFromPlan(open.plan));

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
    /* A CANCELLED MATCH OPENS (Ryan, 2026-10-05). It used to return here, so pushes planned before
     * the cancellation could never be removed (STAR, Oct 5). The panel opens in cancelled mode:
     * existing pushes can be removed or marked sent / not sent; adding one is blocked here and in
     * the route. The tile keeps its CANCELLED state. Past matches and past weeks open as normal. */
    /* AN UNSAVED PANEL IS NOT SWAPPED OUT FROM UNDER YOU. The click is ignored rather than
     * silently discarding what was typed; Save or Cancel is the only way out. Nothing is flashed
     * at the operator here beyond the Unsaved marker the panel already carries — see `dirty`. */
    if (dirty && m.apiId !== openId) return;
    anchor(el, () => { setOpenId(m.apiId); setDraft(draftFromPlan(m.plan)); });
  }

  function closePanel() {
    const el = openId != null
      ? (document.querySelector(`[data-testid="match-tile"][data-api-id="${openId}"]`) as HTMLElement | null)
      : null;
    anchor(el, () => { setOpenId(null); setDraft(null); });
  }

  /* ── ESCAPE CLOSES, AND ONLY WHEN THERE IS NOTHING TO LOSE ────────────────────────────────
   * The same rule as clicking another tile: Save or Cancel is the only way out of an edited panel.
   * Bound on the document because the panel is fixed and the operator's focus may be anywhere on
   * the week behind it — a handler on the panel itself would need focus to be inside it. */
  useEffect(() => {
    if (openId == null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || dirty) return;
      const el = document.querySelector(`[data-testid="match-tile"][data-api-id="${openId}"]`) as HTMLElement | null;
      anchor(el, () => { setOpenId(null); setDraft(null); });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [openId, dirty]);

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
  /* ── TAGS FROM BOTH SCOPES, RAW AND UNSUPPRESSED ──────────────────────────────────────────
   * priority is keyed on the MATCH and dies with it; key_field and starting_11 are keyed on the
   * FIELD and ride every match at that pitch. This returns the TRUE set. The tile suppresses
   * priority under key_field for display (tagsForDisplay) and THE PANEL MUST NOT — a toggle reading
   * the suppressed set would come up dark on a priority that IS set, and the next save would
   * silently clear it. */
  /* THE RAW SET — every tag row on this match and its field, dates ignored. The PANEL reads this,
   * so a Starting 11 whose end date has passed still comes up lit (with its dates) and is edited
   * rather than re-added. */
  const tagsOfRaw = useCallback((m: PromoMatch): TagKey[] => {
    const field = m.fieldId != null ? (week?.tagsByField?.[m.fieldId] ?? []) : [];
    const match = week?.tagsByMatch?.[m.apiId] ?? [];
    return [...match, ...field].filter(isTagKey);
  }, [week]);
  /** A field tag's dates, or null when the row is undated (0207). */
  const tagDatesOf = useCallback((m: PromoMatch, t: TagKey): TagDates | null =>
    (m.fieldId != null ? week?.tagDatesByField?.[m.fieldId]?.[t] : null) ?? null, [week]);
  /* WHAT A TILE SHOWS: the raw set, minus a dated field tag whose range does not include THIS
   * MATCH'S DAY (0207). The day is the calendar date of the tile's column. */
  const tagsOf = useCallback((m: PromoMatch): TagKey[] => {
    const ymd = week?.days[m.dayIdx]?.iso ?? "";
    return tagsOfRaw(m).filter((t) => TAG_META[t].scope !== "field" || tagLiveOn(tagDatesOf(m, t), ymd));
  }, [week, tagsOfRaw, tagDatesOf]);
  /** A tag's tooltip on this match, with its date range when it has one. */
  const tagTitleFor = useCallback((m: PromoMatch, t: TagKey) => tagTitleWithDates(t, tagDatesOf(m, t)), [tagDatesOf]);
  /* ONE SHEET, TWO JOBS. `push` null is "create a new one for this city"; a push is "edit that
   * one". The route has always taken an id on the same payload — it was only the page that had no
   * way to hand it one, because there was nothing on screen to click. */
  const [gen, setGen] = useState<{ city: string; push: GeneralPush | null } | null>(null);
  const openGeneral = useCallback((city: string) => setGen({ city, push: null }), []);
  const editGeneral = useCallback((g: GeneralPush) => setGen({ city: g.city, push: g }), []);

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

  /* THE SCOPE IS DERIVED FROM THE TAG, never passed in: TAG_META owns it and the database enforces
   * it (promo_tags_scope_ck), so a caller cannot address the wrong column even by accident. */
  const toggleTag = useCallback(async (m: PromoMatch, tag: TagKey, on: boolean, dates?: TagDates) => {
    setSaving(true);
    try {
      const scoped = TAG_META[tag].scope === "match"
        ? { matchId: m.apiId, tag, on }
        : { fieldId: m.fieldId, tag, on, ...(dates ? { startsOn: dates.startsOn, endsOn: dates.endsOn } : {}) };
      const { res, j } = await postPromo({ tag: scoped });
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

  /* ── ONE FILTER, APPLIED WHERE THE GROUPING IS BUILT ──────────────────────────────────────
   * So the city header, the tile count and the day columns all read the same filtered set and
   * cannot disagree. EMPTY CITIES ARE DROPPED: a city row with seven empty day cells is a row that
   * says nothing, and eight of them bury the two cities that do carry the tag.
   *
   * CANCELLED TAGGED MATCHES STAY, styled exactly as they are on Plan. The tag is on the pitch, and
   * a cancellation at a priority field is a thing the operator most wants to see, not less. */
  const viewTag: TagKey | null = tab === "plan" || tab === "coverage" ? null : tab;
  const byCityTagged = viewTag == null ? byCity : byCity
    .map(([city, ms]) => [city, ms.filter((m) => tagsOf(m).includes(viewTag))] as [string, PromoMatch[]])
    .filter(([, ms]) => ms.length > 0);

  if (loading && !week) return <div className="p-8 text-sm text-deep-green/60">Loading the week…</div>;
  if (error) return <div className="p-8 text-sm text-coral">{error}</div>;
  if (!week) return null;

  if (isMobile) {
    return (
      <MatchPromotionMobile
        week={week} tab={mTab} setTab={setMTab}
        jobs={jobs} overdue={overdue} onReload={() => load(weekRef)} riskOf={riskOf}
        coverOf={(m) => coverage.get(m.apiId) ?? "none"} coversOf={coversOf} tagsOf={tagsOf}
        tagsOfRaw={tagsOfRaw} tagDatesOf={tagDatesOf} tagTitleFor={tagTitleFor}
        onToggleTag={(m, t, on, dates) => void toggleTag(m, t, on, dates)}
        openId={openId} draft={draft} setDraft={setDraft} dirty={dirty}
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
          <span className="ml-1.5 inline-flex flex-wrap rounded-full border border-cream-line bg-[#f2f5f3] p-0.5" data-testid="view-tabs">
            {PROMO_VIEWS.map((t) => (
              <button key={t} onClick={() => setTab(t)} data-testid={`view-tab-${t}`} data-on={tab === t ? "1" : "0"}
                className={`min-h-[32px] whitespace-nowrap rounded-full px-3.5 py-[5px] text-[13px] font-bold ${tab === t ? "bg-deep-green text-white" : "text-deep-green/65"}`}>
                {VIEW_LABEL[t]}
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
          : <Plan week={week} byCity={tab === "plan" ? byCity : byCityTagged} openId={openId} onOpen={openMatch}
                   zone={zone} riskOf={riskOf}
                   coverage={coverage} coversOf={coversOf} tagsOf={tagsOf} tagTitleFor={tagTitleFor}
                   onAddGeneral={openGeneral} onOpenGeneral={editGeneral} viewTag={viewTag}
                   editing={open != null && draft != null} />}


      </div>
      {gen && week && (
        <GeneralPushSheet
          /* KEYED ON THE ROW. The sheet seeds its fields from `push` once, at mount, so opening a
             different card has to be a different component instance or it would show the first
             card's values. */
          key={gen.push?.id ?? `new-${gen.city}`}
          city={gen.city} push={gen.push} week={week} saving={saving}
          onClose={() => setGen(null)}
          onSave={async (payload) => {
            setSaving(true);
            try {
              /* THE ID GOES WITH IT WHEN THERE IS ONE, which is what turns this from a second
               * insert into an update of the row the card was rendered from. */
              const { res, j } = await postPromo({
                general: { ...payload, city: gen.city, ...(gen.push ? { id: gen.push.id } : {}) },
              });
              if (!res.ok || j?.outcome !== "LANDED") {
                setToast({ msg: String(j?.error ?? "That push did not save."), bad: true });
                return false;
              }
              setGen(null);
              /* RE-READ, SO THE SECTION IS RIGHT WITHOUT A RELOAD. The card list is a projection of
               * week.generals, so the same load() that already refreshed the tiles refreshes it. */
              await load(weekRef);
              return true;
            } finally { setSaving(false); }
          }}
          onRemove={async () => {
            if (!gen.push) return false;
            setSaving(true);
            try {
              const { res, j } = await postPromo({ general: { id: gen.push.id, remove: true } });
              if (!res.ok || j?.outcome !== "LANDED") {
                setToast({ msg: String(j?.error ?? "That push did not delete."), bad: true });
                return false;
              }
              setGen(null);
              await load(weekRef);
              return true;
            } finally { setSaving(false); }
          }} />
      )}
      {/* ── THE EDITOR, A FIXED PANEL ────────────────────────────────────────────────────────────
          At page level and OUTSIDE the week, which is the whole change: it used to be inserted into
          the flow under its own city block, so clicking a tile pushed the grid down and the row
          being worked on moved out from under the pointer. The job is eight cities clicked in turn,
          so that was the wrong shape. */}
      {open && draft && (
        <MatchEditorPanel m={open} draft={draft} setDraft={setDraft} zone={zone} setZone={setZone}
          dirty={dirty} saving={saving} toast={toast} tags={tagsOfRaw(open)}
          tagDates={(t) => tagDatesOf(open, t)}
          onToggleTag={(t, on, dates) => void toggleTag(open, t, on, dates)}
          onMarked={() => load(weekRef)} onError={(msg) => setToast({ msg, bad: true })}
          onSave={() => void save()} onClose={closePanel} />
      )}
      {toast && !open && (
        <div className={`fixed bottom-6 left-1/2 -translate-x-1/2 rounded-full px-4 py-2 text-[13px] font-bold text-white ${toast.bad ? "bg-coral" : "bg-deep-green"}`}>{toast.msg}</div>
      )}
    </div>
  );
}

/* ── THE TILE'S BORDER, IN ONE PLACE, BECAUSE THE KEY DRAWS ITSELF FROM IT ────────────────────
 *
 * The key used to be four hand-drawn stubs beside four words. A picture of the tiles drifts from the
 * tiles: whoever changes a rail changes it here and the key keeps showing the old one, and nothing
 * fails. So the key's swatches call THIS, with r = 0, and are miniatures of the real thing.
 *
 * border-l-dotted IS NOT A TAILWIND CLASS. Tailwind has border-dotted for all four sides and nothing
 * for one edge, so the first version of the covered rail emitted no rule at all and rendered SOLID,
 * identical to an own push — the one distinction that state exists to make. The dotted edge is an
 * inline style on the caller (tile and swatch alike) and the assertion reads the COMPUTED value
 * rather than the class list, which is what caught it.
 */
function tileBorderFor(cover: ReturnType<typeof coverageOf>, r: number): string {
  if (cover === "cancelled") return "border-dashed border-cream-line bg-[#f7f8f7]";
  if (r > 0) return WASH[r as 1 | 2 | 3 | 4] ?? "border-cream-line bg-white";
  if (cover === "needs-decision") return "border-amber-300 bg-amber-50";
  if (cover === "covered") return "border-cream-line border-l-[3px] border-l-mint bg-white";
  if (cover === "none") return "border-dashed border-cream-line bg-white";
  return "border-cream-line border-l-[3px] border-l-mint bg-white";
}

/** True when this state's left edge must be dotted. The ONLY way to dot one edge; see above. */
const tileDotted = (cover: ReturnType<typeof coverageOf>): boolean => cover === "covered";

/* ── THE FOUR TILE STATES THE KEY EXPLAINS, VERBATIM AND IN THIS ORDER ────────────────────────
 * The label always names a PUSH. The sentence is free to call the activity promotion, which is why
 * the old "the key never says promo" rule is retired rather than bent: pinning the exact words does
 * that job and cannot be argued with later.
 *
 * THE CANCELLED ROW DOES NOT MENTION THE BOOKED COUNT, deliberately: the tile already prints it in
 * the one place it matters, and repeating it in a key spends a line saying something already said. */
const TILE_STATE_KEY: readonly [ReturnType<typeof coverageOf>, string, string][] = [
  ["planned", "Match push", "Promoted individually."],
  ["covered", "Group push", "Included in a city or field push."],
  ["none", "No push planned", "No promotion scheduled."],
  ["cancelled", "Cancelled", "Match called off."],
];

/* ── THE MATCH EDITOR AS A FIXED SIDE PANEL ───────────────────────────────────────────────────
 *
 * FULL HEIGHT, 420px, ON THE RIGHT. The week is padded to match rather than the panel overlaying
 * it, so no tile is ever hidden behind it — see the padding note in Plan, which is where the trap
 * lives.
 *
 * THREE REGIONS, AND ONLY THE MIDDLE ONE SCROLLS. The title has to stay legible while scrolling a
 * six-channel editor (there is nothing else on screen naming which of 88 tiles this is), and Save
 * must stay reachable without scrolling back to find it. A panel whose footer scrolls away is a
 * panel where someone types a plan and never saves it.
 *
 * NO × IN THE CORNER. Escape and Cancel are the two ways out, which is what was asked for; a third
 * control doing the same thing is a third thing to keep in step with the unsaved rule.
 *
 * THE CODE STAYS ON THE CHANNEL. PushPlanEditor already renders one code input inside each lit
 * channel and none inside an off one, so this panel does not touch codes at all — putting one on
 * this header would undo the per-channel split in the one place an operator types it.
 */
function MatchEditorPanel({ m, draft, setDraft, zone, setZone, dirty, saving, toast, tags, tagDates, onToggleTag, onMarked, onError, onSave, onClose }: {
  m: PromoMatch; draft: PushDraft; setDraft: (d: PushDraft) => void;
  zone: ZoneMode; setZone: (z: ZoneMode) => void;
  dirty: boolean; saving: boolean; toast: { msg: string; bad: boolean } | null;
  /** This match's tags at both scopes, raw and unsuppressed. */
  tags: TagKey[];
  /** A field tag's dates (0207), or null when undated. */
  tagDates: (t: TagKey) => TagDates | null;
  onToggleTag: (t: TagKey, on: boolean, dates?: TagDates) => void;
  onMarked: () => void | Promise<void>; onError: (msg: string) => void;
  onSave: () => void; onClose: () => void;
}) {
  return (
    <aside data-testid="panel" data-dirty={dirty ? "1" : "0"} aria-label="Match push plan"
      className="fixed right-0 top-0 bottom-0 z-40 flex w-full flex-col border-l border-cream-line bg-white shadow-[-8px_0_24px_rgba(0,0,0,0.06)] md:w-[420px]">
      <div className="flex-none border-b border-cream-line px-3.5 py-3">
        <div className="text-[14px] font-extrabold" data-testid="panel-title">
          {m.venue} · {DOW[m.dayIdx]} {m.time}
        </div>
        <div className="mt-px text-[11.5px] text-deep-green/45">{m.city}</div>
      </div>
      {/* THE ONLY SCROLLING REGION. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3">
        {/* ── FIELD TAGS, AND THEY MOVED HERE WITH THE PANEL ───────────────────────────────────
            They were inside the inline editor, so detaching that would have deleted the only way to
            set a tag. Still keyed on the FIELD: tagging this match tags the pitch, on every tile it
            appears on, this week and next. */}
        {/* ── TAGS, GROUPED BY SCOPE, AND THE HEADING IS THE WHOLE FIX ─────────────────────────
            Three pills that look alike where one affects a match and two affect a week of them is
            how someone tags one match and finds seven tagged. "Every match at <field>" says out loud
            what the control does before it is pressed.
            THE TOGGLES READ THE TRUE SET, not the tile's suppressed one: a PRIORITY hidden under a
            KEY FIELD still comes up lit here, because a toggle showing it dark would let the next
            save clear a tag nobody meant to clear. */}
        <div className="mb-3" data-testid="tagset">
          <p className="m-0 mb-1.5 text-[10px] font-extrabold uppercase tracking-[0.08em] text-deep-green/45">Tags</p>
          {(["match", "field"] as const).map((scope) => {
            const keys = tagsAtScope(scope);
            if (keys.length === 0) return null;
            // A FIELD-SCOPED GROUP NEEDS A FIELD. A match with no field_id can still take PRIORITY.
            if (scope === "field" && m.fieldId == null) return null;
            return (
              <div key={scope} data-testid="tagscope" data-scope={scope}
                className="mb-1.5 rounded-[9px] border border-cream-line bg-[#fbfdfc] px-2.5 py-2">
                <span className="mb-1.5 block text-[10px] font-extrabold uppercase tracking-[0.06em] text-deep-green/45">
                  {scope === "match" ? "This match only" : `Every match at ${m.venue}`}
                </span>
                <span className="flex flex-wrap gap-1.5">
                  {keys.map((t) => {
                    const on = tags.includes(t);
                    // STARTING 11 IS DATED (0207): its own control, with a required start date.
                    if (t === "starting_11") return <Starting11Control key={t} on={on} dates={tagDates(t)} saving={saving}
                      defaultStart={m.startDate ? String(m.startDate).slice(0, 10) : ""}
                      onSet={(d) => onToggleTag(t, true, d)} onClear={() => onToggleTag(t, false)} />;
                    return (
                      <button key={t} type="button" data-testid="tag-toggle" data-t={t} data-on={on ? "1" : "0"}
                        aria-pressed={on} disabled={saving} title={tagTitle(t)}
                        onClick={() => onToggleTag(t, !on)}
                        className="min-h-[32px] rounded-[7px] border px-2.5 text-[11px] font-extrabold tracking-[0.03em]"
                        style={on
                          ? { color: "#fff", background: TAG_META[t].colour, borderColor: TAG_META[t].colour }
                          : { color: TAG_META[t].colour, borderColor: TAG_META[t].colour, background: "transparent" }}>
                        {TAG_META[t].label}
                      </button>
                    );
                  })}
                </span>
              </div>
            );
          })}
        </div>
        {/* ONE EDITOR, SHARED WITH THE PHONE. Not a desktop copy of a channel block. */}
        <PushPlanEditor m={m} draft={draft} setDraft={setDraft} zone={zone} setZone={setZone}
          cancelled={m.state === "cancelled"} onMarked={onMarked} onError={onError} />
      </div>
      <div className="flex flex-none flex-wrap items-center gap-2.5 border-t border-cream-line px-3.5 py-2.5">
        <button onClick={onSave} disabled={saving} data-testid="save"
          className="rounded-full bg-deep-green px-[15px] py-1 text-[12.5px] font-extrabold text-white disabled:opacity-50">
          {saving ? "Saving…" : "Save plan"}
        </button>
        <button type="button" onClick={onClose} data-testid="cancel"
          className="min-h-[32px] px-1.5 text-[12.5px] font-bold text-deep-green/65">
          Cancel
        </button>
        {/* THE UNSAVED MARKER IS THE WHOLE EXPLANATION for why another tile refuses to open. Without
            it the ignored click reads as the page being broken rather than as the panel holding on
            to what was typed. */}
        {dirty && (
          <span data-testid="dirty" className="ml-auto text-[11.5px] font-extrabold text-coral">
            Unsaved · Save or Cancel
          </span>
        )}
        {toast && <span className={`text-[12px] font-bold ${toast.bad ? "text-coral" : "text-emerald-700"}`}>{toast.msg}</span>}
      </div>
    </aside>
  );
}

/** "Mon 17 Aug – Sun 23 Aug" for a Monday ISO date. Built component-wise from the string: these
 *  are calendar dates with no zone, and re-parsing one through a Date with a time is the trap. */
/* THE WINDOW THE NEW BADGE COMPARED AGAINST. `weeks` spans it: one week ends on its own Sunday,
 * four weeks end on the Sunday 27 days after the Monday it starts on. Passed in from
 * week.priorWeeks rather than typed as a 4 here, so the label follows NEW_LOOKBACK_WEEKS instead of
 * having to be remembered alongside it. */
function weekRangeLabel(mondayIso: string, weeks = 1): string {
  const [y, m, d] = mondayIso.split("-").map(Number);
  if (!y || !m || !d) return mondayIso;
  const mon = new Date(y, m - 1, d);
  const sun = new Date(y, m - 1, d + 7 * weeks - 1);
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
      {/* PAST WEEKS TAKE MARK SENT TOO (Ryan, 2026-10-05): a push that went out last week still
          needs recording, so the past-week lock is gone. `past` stays for the row's other states. */}
      {!sent && <MarkPushSent push={p} onDone={onMarked} onError={onError} />}
    </div>
  );
}

/** How many of the week's matches this general push actually reaches, on its own day. */
function generalReach(g: GeneralPush, week: PromoWeek): number {
  return week.matches.filter((m) =>
    m.state !== "cancelled" && generalsCovering(m, [g], week.days).length > 0).length;
}

/** An instant as `datetime-local` characters in the READER'S clock. "" when there is no time. */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** The field's name, from the week rather than from a second lookup. */
function fieldNameOf(g: GeneralPush, week: PromoWeek): string {
  return week.matches.find((m) => m.fieldId === g.fieldId)?.venue ?? "field";
}

/** This city's general pushes: its own, plus every undated one, which byPushTime sorts last. */
function generalsForCity(week: PromoWeek, city: string): GeneralPush[] {
  return week.generals.filter((g) => g.city === city);
}

/* ── THE CITY'S GENERAL PUSHES, ON THE PAGE ───────────────────────────────────────────────────
 *
 * THEY SAVED. THEY WERE NEVER RENDERED. `week.generals` reached this file and was read in exactly
 * three places — coverageOf, generalsCovering, and the count of covered matches — every one of them
 * a question about a MATCH tile. So a city push existed, changed the dotted rails on four tiles,
 * and could not be seen, named, corrected or deleted. Teresa saved them and they vanished.
 *
 * A SECTION PER CITY, BETWEEN THE HEADER AND THE GRID. A general push belongs to the city, not to a
 * day, so it cannot live in a day cell; and it is the thing the "+ General push" button in that same
 * header creates, so it belongs next to it. It is hidden entirely when the city has none — an empty
 * box on eight cities is eight boxes saying nothing.
 *
 * THE CARD IS THE WAY IN. Clicking one opens it in the sheet it was created in, pre-filled, which is
 * what makes a wrong time or a wrong code fixable and an undated push datable. */
function GeneralPushes({ city, week, onOpen }: {
  city: string; week: PromoWeek; onOpen: (g: GeneralPush) => void;
}) {
  const gs = generalsForCity(week, city);
  if (gs.length === 0) return null;
  return (
    <div data-testid="general-pushes" data-city={city} data-count={gs.length}
      className="mb-2.5 rounded-xl border border-[#a5e4ee] bg-[#ecfeff] px-3 py-2.5">
      <h3 className="m-0 mb-2 flex items-center gap-2 text-[10px] font-extrabold uppercase tracking-[0.09em] text-[#0e7490]">
        General pushes
        <span data-testid="general-push-count"
          className="rounded-full border border-[#a5e4ee] bg-white px-[7px] text-[11px] font-bold">{gs.length}</span>
      </h3>
      <div className="flex flex-wrap gap-2">
        {gs.map((g) => {
          const t = fmtPushIn(g.pushAt, "me", null);
          /* THE READER'S OWN CLOCK, and null-safe: a general push has no venue, so there is no
             venue offset to shift it by. The same call the day queue makes for a match-less push. */
          const chans = CHANNELS.filter((c) => c.key === g.channel);
          /* TOPIC FIRST, AUDIENCE AS THE FALLBACK. A push saved with no topic is not nameless — the
             operator typed who it was going to, and "all registered in Atlanta" identifies it. */
          const title = g.topic?.trim() || g.audience?.trim() || "General push";
          const status = g.pushedAt ? "SENT" : g.pushAt ? "SCHEDULED" : "NO DATE";
          return (
            <button key={g.id} type="button" data-testid="general-push-card" data-id={g.id}
              data-scope={g.scope} data-dated={g.pushAt ? "1" : "0"}
              onClick={() => onOpen(g)}
              className="min-w-[220px] max-w-[280px] rounded-[10px] border border-[#a5e4ee] border-l-4 border-l-[#0e7490] bg-white px-2.5 py-2 text-left hover:shadow-[0_1px_4px_rgba(0,0,0,0.08)]">
              <div className="text-[12.5px] font-extrabold" data-testid="general-push-title">
                {title}
                <span data-testid="general-push-status"
                  className={`ml-1.5 text-[9.5px] font-extrabold tracking-[0.06em] ${g.pushAt ? "text-[#0e7490]" : "text-amber-700"}`}>
                  {status}
                </span>
              </div>
              <div className="mt-[3px] flex flex-wrap items-center gap-1 text-[11.5px] text-deep-green/65">
                {chans.map((c) => (
                  <i key={c.key} data-testid="general-push-chan"
                    className="inline-flex items-center rounded-[5px] border border-mint/40 bg-mint-soft/50 px-[5px] text-[9.5px] font-extrabold not-italic text-emerald-700">
                    {c.short}
                  </i>
                ))}
                {/* AN UNDATED PUSH SAYS SO IN AMBER, where the time would be. It is the one thing
                    wrong with the push and the only thing a click can fix, so it reads as the
                    warning it is rather than as a blank. */}
                {g.pushAt
                  ? <b data-testid="general-push-when" className="font-extrabold text-deep-green">{t.day} {t.time}</b>
                  : <b data-testid="general-push-when" data-warn="1" className="font-extrabold text-amber-700">No send time</b>}
                {/* THE FIELD IT IS SCOPED TO, ON THE CARD. A field push sits in its city's section
                    because that is where it was created, and without the name it is indistinguishable
                    from the city-wide push beside it. */}
                {g.scope === "field" && (
                  <span data-testid="general-push-field" className="text-[11px] text-deep-green/55">
                    &middot; {fieldNameOf(g, week)}
                  </span>
                )}
                {g.promoCode && (
                  <span data-testid="general-push-code"
                    className="rounded-[5px] border border-amber-300 bg-amber-50 px-[5px] text-[9.5px] font-extrabold text-amber-800">
                    {g.promoCode}
                  </span>
                )}
              </div>
              {g.topic?.trim() && g.audience?.trim() && (
                <div data-testid="general-push-aud" title={g.audience}
                  className="mt-[3px] max-w-[260px] truncate text-[11.5px] text-deep-green/45">{g.audience}</div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
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
function GeneralPushSheet({ city, push, week, saving, onClose, onSave, onRemove }: {
  city: string;
  /** Null creates. A push EDITS that row — same sheet, pre-filled, and the id travels with save. */
  push: GeneralPush | null;
  week: PromoWeek; saving: boolean; onClose: () => void;
  onSave: (p: { scope: "city" | "field"; channel: string; at: string | null; topic: string | null;
                promoCode: string | null; fieldId: number | null; audience: string | null }) => Promise<boolean>;
  onRemove: () => Promise<boolean>;
}) {
  const [scope, setScope] = useState<"city" | "field">(push?.scope ?? "city");
  const [channel, setChannel] = useState<string>(push?.channel ?? CHANNELS[0]?.key ?? "wa");
  /* THE INPUT WANTS LOCAL CHARACTERS, THE ROW HOLDS AN INSTANT. Same pair the push editor runs, in
   * the reader's own clock — a general push has no venue to be shifted by. */
  const [at, setAt] = useState(() => toLocalInput(push?.pushAt ?? null));
  const [topic, setTopic] = useState(push?.topic ?? "");
  const [code, setCode] = useState(push?.promoCode ?? "");
  const [audience, setAudience] = useState(push?.audience ?? `all registered in ${city}`);
  const [fieldId, setFieldId] = useState<number | "">(push?.fieldId ?? "");

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
          <h3 className="m-0 text-[14px] font-extrabold" data-testid="gen-heading">
            {push ? "Edit general push" : "General push"} &middot; {city}
          </h3>
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
          {/* DELETE EXISTS ONLY WHEN THERE IS A ROW TO DELETE. The route has always accepted a
              remove; nothing on the page could reach it, so a push saved by mistake was permanent. */}
          {push && (
            <button type="button" data-testid="gen-remove" disabled={saving} onClick={() => void onRemove()}
              className="ml-auto min-h-[32px] rounded-full border border-coral/40 px-3 text-[12.5px] font-bold text-coral disabled:opacity-50">
              Delete
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Plan({ week, byCity, openId, onOpen, zone, editing, riskOf, coverage, coversOf, tagsOf, tagTitleFor, onAddGeneral, onOpenGeneral, viewTag }: {
  week: PromoWeek; byCity: [string, PromoMatch[]][]; openId: number | null; zone: ZoneMode;
  /** The tile's cancel history, keyed on field and weekday with times CLUSTERED. See cancelPatterns. */
  riskOf: (m: PromoMatch) => SlotRisk | null;
  /** Derived once at page level so the header and the tiles under it cannot describe different sets. */
  coverage: Map<number, ReturnType<typeof coverageOf>>;
  coversOf: (m: PromoMatch) => GeneralPush[];
  tagsOf: (m: PromoMatch) => TagKey[];
  /** A tag's tooltip on one match, with its date range when it has one (0207). */
  tagTitleFor: (m: PromoMatch, t: TagKey) => string;
  /** Non-null on a tag view: the grid is already filtered to it, and the heading says which. */
  viewTag: TagKey | null;
  onAddGeneral: (city: string) => void;
  /** Opens an EXISTING general push in the sheet it was created in. Same sheet, pre-filled. */
  onOpenGeneral: (g: GeneralPush) => void;
  onOpen: (m: PromoMatch, el: HTMLElement) => void;
  // THE PANEL OPENS INLINE, UNDER THE CITY WHOSE TILE WAS CLICKED — not at the foot of the page.
  // Rendering it once at page level meant clicking an Atlanta match scrolled you past every other
  // city to reach the editor. A panel that is correct but a page away is the bug.
  /* THE EDITOR IS NO LONGER IN THIS TREE. It is a fixed panel rendered at page level, so all Plan
   * needs to know is whether to make room for it. `openCity` went with the inline panel: it existed
   * only to decide which city block the editor was inserted under, and there is no insertion now. */
  /** True while the side panel is open. Pads the WEEK — see the note on the padding below. */
  editing: boolean;
}) {
  const priorLabel = weekRangeLabel(week.priorWeekStart, week.priorWeeks);
  /* THE KEY READS THE WHOLE WEEK, NOT THE FILTERED GRID. On a tag view every tile carries that tag
   * by construction, so a key built from the visible set would list exactly one entry and stop
   * explaining the others. */
  const keyTags = tagsInUse(week.matches.map((m) => tagsOf(m)));
  /* THE TILE COUNT, FROM THE ROWS BEING RENDERED. On a tag view this is the whole claim the view
   * makes, so it is counted off `byCity` rather than recomputed from the week. */
  const shown = byCity.reduce((n, [, ms]) => n + ms.length, 0);
  return (
    <>
      <div className="px-5 pb-0.5 pt-1">
        <h2 className="m-0 text-[15px] font-extrabold uppercase tracking-[0.02em]" data-testid="grid-heading">
          {viewTag ? TAG_META[viewTag].label : "The week"}
        </h2>
        {/* A FILTERED GRID SAYS SO, AND SAYS WHAT IT DROPPED. A grid that is quietly a subset is a
            grid someone reads as the whole week. The count is the view's own claim, asserted. */}
        {viewTag && (
          <div className="mt-0.5 text-[11.5px] font-bold text-deep-green/55" data-testid="grid-filter-note">
            <b data-testid="grid-shown">{shown}</b> match{shown === 1 ? "" : "es"} carrying{" "}
            {TAG_META[viewTag].label} · {byCity.length} cit{byCity.length === 1 ? "y" : "ies"} ·
            {" "}the day queue above is the whole week, unfiltered
          </div>
        )}
        {/* ── THE KEY: TWO GRIDS OF ROWS, EACH SWATCH RENDERED FROM THE TILE'S OWN RULES ──────
            The swatch strip it replaces was four coloured stubs and a word. These are LIVE SWATCHES:
            each one is a miniature of the tile it explains, built from the same border expression
            (tileBorderFor), so a key that drifts from the tiles is not possible without the tiles
            changing too. The assertion reads the COMPUTED style, not the class name, which is what
            caught border-l-dotted emitting nothing at all.

            THE WORDING IS VERBATIM and the label and the sentence are separate elements, so a
            mismatch names which half is wrong rather than handing back one long string. The label
            always names a PUSH; the sentence is free to call the activity promotion. */}
        <div className="mt-2" data-testid="key">
          <div className="grid gap-x-5 gap-y-1 sm:grid-cols-2" data-testid="key-states">
            {TILE_STATE_KEY.map(([state, label, sentence]) => (
              <span key={state} data-testid="keystate" data-state={state}
                className="inline-flex items-baseline gap-2 text-[11px] text-deep-green/65">
                {/* THE SWATCH IS THE TILE. Same border expression, same wash-free base. */}
                <i data-testid="keyswatch" data-state={state}
                  style={tileDotted(state) ? { borderLeftStyle: "dotted" } : undefined}
                  className={`mt-[2px] inline-block h-[13px] w-[26px] flex-none rounded-[4px] border ${tileBorderFor(state, 0)} ${
                    state === "cancelled" ? "opacity-60" : ""}`} />
                <b data-testid="keylab" className="whitespace-nowrap font-extrabold text-deep-green/80">{label}</b>
                <span data-testid="keysent">{sentence}</span>
              </span>
            ))}
          </div>
          {/* THE TAGS IN USE THIS WEEK, in the key's own order: Starting 11, Priority, Key Field.
              NO SCOPE LABEL. The sentences carry it ("for this match", "for all matches here")
              better than a repeated lead-in did, and a label restating the sentence is noise. */}
          {keyTags.length > 0 && (
            <div className="mt-1.5 grid gap-x-5 gap-y-1 sm:grid-cols-2" data-testid="key-tags">
              {keyTags.map((t) => (
                <span key={t} data-testid="keyitem" data-t={t} title={tagTitle(t)}
                  className="inline-flex items-baseline gap-2 text-[11px] text-deep-green/65">
                  {/* THE SWATCH AND THE TILE READ ONE VALUE. This is the element that shipped the
                      contradiction: the tile was dashed and this was not, so the key described
                      something the reader could not see. Both take colour AND border from
                      TAG_META, so a change to a tag cannot reach one and miss the other. */}
                  <i data-testid="tag-key-swatch" data-t={t}
                    className="rounded-[4px] border border-solid px-[4px] py-px text-[8.5px] font-extrabold not-italic tracking-[0.03em]"
                    style={{ color: TAG_META[t].colour, borderColor: TAG_META[t].colour }}>{TAG_META[t].label}</i>
                  <span>{TAG_META[t].why}</span>
                </span>
              ))}
              {/* THE DERIVED BADGE IN THE SAME KEY, so a reader meets one vocabulary. */}
            </div>
          )}
          {/* ── THE CANCEL SCALE, AND ALL FOUR RUNGS ALWAYS RENDER ────────────────────────────
              A TAG applies or it does not, so listing only the ones in use is right for tags. A
              SCALE is different: its steps mean something only against each other, and a key
              showing 1W AGO alone tells a reader nothing about whether that is the loud end or the
              quiet one. So all four render every week, including a week using none of them. */}
          <div className="mt-2 grid gap-x-5 gap-y-1 border-t border-cream-line pt-2 sm:grid-cols-2" data-testid="key-recency">
            <span data-testid="keyitem" className="inline-flex items-baseline gap-2 text-[11px] text-deep-green/65">
              <i className="shrink-0 rounded-[4px] px-[5px] py-px text-[9px] font-extrabold not-italic tracking-[0.03em]"
                style={{ background: RAMP_HEX[2], color: RAMP_INK[2] }}>2/4</i>
              <span>Cancelled in 2 of the last 4 weeks.</span>
            </span>
            {([1, 2, 3, 4] as const).map((w) => (
              <span key={w} data-testid="keyitem" data-w={w} className="inline-flex items-baseline gap-2 text-[11px] text-deep-green/65">
                <i data-testid="key-recency-swatch" data-w={w}
                  className={`shrink-0 rounded-[3px] border px-[4px] py-px text-[8px] font-extrabold not-italic tracking-[0.04em] ${AGE_CLASS[w]}`}>
                  {w}W AGO
                </i>
                <span>Last cancelled {w} week{w === 1 ? "" : "s"} ago.</span>
              </span>
            ))}
            <span data-testid="keyitem" className="text-[11px] text-deep-green/50">
              Nothing older than 4 weeks is marked.
            </span>
            {/* THE BORDER-STYLE LINE STOOD HERE AND IS GONE WITH THE RULE IT EXPLAINED. Nothing is
                told apart by border any more, and the scope is already carried by the descriptions
                above: "Extra promotion for this match" against "for all matches here". */}
          </div>
        </div>
      </div>
      {/* ── THE PADDING GOES ON THE WEEK, NOT ON THE PAGE ──────────────────────────────────────
          THIS IS THE TRAP, AND IT WAS HIT ON THE FIRST ATTEMPT. Padding the page wrapper narrows
          everything, which reflows the day tabs and the queue ABOVE the grid and pushes the grid
          down 47px — precisely the problem a fixed panel exists to solve. Only the city list
          narrows. Nothing above it is inside this div, so nothing above it can move, and the
          assertion measures exactly that: the first city block's top, before and after, equal.

          THE TILES NARROW RATHER THAN THE WEEK SCROLLING. The mock's week sits in its own
          horizontal scroller; this one is a seven-column grid that shrinks, so at 1320px the
          columns go from about 180px to about 121px. Nothing hides under the panel either way,
          which is what the padding is for. A tile whose venue name wraps onto a second line does
          grow taller, which can move a tile in a city FURTHER DOWN the page — that is what anchor()
          already handles, by restoring the clicked tile's own viewport offset after paint. */}
      <div className={editing ? "pr-[432px] transition-[padding] duration-150" : ""} data-testid="week-pad">
      {/* AN EMPTY TAG VIEW SAYS SO. starting_11 has no rows in production today, so this is the
          state that actually renders — and a page that just stops after the heading reads as a load
          failure. It also gives the assertion something to find, which is what separates a real zero
          from a filter that matched nothing because it was broken. */}
      {/* THE STARTING 11 TAG VIEW SAYS WHICH FIELDS CARRY IT AND FOR WHICH DATES (0207). */}
      {viewTag === "starting_11" && (() => {
        const names = new Map<number, string>();
        for (const m of week.matches) if (m.fieldId != null && !names.has(m.fieldId)) names.set(m.fieldId, `${m.venue} · ${m.city}`);
        const rows = Object.entries(week.tagsByField ?? {}).filter(([, ts]) => ts.includes("starting_11"))
          .map(([fid]) => ({ fid: Number(fid), name: names.get(Number(fid)) ?? `Field ${fid}`, range: tagRangeLabel(week.tagDatesByField?.[Number(fid)]?.starting_11) }))
          .sort((a, b) => a.name.localeCompare(b.name));
        if (rows.length === 0) return null;
        return (
          <ul className="m-0 list-none px-5 pb-3 pt-1 text-[12px] text-deep-green/60" data-testid="s11-list">
            {rows.map((r) => (
              <li key={r.fid} data-testid="s11-list-row"><b className="text-deep-green/80">{r.name}</b> · {r.range ?? "no dates set, shows on every week"}</li>
            ))}
          </ul>
        );
      })()}
      {viewTag && byCity.length === 0 && (
        <p className="px-5 pb-4 pt-1 text-[12.5px] text-deep-green/45" data-testid="grid-empty">
          No match this week is at a field tagged {TAG_META[viewTag].label}. Tags are set from a
          tile&rsquo;s own panel.
        </p>
      )}
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
            {/* BETWEEN THE HEADER AND THE GRID, and it renders nothing when the city has none. */}
            <GeneralPushes city={city} week={week} onOpen={onOpenGeneral} />
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
                      priorLabel={priorLabel} priorWeeks={week.priorWeeks} risk={riskOf(m)} cover={coverage.get(m.apiId) ?? "none"}
                      covers={coversOf(m)} tags={tagsOf(m)} tagTitle={(t) => tagTitleFor(m, t)} shifted={m.shiftedFrom} />)}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
      </div>
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
/* ── THE FOUR RUNGS OF RECENCY, ONE SHAPE ───────────────────────────────────────────────────
 * Last week is the loudest and four weeks ago is the quietest, and all four are the same pill at
 * four weights. A different SHAPE for the newest would make it read as a different kind of fact;
 * these are four steps of one scale, and a scale is only legible against its own other steps. */
const AGE_CLASS: Record<1 | 2 | 3 | 4, string> = {
  1: "border-transparent bg-[#3A1710] text-white",
  2: "border-transparent bg-[#EBD9D3] text-[#6B2A18]",
  3: "border-[#d8c8c2] bg-transparent text-[#8a6d63]",
  4: "border-[#e4dbd8] bg-transparent text-[#a9a09c]",
};

function Tile({ m, open, onOpen, zone, priorLabel, priorWeeks, risk, cover, shifted, covers, tags, tagTitle: titleOf }: {
  m: PromoMatch; open: boolean; onOpen: (m: PromoMatch, el: HTMLElement) => void; zone: ZoneMode;
  /** The tag's tooltip on THIS match, dates included (0207). */
  tagTitle?: (t: TagKey) => string;
  priorLabel: string; priorWeeks: number; risk?: SlotRisk | null;
  /** planned | covered | none | needs-decision | cancelled, derived once at page level. */
  cover: ReturnType<typeof coverageOf>;
  /** What this slot ran at before, when its time moved INSIDE the cluster window. Null otherwise. */
  shifted: { times: string[]; weeks: number } | null;
  /** The general pushes that carried it, for the label. Empty unless `cover` is "covered". */
  covers: GeneralPush[];
  tags: TagKey[];
}) {
  /* A CHIP PER CHANNEL THAT HAS A PUSH, or is on with none — which is what "on" is now. */
  const lit = CHANNELS.filter((c) => channelsOn(m.plan).includes(c.key));
  /* ONE CHIP, AND A COUNT WHEN THERE IS MORE THAN ONE CODE. Codes are per push now, so "the
   * match's code" can be two different codes; a 96px day cell prints one, and the "+1" is what
   * stops it reading as the only one. The panel is where you see which push carries which. */
  const codes = matchCodes(m.plan);
  const summary = tileSummary(m, zone);
  const cancelled = cover === "cancelled";
  const r = risk?.cancelCount ?? 0;
  /* KEY FIELD SWALLOWS PRIORITY HERE, inside splitTags -> tagsForDisplay. A match at a KEY FIELD is
   * already one we are pushing harder, so a PRIORITY pill beside it says nothing and spends a third
   * of the row. THE PANEL READS THE RAW SET and still lights the hidden toggle, which is what stops
   * the next save clearing a tag nobody meant to clear. */
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
  const border = tileBorderFor(cover, r);
  return (
    <div data-testid="match-tile" data-state={m.state} data-api-id={m.apiId} data-open={open ? "1" : "0"}
      data-new={m.newFlag ?? ""} data-r={r} data-cover={cover}
      /* THE FIELD ID, so an assertion can tell a field-scoped tag from a match-scoped one without
         trusting the pill to describe itself. */
      data-field-id={m.fieldId ?? ""}
      data-booked={cancelled ? String(m.playerCount ?? 0) : undefined}
      /* THE EXACT TIME LIVES IN THE TITLE, because the tile is coloured on a slot key whose times
         are clustered — a slot that drifted from 8:00 to 8:30 is one slot to a player and must be
         one slot here, but the operator still needs to see which time this match actually is. */
      /* ── THE SHIFT THAT NO LONGER BADGES STILL SAYS SO ON HOVER ────────────────────────────
         A slot that moved INSIDE the cluster window is one slot to the cancel ramp, so it stopped
         badging NEW TIME - the tile cannot say "this slot cancelled 2 of 4" and "this time is new"
         at once and be believed. What the operator actually wanted was the old time, which a badge
         could never carry. It goes here, beside the cancel history, in the one tooltip. */
      title={[
        shifted && `Moved from ${shifted.times.join(", ")}, which ran ${shifted.weeks} of the last ${priorWeeks} weeks. Same slot, so it is not new.`,
        risk && `Cancelled in ${r} of the last 4 weeks. Seen at ${risk.times.join(", ")}.`,
      ].filter(Boolean).join(" ") || undefined}
      style={tileDotted(cover) ? { borderLeftStyle: "dotted" } : undefined}
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
        {/* ── HOW OFTEN, THEN WHEN ────────────────────────────────────────────────────────────
            The ratio never said when. Two slots reading 2/4 — one last cancelled a month ago, one
            last week — are the same chip and opposite decisions; the Monday column is that pair.
            ONE SHAPE FOR ALL FOUR, NO SPECIAL CASE FOR THE NEWEST. "LAST WK" beside "2W" would make
            the newest step read as a different KIND of thing rather than the loudest step of one
            scale, and a scale's steps only mean anything against each other.
            THE RAMP IS NOT RE-KEYED. The ratio chip keeps its colour and its meaning; this is a
            second fact beside it, falling off as it ages. */}
        {risk && (
          <i data-testid="recency" data-w={risk.lastCancelWeeksAgo}
            title={`Last cancelled ${risk.lastCancelWeeksAgo} week${risk.lastCancelWeeksAgo === 1 ? "" : "s"} ago. Nothing older than 4 weeks is marked.`}
            className={`shrink-0 rounded-[3px] border px-[4px] py-px text-[8px] font-extrabold not-italic tracking-[0.04em] ${AGE_CLASS[risk.lastCancelWeeksAgo]}`}>
            {risk.lastCancelWeeksAgo}W AGO
          </i>
        )}
        {m.newFlag && (
          <i data-testid="new-badge" data-flag={m.newFlag}
            /* THE RULE, THE CITY AND THE WEEK IT COMPARED, on the badge itself. The dates are
               what makes a wrong comparison visible instead of silent.
               THE WINDOW IS IN THE WORDS, AND IT IS FOUR WEEKS. It said "last week's slate", which
               was the whole bug: a slot that ran three weeks, skipped one and came back read NEW
               because the single week it was compared against was the one it missed. The count
               comes from priorWeeks so the sentence cannot go stale against the constant.
               RETURNING SAYS SOMETHING ELSE ENTIRELY — it names the label it displaced, which is
               the only way to check from the screen that the interception fired rather than that
               no tag happened to apply. */
            title={m.newFlag === "back"
              ? `This slot was not on last week's slate for ${m.city}, but it has run at ${m.venue} at this time before.${m.wouldBe ? ` Without this it would read ${NEW_FLAG_LABEL[m.wouldBe]}.` : ""} Every slate on record was searched. Cancelled matches count as scheduled.`
              : m.newFlag === "time"
              ? `This field and weekday ran at a nearby kick-off on the last ${priorWeeks} weeks' slates for ${m.city} (${priorLabel})${m.movedFrom ? `, and ${m.movedFrom} is gone` : ""} — so this is a move, not an extra match.`
              : `This ${m.newFlag === "field" ? "field" : "slot for this field"} was not on the last ${priorWeeks} weeks' slates for ${m.city} (${priorLabel}), and nothing was dropped to make room for it. Cancelled matches count, because a cancelled slot was still scheduled and still published.`}
            /* THE THREE THAT MEAN NEW SHARE THE DEEP GREEN FILL. RETURNING is filled too — it is a
               claim, not an absence — but in slate blue, because it is the OPPOSITE claim. Asserted
               by computed colour rather than by class name. */
            className={`shrink-0 rounded-[4px] px-[5px] py-px text-[8.5px] font-extrabold not-italic tracking-[0.04em] text-white ${m.newFlag === "back" ? "bg-[#4A5C8A]" : "bg-deep-green"}`}>
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
            /* ── THREE TAGS, THREE COLOURS, ALL SOLID ──────────────────────────────────────────
               THE BORDER NO LONGER CARRIES ANYTHING. PRIORITY and KEY FIELD shared one colour and
               were split solid-against-dashed; it did not read at tile size, and the legend swatch
               rendered solid under a caption saying dashed, so the key contradicted the page. The
               dashed rule is GONE rather than left on an element nobody compares.
               THE COLOUR IS THE WHOLE SIGNAL NOW, and it comes from TAG_META — the same value the
               legend swatch reads, which is what makes the two incapable of disagreeing.
               ALL THREE STAY OUTLINED, NEVER FILLED. The tile already spends filled pills on the
               cancel ratio and the NEW badge; a filled tag reads as a 4/4 cancel at a glance.
               PRIORITY IS STILL SWALLOWED where a KEY FIELD covers it — see splitTags above. */
            <i key={t} data-testid="tag" data-t={t} data-scope={TAG_META[t].scope} title={titleOf ? titleOf(t) : tagTitle(t)}
              className="rounded-[4px] border border-solid px-[4px] py-px text-[8.5px] font-extrabold not-italic tracking-[0.03em]"
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
      {(lit.length > 0 || codes.length > 0) && (
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
          {codes.length > 0 && (
            <span data-testid="tile-code" className="rounded-[5px] border border-amber-300 bg-amber-50 px-[5px] py-px text-[9.5px] font-extrabold text-amber-800">
              {codes[0]}{codes.length > 1 && ` +${codes.length - 1}`}
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
  const { rows, scheduledMatches, meta, loading } = useMatchData();
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
    /* THE SCHEDULE, NOT ONLY THE BOOKINGS: a match cancelled with nobody booked has no row and used
     * to vanish from the tile's history (STAR Thu/Fri Oct 1–2, 8:30pm, cancelled at 0/20). */
    () => (anchor ? getCancelPatterns(rows, aliases, "patterns", anchor, scheduledMatches) : null),
    [rows, scheduledMatches, aliases, anchor],
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
