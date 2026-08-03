"use client";

// Consolidated Reviews page (mockup docs/mockups/reviews-v1_3.html). Ported
// rule-for-rule, not pixel-for-pixel: every number derives from one filtered
// array via src/lib/reviewsDerive.ts (the same module the reconciliation script
// checks against), thresholds are named once and printed where they gate, and
// the comments panel keeps its own window disclosed three ways. Reads real
// mdapi_reviews through useCleanReviews (fake-player filtered at one choke
// point). Reply ticks persist in review_replies and degrade cleanly when that
// migration hasn't been applied yet.

import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/lib/useAuth";
import { useCleanReviews } from "@/lib/reviewsData";
import { useReviewReplies, type ReplyMark } from "@/lib/useReviewReplies";
import type { ReviewRow } from "@/lib/useReviewData";
import {
  MIN_RANK_REVIEWS,
  ATTN_MAX_AVG,
  ATTN_MIN_REVIEWS,
  STAND_MIN_AVG,
  STAND_MIN_REVIEWS,
  derivePage,
  deriveWeeks,
  deriveComments,
  monthsPresent,
  monthLabel,
  monthKeyOf,
  matchDateLabel,
  reviewManagerName,
  hasText,
  needsReply,
  type PageFilters,
  type CommentWindow,
} from "@/lib/reviewsDerive";

// Mist palette (mockup CSS vars)
const C = {
  forest: "#0d3b2e", forestDeep: "#072a20", accent: "#35c77f", mint: "#e0f2e7",
  ink: "#12241d", muted: "#6d7b74", warnBg: "#fdf1d0", warnInk: "#8a6300", warnLine: "#e3c369",
  critBg: "#fdeae4", critInk: "#a8391a", critLine: "#f0bda9", ok: "#12704a",
  railB: "#f6f9f7", chipBg: "#eef3f0", chipLine: "#e2eae5", line: "#e6ebe8", hair: "#eff3f1",
  surface: "#ffffff", muted2: "#9aa8a1",
};
const CITY_HUE: Record<string, string> = {
  Austin: "#3f7d23", Dallas: "#3741ae", Houston: "#b04583", "San Antonio": "#8c421d",
  Philadelphia: "#457ab0", Atlanta: "#ae7337", "St. Louis": "#37aea4",
  "Oklahoma City": "#791d8c", "El Paso": "#7d8c2a",
};
const hue = (c: string) => CITY_HUE[c] ?? C.muted2;
const nf = (n: number) => n.toLocaleString();
// pluralize: "match" → "matches", "review" → "reviews" (handles the -ch/-sh/-s/-x
// sibilant case so the AVG tile never reads "364 matchs").
const plural = (n: number, s: string) => {
  if (n === 1) return `${nf(n)} ${s}`;
  const es = /(ch|sh|s|x)$/i.test(s);
  return `${nf(n)} ${s}${es ? "es" : "s"}`;
};

export default function ReviewsClient() {
  const { appUser } = useAuth();
  // Marking a review replied is city-manager ops work, not a finance/admin
  // mutation — any signed-in app_user may do it (the page is already gated to
  // "cities"). NOT is_admin. The server side is enforced by RLS on
  // review_replies (migration 0090), which is the only server gate on this path.
  const canReply = !!appUser;
  const { rows, rawCount, fakeExcluded, meta, loading, error } = useCleanReviews();
  const { replies, enabled: replyEnabled, noReplyNeededEnabled, setMark, clear, error: replyError, clearError } = useReviewReplies();

  const NOW = useMemo(() => new Date(), []);
  const months = useMemo(() => monthsPresent(rows), [rows]);

  const [month, setMonth] = useState<string>("");
  const [city, setCity] = useState("all");
  const [venue, setVenue] = useState("all");
  const [mgr, setMgr] = useState("all");
  const [focus, setFocus] = useState<null | "attn" | "stand">(null);
  const [cwin, setCwin] = useState<CommentWindow>("week");
  const [csev, setCsev] = useState<"all" | "needs" | "open" | "praise">("all");
  const [shareOpen, setShareOpen] = useState(false);
  const [stick, setStick] = useState<Set<number>>(new Set());

  // Default to the latest month once data lands.
  useEffect(() => {
    if (!month && months.length) setMonth(months[0]);
  }, [month, months]);

  // Any page-level view change is a view change — release the sticky rows.
  useEffect(() => {
    setStick(new Set());
  }, [month, city, venue, mgr, cwin, csev]);

  const filters: PageFilters = { month, city, venue, mgr };
  const filtering = city !== "all" || venue !== "all" || mgr !== "all";

  // filter dropdown options — scoped to the selected month
  const opts = useMemo(() => {
    const inMonth = rows.filter((r) => monthKeyOf(r.startDate) === month);
    const cs = new Set<string>(), vs = new Set<string>(), ms = new Set<string>();
    for (const r of inMonth) {
      if (r.city) cs.add(r.city);
      if (r.fieldTitle) vs.add(r.fieldTitle);
      ms.add(reviewManagerName(r) ?? "Unattributed");
    }
    return {
      cities: [...cs].sort(),
      venues: [...vs].sort(),
      mgrs: [...ms].sort(),
    };
  }, [rows, month]);

  const d = useMemo(() => derivePage(rows, filters), [rows, month, city, venue, mgr]); // eslint-disable-line react-hooks/exhaustive-deps
  const wk = useMemo(() => deriveWeeks(rows, NOW), [rows, NOW]);
  const cm = useMemo(
    () => deriveComments(rows, cwin, { city, venue, mgr }, NOW),
    [rows, cwin, city, venue, mgr, NOW],
  );

  // comment severity rows (open depends on live replies + sticky)
  const openRows = useMemo(
    () => cm.included.filter((r) => needsReply(r) && !replies.has(r.apiId)),
    [cm.included, replies],
  );
  const shownComments = useMemo(() => {
    if (csev === "needs") return cm.included.filter(needsReply);
    if (csev === "praise") return cm.included.filter((r) => r.starRating === 5);
    if (csev === "open")
      return cm.included.filter((r) => needsReply(r) && (!replies.has(r.apiId) || stick.has(r.apiId)));
    return cm.included;
  }, [csev, cm.included, replies, stick]);

  const openN = openRows.length;
  const needsN = cm.needs;

  if (loading && rows.length === 0)
    return <div className="p-8 text-sm" style={{ color: C.muted }}>Loading reviews…</div>;
  if (error)
    return (
      <div className="m-6 rounded-xl border p-4 text-sm" style={{ borderColor: C.critLine, background: C.critBg, color: C.critInk }}>
        {error}
      </div>
    );

  const scopeBits = [monthLabel(month || months[0] || monthKeyOf(NOW))];
  if (city !== "all") scopeBits.push(city);
  if (venue !== "all") scopeBits.push(venue);
  if (mgr !== "all") scopeBits.push(mgr);

  // Both resolved states leave the open queue, so both stick briefly under the
  // "open" filter (shows "no longer unanswered" before the row drops out).
  const onReplied = (r: ReviewRow) => {
    if (!replyEnabled || !canReply) return;
    if (csev === "open") setStick((s) => new Set(s).add(r.apiId));
    void setMark(r.apiId, "replied");
  };
  const onNoReplyNeeded = (r: ReviewRow, note: string) => {
    if (!replyEnabled || !canReply) return;
    if (csev === "open") setStick((s) => new Set(s).add(r.apiId));
    void setMark(r.apiId, "no_reply_needed", note);
  };
  const onUndoMark = (r: ReviewRow) => {
    if (!replyEnabled || !canReply) return;
    void clear(r.apiId);
  };

  return (
    <div className="min-w-0 px-1 pb-16" style={{ color: C.ink }}>
      <style>{`
        .rv-ctab{table-layout:fixed}
        .rv-ctab th:nth-child(1){width:96px}.rv-ctab th:nth-child(2){width:58px}
        .rv-ctab th:nth-child(4){width:180px}.rv-ctab th:nth-child(5){width:196px}
        .rv-ctab th:nth-child(6){width:124px}.rv-ctab th:nth-child(7){width:158px}
        @media(max-width:1400px){
          .rv-ctab th:nth-child(1){width:86px}.rv-ctab th:nth-child(2){width:52px}
          .rv-ctab th:nth-child(4){width:130px}.rv-ctab th:nth-child(5){width:150px}
          .rv-ctab th:nth-child(6){width:112px}.rv-ctab th:nth-child(7){width:134px}
        }
      `}</style>

      {/* header */}
      <div className="mb-4 flex items-start gap-4">
        <div>
          <h1 className="m-0 text-[28px] font-[800] tracking-[-0.4px]" style={{ color: C.forestDeep }}>Reviews</h1>
          <p className="mt-0.5 text-[13.5px]" style={{ color: C.muted }}>
            Per-match review performance — ratings, managers, and the matches that need a look.
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {meta && (
            <span className="rounded-full border px-[11px] py-[5px] text-[11px] font-semibold" style={{ background: C.surface, borderColor: C.line, color: C.muted }}>
              SYNCED {meta.uploadedAt.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).toUpperCase()}
            </span>
          )}
          <button type="button" onClick={() => setShareOpen(true)}
            className="inline-flex h-9 items-center gap-2 rounded-[9px] border px-[14px] text-[13px] font-bold"
            style={{ background: C.accent, borderColor: C.accent, color: "#06281d" }}>
            <svg viewBox="0 0 24 24" className="h-[15px] w-[15px]" fill="none" stroke="currentColor" strokeWidth={1.8}><path d="M12 3v13M12 3 8 7M12 3l4 4" /><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" /></svg>
            Share leaderboard
          </button>
        </div>
      </div>

      {/* filters */}
      <div className="mb-3.5 flex flex-wrap items-end gap-2.5 rounded-[12px] border p-3" style={{ background: C.surface, borderColor: C.line }}>
        <Field label="MONTH">
          <Select value={month} onChange={setMonth} options={months.map((m) => ({ v: m, l: monthLabel(m) }))} />
        </Field>
        <Field label="CITY">
          <Select value={city} onChange={setCity} all="All cities" options={opts.cities.map((c) => ({ v: c, l: c }))} />
        </Field>
        <Field label="VENUE">
          <Select value={venue} onChange={setVenue} all="All venues" wide options={opts.venues.map((v) => ({ v, l: v }))} />
        </Field>
        <Field label="MANAGER">
          <Select value={mgr} onChange={setMgr} all="All managers" options={opts.mgrs.map((m) => ({ v: m, l: m }))} />
        </Field>
        {filtering && (
          <button type="button" onClick={() => { setCity("all"); setVenue("all"); setMgr("all"); }}
            className="h-9 rounded-[9px] border px-[14px] text-[13px] font-bold" style={{ background: C.surface, borderColor: C.line, color: C.forest }}>
            Clear filters
          </button>
        )}
        <div className="ml-auto self-center text-[12px]" style={{ color: C.muted }}>
          Showing <b style={{ color: C.forest }}>{scopeBits.join(" · ")}</b>
        </div>
      </div>

      {/* tiles */}
      <div className="mb-3 grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Tile rv="avg" label="AVG RATING" value={d.avg == null ? "—" : d.avg.toFixed(2)}
          note={`${plural(d.matches, "match")} · ${plural(d.reviews, "review")}`} />
        <Tile rv="volume" label="REVIEW VOLUME" value={nf(d.reviews)}
          note={d.reviews ? `${(d.reviews / Math.max(1, d.matches)).toFixed(1)} per match` : "nothing in this selection"} />
        <Tile rv="attn" label="NEEDS ATTENTION" value={String(d.attn.length)} tone={d.attn.length ? "bad" : undefined}
          note={`avg < ${ATTN_MAX_AVG}, ${ATTN_MIN_REVIEWS}+ reviews`}
          selected={focus === "attn"} onClick={() => setFocus((f) => (f === "attn" ? null : "attn"))} />
        <Tile rv="stand" label="STANDOUTS" value={String(d.stand.length)} tone={d.stand.length ? "good" : undefined}
          note={`avg ≥ ${STAND_MIN_AVG}, ${STAND_MIN_REVIEWS}+ reviews`}
          selected={focus === "stand"} onClick={() => setFocus((f) => (f === "stand" ? null : "stand"))} />
      </div>

      {/* trailing-8-week card — one shared, linked readout drives both charts */}
      <TrailingWeeks wk={wk} />

      {/* managers + attention/standouts */}
      <div className="grid grid-cols-1 items-start gap-3.5 xl:grid-cols-[1.35fr_1fr]">
        {/* manager table */}
        <div className="overflow-hidden rounded-[12px] border" style={{ background: C.surface, borderColor: C.line }}>
          <PanelHead title="MANAGERS" n={d.venueMode ? "—" : `${d.ranked.length} ranked`}
            hint={d.venueMode ? "not narrowed by venue" : `ranked at ${MIN_RANK_REVIEWS}+ reviews`} />
          <table className="w-full border-collapse">
            {!d.venueMode && (
              <thead>
                <tr>
                  <Th style={{ width: 26 }}> </Th><Th>MANAGER</Th><Th right>AVG</Th>
                  <Th style={{ width: 118 }}>SPREAD <span className="block text-[9.5px] font-semibold opacity-75" style={{ color: C.muted }}>4.00–5.00</span></Th>
                  <Th right>REVIEWS</Th><Th right>MATCHES</Th>
                </tr>
              </thead>
            )}
            <tbody>
              {d.venueMode ? (
                <tr><Td colSpan={6} className="p-4 text-[11.5px]" style={{ color: C.muted }}>
                  Manager standings are counted per month and city, so they do not narrow to a single venue.
                  Clear the venue filter to rank managers. The figures above and the lists to the right are scoped to <b style={{ color: C.forest }}>{venue}</b>.
                </Td></tr>
              ) : (
                <>
                  {d.ranked.map((m, i) => {
                    const lo = m.avg < 4.4;
                    return (
                      <tr key={m.key} data-rv="ranked-row" className="[&:hover]:bg-[#f6f9f7]">
                        <Td className="text-[12px] font-bold" style={{ color: C.muted }}>{i + 1}</Td>
                        <Td>
                          <div className="font-bold" style={{ color: C.forestDeep }}>{m.name}</div>
                          <span className="inline-flex items-center gap-1.5 text-[12px]" style={{ color: C.muted }}>
                            <i className="h-2 w-2 rounded-full" style={{ background: hue(m.city) }} />{m.city}
                          </span>
                        </Td>
                        <Td right><span className="font-[800] tracking-[-0.2px]" style={{ color: m.avg >= 4.7 ? C.ok : lo ? C.critInk : C.ink }}>{m.avg.toFixed(2)}★</span></Td>
                        <Td>
                          <div className="relative h-1.5 min-w-[64px] rounded-[3px]" style={{ background: C.hair }}>
                            <i className="absolute inset-y-0 left-0 rounded-[3px]" style={{ width: `${Math.max(0, Math.min(100, (m.avg - 4) * 100)).toFixed(1)}%`, background: lo ? "#e08a68" : C.accent }} />
                          </div>
                        </Td>
                        <Td right>{nf(m.reviews)}</Td><Td right>{nf(m.matches)}</Td>
                      </tr>
                    );
                  })}
                  {!d.ranked.length && (
                    <tr><Td colSpan={6} className="p-4 text-[11.5px]" style={{ color: C.muted }}>
                      No manager has reached {MIN_RANK_REVIEWS} reviews in this selection, so none can be ranked yet.
                    </Td></tr>
                  )}
                  {d.unranked.length > 0 && (
                    <>
                      <tr><Td colSpan={6} className="px-4 py-1.5 text-[11.5px] font-bold tracking-[0.06em]" style={{ background: C.railB, color: C.muted }}>
                        NOT ENOUGH REVIEWS TO RANK · UNDER {MIN_RANK_REVIEWS}
                      </Td></tr>
                      {d.unranked.map((m) => (
                        <tr key={m.key} data-rv="unranked-row" style={{ color: C.muted }}>
                          <Td className="text-[12px] font-bold">—</Td>
                          <Td><div className="font-semibold">{m.name}</div>
                            <span className="inline-flex items-center gap-1.5 text-[12px]"><i className="h-2 w-2 rounded-full" style={{ background: hue(m.city) }} />{m.city}</span></Td>
                          <Td right><span className="text-[11.5px]">{m.avg.toFixed(2)}★</span></Td>
                          <Td><span className="text-[11.5px]">not rated</span></Td>
                          <Td right>{nf(m.reviews)}</Td><Td right>{nf(m.matches)}</Td>
                        </tr>
                      ))}
                    </>
                  )}
                  {d.unattributed && (
                    <>
                      <tr><Td colSpan={6} className="px-4 py-1.5 text-[11.5px] font-bold tracking-[0.06em]" style={{ background: C.railB, color: C.muted }}>NOT ATTRIBUTED TO A MANAGER</Td></tr>
                      <tr data-rv="unattr-row" style={{ color: C.muted }}>
                        <Td className="text-[12px] font-bold">—</Td>
                        <Td><div className="font-semibold italic">No manager on the match</div>
                          <span className="text-[12px]">these reviews count toward the averages above, but belong to nobody</span></Td>
                        <Td right><span className="text-[11.5px]">{d.unattributed.avg.toFixed(2)}★</span></Td>
                        <Td><span className="text-[11.5px]">not rated</span></Td>
                        <Td right>{nf(d.unattributed.reviews)}</Td><Td right>{nf(d.unattributed.matches)}</Td>
                      </tr>
                    </>
                  )}
                </>
              )}
            </tbody>
          </table>
        </div>

        {/* attention / standouts */}
        <div className="flex flex-col gap-3.5">
          {focus !== "stand" && (
            <div className="overflow-hidden rounded-[12px] border" style={{ background: C.surface, borderColor: d.attn.length ? C.critLine : C.line }}>
              <PanelHead title="NEEDS ATTENTION" n={String(d.attn.length)} hint={d.attn.length ? "lowest first" : ""} attn={d.attn.length > 0} />
              {d.attn.length ? d.attn.map((m) => <MatchLi key={m.key} m={m} tone="lo" />) : (
                <Empty ok>No match in this selection fell below {ATTN_MAX_AVG}★.</Empty>
              )}
            </div>
          )}
          {focus !== "attn" && (
            <div className="overflow-hidden rounded-[12px] border" style={{ background: C.surface, borderColor: C.line }}>
              <PanelHead title="STANDOUTS" n={String(d.stand.length)} hint={d.stand.length ? "highest first" : ""} />
              {d.stand.length ? d.stand.map((m) => <MatchLi key={m.key} m={m} tone="hi" />) : (
                <Empty>No match reached {STAND_MIN_AVG}★ with {STAND_MIN_REVIEWS}+ reviews in this selection.</Empty>
              )}
            </div>
          )}
        </div>
      </div>

      {/* comments */}
      <div className="mt-3.5 overflow-hidden rounded-[12px] border" style={{ background: C.surface, borderColor: C.line }}>
        <div className="flex flex-wrap items-center gap-2.5 border-b px-4 py-3" style={{ borderColor: C.hair }}>
          <h2 className="m-0 text-[12px] font-bold tracking-[0.07em]" style={{ color: C.muted }}>COMMENTS</h2>
          <span className="rounded-full border px-2 py-px text-[11px] font-bold" style={{ background: C.chipBg, borderColor: C.chipLine, color: C.forest }}>{nf(shownComments.length)}</span>
          <span className="text-[11px]" style={{ color: C.muted2 }}>player feedback for response</span>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <span className="rounded-full border px-[9px] py-[3px] text-[10.5px] font-bold tracking-[0.04em]" style={{ color: C.warnInk, background: C.warnBg, borderColor: C.warnLine }}>own window — not the month filter</span>
            <Seg value={cwin} onChange={(v) => setCwin(v as CommentWindow)} options={[["week", "This week"], ["month", "This month"], ["d30", "Last 30 days"]]} />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 border-b px-4 py-2.5 text-[11.5px]" style={{ background: C.railB, borderColor: C.hair, color: C.muted }}>
          <div>
            {cm.all ? (
              <><b style={{ color: C.forest }}>{nf(cm.all)}</b> review{cm.all === 1 ? "" : "s"} to read = <b style={{ color: C.forest }}>{nf(cm.withText)}</b> with a comment + <b style={{ color: C.forest }}>{nf(cm.silent1)}</b> rated 1★ with no words</>
            ) : (<><b style={{ color: C.forest }}>0</b> reviews to read — nobody left a comment or a wordless 1★</>)}
            {" · "}<b style={{ color: C.forest }}>{cm.window.label}</b> ({cm.window.note})
            {(city !== "all" || venue !== "all" || mgr !== "all")
              ? " · " + [city, venue, mgr].filter((x) => x !== "all").join(" · ")
              : " · all cities"}
          </div>
          {/* reply status as a fraction of the owed set */}
          <div className="rounded-full border px-2.5 py-[3px] text-[11.5px] font-semibold"
            style={needsN === 0 ? { background: C.chipBg, borderColor: C.chipLine, color: C.muted }
              : openN ? { background: C.warnBg, borderColor: C.warnLine, color: C.warnInk }
              : { background: C.mint, borderColor: "#bfe4cf", color: C.ok }}>
            {needsN === 0 ? "nothing here is owed a reply"
              : openN === 0 ? <>all <b>{needsN}</b> owed a reply have one</>
              : <><b>{openN}</b> of <b>{needsN}</b> owed a reply {openN === 1 ? "is" : "are"} still unanswered</>}
          </div>
          <Seg dark rvPrefix="sev" value={csev} onChange={(v) => setCsev(v as typeof csev)} className="ml-auto"
            options={[["all", `All ${cm.all}`], ["needs", `Needs a reply ${cm.needs}`], ["open", `Unanswered ${openN}`], ["praise", `Praise ${cm.praise}`]]} />
        </div>

        {!replyEnabled && (
          <div className="border-b px-4 py-2 text-[11.5px]" style={{ borderColor: C.hair, background: C.warnBg, color: C.warnInk }}>
            Reply tracking not enabled yet — run migration 0089_review_replies.sql. The tick column is read-only until then.
          </div>
        )}
        {replyError && (
          <div role="alert" className="flex items-center gap-2 border-b px-4 py-2 text-[11.5px]" style={{ borderColor: C.hair, background: C.critBg, color: C.critInk }}>
            <svg viewBox="0 0 24 24" className="h-[14px] w-[14px] shrink-0" fill="none" stroke="currentColor" strokeWidth={2}><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16h.01" /></svg>
            <span>{replyError}</span>
            <button type="button" onClick={clearError} className="ml-auto font-bold underline">Dismiss</button>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="rv-ctab w-full border-collapse">
            {shownComments.length > 0 && (
              <thead><tr>
                <Th>SUBMITTED</Th><Th>RATING</Th><Th>COMMENT</Th><Th>PLAYER</Th><Th>MATCH</Th><Th>MANAGER</Th><Th>REPLIED?</Th>
              </tr></thead>
            )}
            <tbody>
              {shownComments.length ? shownComments.map((r) => (
                <CommentRow key={r.apiId} r={r} mark={replies.get(r.apiId)} owed={needsReply(r)}
                  enabled={replyEnabled} canTick={canReply} noReplyNeededEnabled={noReplyNeededEnabled}
                  leaving={csev === "open" && replies.has(r.apiId) && stick.has(r.apiId)}
                  onReplied={() => onReplied(r)} onNoReplyNeeded={(note) => onNoReplyNeeded(r, note)} onUndo={() => onUndoMark(r)} />
              )) : (
                <tr><Td colSpan={7} className="p-4 text-[11.5px]" style={{ color: C.muted }}>
                  Nothing to read in {cm.window.label} for this selection{csev !== "all" ? ` under the “${SEV_LABEL[csev]}” filter` : ""}. Widen the window or clear a filter.
                </Td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="border-t px-4 py-2.5 text-[11.5px]" style={{ borderColor: C.hair, color: C.muted }}>
          Shown: every review carrying a written comment, plus 1★ ratings left without words — newest first. A reply is owed at 3★ and below; praise is 5★.
          Mark <b>Replied</b> once you have answered the player, or <b>No reply needed</b> (with an optional reason — spam, no comment, handled elsewhere) when there is nothing to answer. Both are stamped with your name and the date, both undo on click, and <b>both take the review out of the outstanding count</b>; only rows with no mark stay owed.
          The city, venue and manager filters at the top of the page apply here; the month filter does not — this panel keeps its own window, set above.
        </div>
      </div>

      {shareOpen && (
        <ShareModal onClose={() => setShareOpen(false)} month={month} ranked={d.ranked}
          unrankedCount={d.unranked.length} unattributed={d.unattributed} venueApplied={venue !== "all"} />
      )}
    </div>
  );
}

const SEV_LABEL: Record<string, string> = { all: "All", needs: "Needs a reply", open: "Unanswered", praise: "Praise" };

// ── small components ──
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[10.5px] font-bold tracking-[0.08em]" style={{ color: C.muted }}>{label}</label>
      {children}
    </div>
  );
}
function Select({ value, onChange, options, all, wide }: { value: string; onChange: (v: string) => void; options: { v: string; l: string }[]; all?: string; wide?: boolean }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}
      className={`h-9 rounded-[9px] border pl-[11px] pr-8 text-[13.5px] font-semibold ${wide ? "min-w-[200px]" : ""}`}
      style={{ background: C.railB, borderColor: C.line, color: C.ink }}>
      {all && <option value="all">{all}</option>}
      {options.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
    </select>
  );
}
function Tile({ label, value, note, tone, selected, onClick, rv }: { label: string; value: string; note: string; tone?: "good" | "bad"; selected?: boolean; onClick?: () => void; rv?: string }) {
  return (
    <div onClick={onClick} role={onClick ? "button" : undefined} tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } } : undefined}
      className={`rounded-[12px] border p-4 ${onClick ? "cursor-pointer" : ""}`}
      style={{ background: C.surface, borderColor: selected ? C.accent : C.line, boxShadow: selected ? "0 0 0 2px rgba(53,199,127,.18)" : undefined }}>
      <div className="text-[10.5px] font-bold tracking-[0.08em]" style={{ color: C.muted }}>{label}</div>
      <div data-rv={rv} className="mt-1.5 text-[30px] font-[800] leading-none tracking-[-1px]" style={{ color: tone === "good" ? C.ok : tone === "bad" ? C.critInk : C.ink }}>{value}</div>
      <div className="mt-0.5 text-[11.5px]" style={{ color: C.muted }}>{note}</div>
    </div>
  );
}
// ── Trailing-8-week card ──────────────────────────────────────────────────
// Two charts (rating dots + volume bars) plot the SAME eight weeks and are
// driven by ONE shared, linked readout — not two floating tooltips. A value is
// always readable with no interaction: the default state shows the most recent
// COMPLETE week (there is no hover on a phone or in a screenshot). Hover either
// chart to preview a week, click/tap to pin, Escape or click-again to unpin;
// ←/→/Home/End work on the focused group. The card height is fixed across all
// states — the readout reserves both of its lines permanently.
const MO_LBL = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function weekRangeLabel(start: Date): string {
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
  return `${MO_LBL[start.getMonth()]} ${start.getDate()} – ${MO_LBL[end.getMonth()]} ${end.getDate()}`;
}
function weekAria(w: { start: Date; count: number; avg: number; partial: boolean }): string {
  return `Week of ${weekRangeLabel(w.start)}${w.partial ? ", partial week" : ""}: ${w.count ? `${w.avg.toFixed(2)} average rating` : "no reviews"}, ${w.count} review${w.count === 1 ? "" : "s"}.`;
}
const GEO = { W: 330, H: 34, gap: 4 };

function TrailingWeeks({ wk }: { wk: ReturnType<typeof deriveWeeks> }) {
  const weeks = wk.weeks;
  const n = weeks.length;
  const lastComplete = (() => { for (let i = n - 1; i >= 0; i--) if (!weeks[i].partial) return i; return n - 1; })();
  const [hover, setHover] = useState<number | null>(null);
  const [pin, setPin] = useState<number | null>(null);
  // Hover previews; a pinned week is the resting state; default is the most
  // recent complete week. Never null → the readout is never blank.
  const active = hover ?? pin ?? lastComplete;

  const clamp = (i: number) => Math.max(0, Math.min(n - 1, i));
  const pinToggle = (i: number) => setPin((p) => (p === i ? null : i));
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowLeft") { e.preventDefault(); setPin((p) => clamp((p ?? active) - 1)); }
    else if (e.key === "ArrowRight") { e.preventDefault(); setPin((p) => clamp((p ?? active) + 1)); }
    else if (e.key === "Home") { e.preventDefault(); setPin(0); }
    else if (e.key === "End") { e.preventDefault(); setPin(n - 1); }
    else if (e.key === "Escape") { e.preventDefault(); setPin(null); }
  };

  const w = weeks[active];
  const ratingTxt = w.count ? w.avg.toFixed(2) : "—";
  const readout = `WEEK OF ${weekRangeLabel(w.start).toUpperCase()}  ·  ${ratingTxt} AVG  ·  ${nf(w.count)} ${w.count === 1 ? "REVIEW" : "REVIEWS"}`;

  return (
    <div data-rv="trailing" className="mb-4 rounded-[12px] border p-3.5" style={{ background: C.surface, borderColor: C.line }}>
      {/* header block */}
      <div className="text-[10.5px] font-bold tracking-[0.08em]" style={{ color: C.muted }}>TRAILING 8 WEEKS</div>
      <div className="mt-0.5 text-[21px] font-[800] tracking-[-0.5px]">
        <span data-rv="wavg">{wk.weightedAvg.toFixed(2)}</span><small className="ml-1.5 text-[12px] font-semibold" style={{ color: C.muted }}>avg rating</small>
      </div>
      <div className="mt-0.5 text-[11.5px]" style={{ color: C.muted }}>
        <span data-rv="totvol">{nf(wk.totalVolume)}</span> reviews · ~{nf(Math.round(wk.totalVolume / n))} per week
      </div>

      {/* shared linked readout — governs both charts. Fixed height (two reserved
          lines) so the card never changes height between states. */}
      <div data-rv="readout" aria-live="polite" className="mt-2.5 flex flex-col justify-center rounded-[8px] px-2.5" style={{ height: 46, background: C.railB, border: `1px solid ${C.hair}` }}>
        <div className="overflow-hidden text-ellipsis whitespace-nowrap text-[12px] font-bold tracking-[0.03em]" style={{ color: C.forestDeep }}>{readout}</div>
        {/* always present so the row keeps its height whether or not it applies */}
        <div className="text-[10.5px] font-bold tracking-[0.03em]" style={{ color: C.warnInk, visibility: w.partial ? "visible" : "hidden" }}>· PARTIAL WEEK — VOLUME NOT COMPARABLE</div>
      </div>

      {/* charts — one focusable group; hover/click/keyboard all drive `active` */}
      <div
        role="group"
        tabIndex={0}
        aria-label={`Trailing eight weeks of average rating and review volume, ${n} weeks. Left and right arrows move between weeks; Home and End jump to first and last; Enter or click pins a week; Escape clears it. Showing week of ${weekRangeLabel(w.start)}.`}
        onKeyDown={onKey}
        onPointerLeave={() => setHover(null)}
        className="mt-3 flex flex-wrap gap-x-8 gap-y-3 rounded-[8px] p-1 outline-none focus-visible:ring-2 focus-visible:ring-[#35c77f]"
      >
        <ChartCol title="RATING" band={`${wk.ratingLo.toFixed(2)}–${wk.ratingHi.toFixed(2)} scale`}>
          <RatingChart wk={wk} active={active} setHover={setHover} pinToggle={pinToggle} />
        </ChartCol>
        <ChartCol title="VOLUME" band={`0–${nf(wk.volHi)} scale`}>
          <VolumeChart wk={wk} active={active} setHover={setHover} pinToggle={pinToggle} />
        </ChartCol>
      </div>

      {/* numbers reachable without colour or pointer */}
      <table className="sr-only">
        <caption>Trailing eight weeks — average rating and review volume by week</caption>
        <thead><tr><th>Week of</th><th>Average rating</th><th>Reviews</th></tr></thead>
        <tbody>
          {weeks.map((wa, i) => (
            <tr key={i}>
              <td>{weekRangeLabel(wa.start)}{wa.partial ? " (partial week)" : ""}</td>
              <td>{wa.count ? wa.avg.toFixed(2) : "no reviews"}</td>
              <td>{wa.count}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* caption */}
      <div className="mt-3 border-t border-dashed pt-2 text-[11px]" style={{ borderColor: C.hair, color: C.muted }}>
        Rating has moved between {wk.ratingLoActual.toFixed(2)} and {wk.ratingHiActual.toFixed(2)} across these 8 weeks — a spread of {wk.ratingSpread.toFixed(2)} on a 5-point scale.
        Volume moved from {nf(wk.volLo)} to {nf(wk.volHi)}. The last point is a partial week (hollow / pale) and is not comparable on volume.
        This strip is a trailing window and does not follow the month filter.
      </div>
    </div>
  );
}

function ChartCol({ title, band, children }: { title: string; band: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-[3px]">
      <div className="flex justify-between gap-3.5 text-[10.5px] font-bold tracking-[0.06em]" style={{ color: C.muted }}>
        <span>{title}</span><span className="font-semibold" style={{ color: C.muted2 }}>{band}</span>
      </div>
      {children}
    </div>
  );
}

// Invisible full-height hit target per week — one per column, ≥24px wide (330/8 ≈
// 41px), spanning the whole column so the 8px dot / thin bar is never the target.
function HitCols({ wk, setHover, pinToggle }: { wk: ReturnType<typeof deriveWeeks>; setHover: (i: number | null) => void; pinToggle: (i: number) => void }) {
  const { W, H, gap } = GEO, n = wk.weeks.length, bw = (W - gap * (n - 1)) / n;
  return (
    <>
      {wk.weeks.map((wkk, i) => {
        const x = Math.max(0, i * (bw + gap) - gap / 2);
        return (
          <rect key={i} x={x} y={0} width={bw + gap} height={H} fill="transparent"
            role="img" aria-label={weekAria(wkk)} style={{ cursor: "pointer" }}
            onPointerEnter={() => setHover(i)} onPointerMove={() => setHover(i)} onClick={() => pinToggle(i)} />
        );
      })}
    </>
  );
}

function RatingChart({ wk, active, setHover, pinToggle }: { wk: ReturnType<typeof deriveWeeks>; active: number; setHover: (i: number | null) => void; pinToggle: (i: number) => void }) {
  const { W, H, gap } = GEO, n = wk.weeks.length, bw = (W - gap * (n - 1)) / n;
  const lo = wk.ratingLo, hi = wk.ratingHi;
  const pts = wk.weeks.map((w, i) => {
    const x = i * (bw + gap) + bw / 2;
    const y = w.count ? H - 3 - ((w.avg - lo) / (hi - lo)) * (H - 8) : H - 3;
    return [x, Math.max(3, Math.min(H - 3, y))] as const;
  });
  const path = pts.filter((_, i) => wk.weeks[i].count > 0).map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
  const aw = wk.weeks[active], ap = pts[active];
  return (
    <svg width={W} height={H} className="block overflow-visible">
      <path d={path} fill="none" stroke={C.accent} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      {pts.map((p, i) => wk.weeks[i].count > 0 && (
        <circle key={i} cx={p[0]} cy={p[1]} r={wk.weeks[i].partial ? 2.6 : 3} fill={wk.weeks[i].partial ? "#fff" : C.forest} stroke={C.forest} strokeWidth={1.4} />
      ))}
      {/* selected: grow + a 2px surface-coloured ring; partial stays hollow.
          The other seven are left as-is (no dimming). */}
      {aw.count > 0 && (
        <g>
          <circle cx={ap[0]} cy={ap[1]} r={6} fill={C.surface} />
          <circle cx={ap[0]} cy={ap[1]} r={aw.partial ? 3.6 : 4.2} fill={aw.partial ? "#fff" : C.forest} stroke={C.forest} strokeWidth={aw.partial ? 1.6 : 1.4} />
        </g>
      )}
      <HitCols wk={wk} setHover={setHover} pinToggle={pinToggle} />
    </svg>
  );
}

function VolumeChart({ wk, active, setHover, pinToggle }: { wk: ReturnType<typeof deriveWeeks>; active: number; setHover: (i: number | null) => void; pinToggle: (i: number) => void }) {
  const { W, H, gap } = GEO, n = wk.weeks.length, bw = (W - gap * (n - 1)) / n;
  const barH = (c: number) => Math.max(2, (c / wk.maxVolume) * (H - 6));
  const aw = wk.weeks[active], ax = active * (bw + gap), ah = barH(aw.count);
  return (
    <svg width={W} height={H} className="block overflow-visible">
      {wk.weeks.map((w, i) => (
        <rect key={i} x={i * (bw + gap)} y={H - barH(w.count)} width={bw} height={barH(w.count)} rx={2.5} fill={w.partial ? "#b7e7cd" : C.accent} />
      ))}
      {/* selected: next darker step of the same hue + a 2px surface gap; partial
          stays pale so selection never makes it look complete. */}
      <rect x={ax} y={H - ah} width={bw} height={ah} rx={2.5}
        fill={aw.partial ? "#8fd9b0" : "#1f9d63"} stroke={C.surface} strokeWidth={2} paintOrder="stroke" />
      <HitCols wk={wk} setHover={setHover} pinToggle={pinToggle} />
    </svg>
  );
}
function PanelHead({ title, n, hint, attn }: { title: string; n: string; hint?: string; attn?: boolean }) {
  return (
    <div className="flex items-center gap-2.5 border-b px-4 py-3" style={{ borderColor: C.hair, background: attn ? C.critBg : undefined }}>
      <h2 className="m-0 text-[12px] font-bold tracking-[0.07em]" style={{ color: attn ? C.critInk : C.muted }}>{title}</h2>
      <span className="rounded-full border px-2 py-px text-[11px] font-bold" style={{ background: attn ? "#fff" : C.chipBg, borderColor: attn ? C.critLine : C.chipLine, color: attn ? C.critInk : C.forest }}>{n}</span>
      {hint && <span className="ml-auto text-[11px]" style={{ color: C.muted2 }}>{hint}</span>}
    </div>
  );
}
function MatchLi({ m, tone }: { m: { venue: string; city: string; manager: string | null; date: Date; avg: number; reviews: number }; tone: "lo" | "hi" }) {
  return (
    <div className="flex items-start gap-3 border-b px-4 py-2.5 last:border-b-0" style={{ borderColor: C.hair }}>
      <div>
        <div className="text-[13.5px] font-bold" style={{ color: C.forestDeep }}>{m.venue}</div>
        <div className="mt-0.5 text-[11.5px]" style={{ color: C.muted }}>{matchDateLabel(m.date)} · {m.city} · {m.manager ?? <i>no manager attributed</i>}</div>
      </div>
      <div className="ml-auto whitespace-nowrap text-right">
        <div className="text-[13.5px] font-[800]" style={{ color: tone === "hi" ? C.ok : C.critInk }}>{m.avg.toFixed(2)}★</div>
        <div className="text-[11px]" style={{ color: C.muted }}>{plural(m.reviews, "review")}</div>
      </div>
    </div>
  );
}
function Empty({ children, ok }: { children: React.ReactNode; ok?: boolean }) {
  return (
    <div className="flex items-center gap-2 px-4 py-3 text-[13px]" style={{ color: C.muted }}>
      {ok && <svg viewBox="0 0 24 24" className="h-[15px] w-[15px]" fill="none" stroke={C.accent} strokeWidth={2}><path d="m5 13 4 4 10-10" /></svg>}
      {children}
    </div>
  );
}
function Seg({ value, onChange, options, dark, className, rvPrefix }: { value: string; onChange: (v: string) => void; options: [string, string][]; dark?: boolean; className?: string; rvPrefix?: string }) {
  return (
    <div className={`inline-flex rounded-[9px] border p-0.5 ${className ?? ""}`} style={{ background: dark ? C.surface : C.chipBg, borderColor: dark ? C.line : C.chipLine }}>
      {options.map(([v, l]) => {
        const on = v === value;
        return (
          <button key={v} type="button" onClick={() => onChange(v)} data-rv={rvPrefix ? `${rvPrefix}-${v}` : undefined}
            className="h-8 whitespace-nowrap rounded-[7px] px-[11px] text-[12px] font-bold"
            style={on ? { background: dark ? C.forest : C.surface, color: dark ? "#fff" : C.forestDeep, boxShadow: dark ? undefined : "0 1px 2px rgba(7,42,32,.10)" } : { background: "transparent", color: C.muted }}>
            {l}
          </button>
        );
      })}
    </div>
  );
}
function Th({ children, right, style }: { children: React.ReactNode; right?: boolean; style?: React.CSSProperties }) {
  return <th className={`border-b px-4 py-2.5 text-[10.5px] font-bold tracking-[0.07em] ${right ? "text-right" : "text-left"}`} style={{ color: C.muted, background: C.railB, borderColor: C.hair, ...style }}>{children}</th>;
}
function Td({ children, right, colSpan, className, style }: { children: React.ReactNode; right?: boolean; colSpan?: number; className?: string; style?: React.CSSProperties }) {
  return <td colSpan={colSpan} className={`border-b px-4 py-2.5 align-top text-[13.5px] ${right ? "text-right" : ""} ${className ?? ""}`} style={{ borderColor: C.hair, ...style }}>{children}</td>;
}

function CommentRow({ r, mark, owed, enabled, canTick, noReplyNeededEnabled, leaving, onReplied, onNoReplyNeeded, onUndo }: {
  r: ReviewRow; mark: ReplyMark | undefined; owed: boolean; enabled: boolean; canTick: boolean; noReplyNeededEnabled: boolean; leaving: boolean; onReplied: () => void; onNoReplyNeeded: (note: string) => void; onUndo: () => void;
}) {
  const [noting, setNoting] = useState(false);
  const [noteText, setNoteText] = useState("");
  const disabled = !enabled || !canTick;
  const starCls = r.starRating <= 2 ? C.critInk : r.starRating === 3 ? C.warnInk : C.ok;
  const tags = r.tags ?? [];
  const shown = tags.slice(0, 3), rest = tags.slice(3);
  return (
    <tr>
      <Td><div className="font-mono text-[11.5px]" style={{ color: C.muted }}>{shortDate(r.startDate)}</div><div className="font-mono text-[11.5px]" style={{ color: C.muted }}>{shortTime(r.startDate)}</div></Td>
      <Td><span className="whitespace-nowrap text-[13px] font-[800]" style={{ color: starCls }}>{r.starRating}★</span></Td>
      <Td>
        <div className="max-w-[560px] leading-[1.5]">{hasText(r) ? r.comment : <span className="italic" style={{ color: C.muted2 }}>no comment left</span>}</div>
        {tags.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {shown.map((t, i) => <Tag key={i} t={t} />)}
            {rest.length > 0 && <span title={rest.map((t) => t.replace(/^[+\-~]/, "")).join(", ")} className="cursor-default rounded-full border border-dashed px-2 py-0.5 text-[10px] font-bold" style={{ borderColor: C.chipLine, color: C.muted }}>+{rest.length} more</span>}
          </div>
        )}
      </Td>
      <Td>
        <div className="text-[12.5px] font-bold" style={{ color: C.forestDeep }}>{r.userFirstName || r.userLastName ? `${r.userFirstName ?? ""} ${r.userLastName ?? ""}`.trim() : "—"}</div>
        {r.userEmail && <a href={`mailto:${r.userEmail}`} title={r.userEmail} className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap py-0.5 text-[11.5px]" style={{ color: C.ok }}>{r.userEmail}</a>}
      </Td>
      <Td><div className="text-[12.5px] font-semibold">{r.fieldTitle}</div><div className="mt-0.5 text-[11.5px]" style={{ color: C.muted }}>{shortDate(r.startDate)} · {r.city}</div></Td>
      <Td>{r.managerFirstName || r.managerLastName ? <div className="text-[12.5px] font-bold" style={{ color: C.forestDeep }}>{reviewManagerName(r)}</div> : <div className="text-[12.5px] font-semibold italic" style={{ color: C.muted }}>no manager</div>}</Td>
      <Td>
        {mark?.kind === "replied" ? (
          <>
            <button type="button" onClick={onUndo} disabled={disabled}
              title={`Replied by ${mark.by} on ${mark.on} — click to undo`}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[11.5px] font-bold disabled:opacity-55"
              style={{ background: C.mint, borderColor: "#bfe4cf", color: C.ok }}>
              <span className="relative box-border h-3.5 w-3.5 rounded" style={{ border: `1.5px solid ${C.ok}`, background: C.ok }}>
                <span className="absolute left-[4px] top-[0.5px] h-2 w-1 rotate-[42deg] border-b-2 border-r-2 border-white" />
              </span>
              Replied
            </button>
            <div className="mt-1.5 text-[10.5px]" style={{ color: "#45544c" }}>{mark.by} · {mark.on}</div>
          </>
        ) : mark?.kind === "no_reply_needed" ? (
          <>
            <button type="button" onClick={onUndo} disabled={disabled}
              title={`Marked “No reply needed” by ${mark.by} on ${mark.on} — click to undo`}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[11.5px] font-bold disabled:opacity-55"
              style={{ background: "#eef3f0", borderColor: "#dfe6e1", color: "#3f4a44" }}>
              <span className="box-border flex h-3.5 w-3.5 items-center justify-center rounded" style={{ border: "1.5px solid #8a978f" }}>
                <span className="block h-[1.5px] w-2 rounded-full" style={{ background: "#3f4a44" }} />
              </span>
              No reply needed
            </button>
            <div className="mt-1.5 text-[10.5px]" style={{ color: "#45544c" }}>{mark.by} · {mark.on}</div>
            {mark.note && <div className="mt-0.5 max-w-[220px] text-[10.5px] italic" style={{ color: "#45544c" }}>“{mark.note}”</div>}
          </>
        ) : noting ? (
          <div className="flex max-w-[220px] flex-col gap-1.5">
            <input autoFocus value={noteText} maxLength={140}
              onChange={(e) => setNoteText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { onNoReplyNeeded(noteText); setNoting(false); } else if (e.key === "Escape") { setNoting(false); setNoteText(""); } }}
              placeholder="Reason (optional) — spam, no comment…"
              className="rounded-md border px-2 py-1 text-[11.5px]" style={{ borderColor: C.line, color: C.ink }} />
            <div className="flex gap-1.5">
              <button type="button" onClick={() => { onNoReplyNeeded(noteText); setNoting(false); }}
                className="rounded-md border px-2.5 py-1 text-[11px] font-bold" style={{ background: "#eef3f0", borderColor: "#dfe6e1", color: "#3f4a44" }}>Save</button>
              <button type="button" onClick={() => { setNoting(false); setNoteText(""); }}
                className="rounded-md border px-2.5 py-1 text-[11px] font-bold" style={{ background: C.surface, borderColor: C.line, color: "#45544c" }}>Cancel</button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-1.5">
            <button type="button" onClick={onReplied} disabled={disabled}
              title={disabled ? "Reply tracking not enabled" : "Mark once you have answered this player"}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[11.5px] font-bold disabled:opacity-55"
              style={owed ? { background: C.warnBg, borderColor: C.warnLine, color: C.warnInk } : { background: C.surface, borderColor: C.line, color: "#45544c" }}>
              <span className="box-border h-3.5 w-3.5 rounded" style={{ border: `1.5px solid ${owed ? "#d3b25f" : "#c3d2cb"}`, background: "#fff" }} />
              {owed ? "Reply due" : "Mark replied"}
            </button>
            {noReplyNeededEnabled && (
              <button type="button" onClick={() => !disabled && setNoting(true)} disabled={disabled}
                title="Deliberately needs no reply"
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[11.5px] font-bold disabled:opacity-55"
                style={{ background: "#eef3f0", borderColor: "#dfe6e1", color: "#3f4a44" }}>
                <span className="box-border flex h-3.5 w-3.5 items-center justify-center rounded" style={{ border: "1.5px solid #8a978f" }}>
                  <span className="block h-[1.5px] w-2 rounded-full" style={{ background: "#3f4a44" }} />
                </span>
                No reply needed
              </button>
            )}
          </div>
        )}
        {leaving && <div className="mt-1 text-[10.5px]" style={{ color: C.warnInk }}>no longer unanswered</div>}
      </Td>
    </tr>
  );
}
function Tag({ t }: { t: string }) {
  const k = t.charAt(0);
  const style = k === "+" ? { background: C.mint, borderColor: "#bfe4cf", color: C.ok }
    : k === "-" ? { background: C.critBg, borderColor: C.critLine, color: C.critInk }
    : { background: C.warnBg, borderColor: C.warnLine, color: C.warnInk };
  return <span className="rounded-full border px-2 py-0.5 text-[10px] font-bold tracking-[0.04em]" style={style}>{t.replace(/^[+\-~]/, "")}</span>;
}
const MO2 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function shortDate(d: Date) { return `${MO2[d.getMonth()]} ${d.getDate()}`; }
function shortTime(d: Date) { let h = d.getHours(); const a = h >= 12 ? "PM" : "AM"; h = h % 12 || 12; return `${h}:${String(d.getMinutes()).padStart(2, "0")} ${a}`; }

function ShareModal({ onClose, month, ranked, unrankedCount, unattributed, venueApplied }: {
  onClose: () => void; month: string; ranked: { name: string; city: string; avg: number; reviews: number }[]; unrankedCount: number; unattributed: { reviews: number } | null; venueApplied: boolean;
}) {
  const ml = monthLabel(month);
  const lines = [`MatchDay · Manager Reviews · ${ml}`, ""];
  if (ranked.length) {
    ranked.forEach((m, i) => lines.push(`${i + 1}. ${m.name} — ${m.avg.toFixed(2)}* (${m.reviews} reviews, ${m.city})`));
    lines.push("");
    lines.push(`Ranked among managers with ${MIN_RANK_REVIEWS}+ reviews.`);
    if (unrankedCount) lines.push(`${unrankedCount} manager(s) had too few reviews to rank this month.`);
    if (unattributed) lines.push(`${unattributed.reviews} reviews were on matches with no manager attributed.`);
  } else lines.push(`Nobody reached ${MIN_RANK_REVIEWS} reviews this month.`);
  const text = lines.join("\n");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-6" style={{ background: "rgba(7,42,32,.42)" }} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="max-h-[88vh] w-[min(560px,100%)] overflow-auto rounded-[14px]" style={{ background: C.surface, boxShadow: "0 22px 60px rgba(7,42,32,.28)" }}>
        <div className="flex items-center gap-2.5 border-b px-5 py-4" style={{ borderColor: C.hair }}>
          <h3 className="m-0 text-[16px]" style={{ color: C.forestDeep }}>Leaderboard — {ml}</h3>
          <button type="button" onClick={onClose} className="ml-auto h-8 w-8 rounded-lg text-[20px]" style={{ color: C.muted }}>×</button>
        </div>
        <div className="px-5 py-4">
          <div className="overflow-hidden rounded-[12px] border" style={{ borderColor: C.line }}>
            <div className="px-4 py-3.5" style={{ background: C.forest, color: "#fff" }}>
              <b className="block text-[15px] tracking-[-0.2px]">MatchDay · Manager Reviews</b>
              <span className="text-[11.5px]" style={{ color: "#a9cfc0" }}>{ml} · ranked among managers with {MIN_RANK_REVIEWS}+ reviews{venueApplied ? " · venue filter not applied" : ""}</span>
            </div>
            {ranked.length ? ranked.map((m, i) => (
              <div key={i} className="flex items-center gap-2.5 border-b px-4 py-2.5 last:border-b-0" style={{ borderColor: C.hair }}>
                <div className="w-[22px] text-[13px] font-[800]" style={{ color: i === 0 ? "#b8860b" : C.muted }}>{i + 1}</div>
                <div><div className="font-bold">{m.name}</div><div className="text-[11.5px]" style={{ color: C.muted }}>{m.city}</div></div>
                <div className="ml-auto font-[800]" style={{ color: C.ok }}>{m.avg.toFixed(2)}★</div>
                <div className="w-[74px] text-right text-[11px]" style={{ color: C.muted }}>{m.reviews} reviews</div>
              </div>
            )) : <div className="px-4 py-4 text-[13px]" style={{ color: C.muted }}>Nobody has reached {MIN_RANK_REVIEWS} reviews in {ml} yet, so there is nothing to share.</div>}
          </div>
          <div className="mt-3.5">
            <label className="mb-1.5 block text-[10.5px] font-bold tracking-[0.08em]" style={{ color: C.muted }}>PLAIN TEXT — PASTE INTO WHATSAPP</label>
            <textarea readOnly value={text} onClick={(e) => e.currentTarget.select()} className="h-[158px] w-full rounded-[10px] border p-3 font-mono text-[12.5px] leading-[1.55]" style={{ borderColor: C.line, background: C.railB, color: C.ink }} />
          </div>
        </div>
        <div className="flex items-center gap-2.5 px-5 pb-4.5 pt-3">
          <button type="button" onClick={() => { navigator.clipboard?.writeText(text).catch(() => {}); setCopied(true); setTimeout(() => setCopied(false), 1200); }}
            className="h-9 rounded-[9px] border px-[14px] text-[13px] font-bold" style={{ background: C.accent, borderColor: C.accent, color: "#06281d" }}>{copied ? "Copied" : "Copy text"}</button>
          <button type="button" onClick={onClose} className="h-9 rounded-[9px] border px-[14px] text-[13px] font-bold" style={{ background: C.surface, borderColor: C.line, color: C.forest }}>Close</button>
        </div>
      </div>
    </div>
  );
}
