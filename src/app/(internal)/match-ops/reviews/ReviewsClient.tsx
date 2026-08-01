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
import { useReviewReplies } from "@/lib/useReviewReplies";
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
  const isAdmin = !!appUser?.is_admin;
  const { rows, rawCount, fakeExcluded, meta, loading, error } = useCleanReviews();
  const { replies, enabled: replyEnabled, toggle } = useReviewReplies();

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

  const onToggleTick = (r: ReviewRow) => {
    if (!replyEnabled || !isAdmin) return;
    if (csev === "open") setStick((s) => new Set(s).add(r.apiId));
    void toggle(r.apiId);
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

      {/* trailing-8-week strip */}
      <div className="mb-4 flex flex-wrap items-center gap-6 rounded-[12px] border p-3.5" style={{ background: C.surface, borderColor: C.line }}>
        <div className="min-w-[186px]">
          <div className="text-[10.5px] font-bold tracking-[0.08em]" style={{ color: C.muted }}>TRAILING 8 WEEKS</div>
          <div className="mt-0.5 text-[21px] font-[800] tracking-[-0.5px]">
            <span data-rv="wavg">{wk.weightedAvg.toFixed(2)}</span><small className="ml-1.5 text-[12px] font-semibold" style={{ color: C.muted }}>avg rating</small>
          </div>
          <div className="mt-0.5 text-[11.5px]" style={{ color: C.muted }}>
            <span data-rv="totvol">{nf(wk.totalVolume)}</span> reviews · ~{nf(Math.round(wk.totalVolume / wk.weeks.length))} per week
          </div>
        </div>
        <Spark title="RATING" band={`${wk.ratingLo.toFixed(2)}–${wk.ratingHi.toFixed(2)} scale`}>
          <RatingSpark wk={wk} />
        </Spark>
        <Spark title="VOLUME" band={`0–${nf(wk.volHi)} scale`}>
          <VolumeSpark wk={wk} />
        </Spark>
        <div className="basis-full border-t border-dashed pt-2 text-[11px]" style={{ borderColor: C.hair, color: C.muted }}>
          Rating has moved between {wk.ratingLoActual.toFixed(2)} and {wk.ratingHiActual.toFixed(2)} across these 8 weeks — a spread of {wk.ratingSpread.toFixed(2)} on a 5-point scale.
          Volume moved from {nf(wk.volLo)} to {nf(wk.volHi)}. The last point is a partial week (hollow / pale) and is not comparable on volume.
          This strip is a trailing window and does not follow the month filter.
        </div>
      </div>

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
                  enabled={replyEnabled} canTick={isAdmin} leaving={csev === "open" && replies.has(r.apiId) && stick.has(r.apiId)}
                  onToggle={() => onToggleTick(r)} />
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
          Tick Replied once you have answered the player — the tick is stamped with your name and the date, and clicking it again undoes it. You can tick a happy review too;
          only the owed ones are counted as outstanding. The city, venue and manager filters at the top of the page apply here; the month filter does not — this panel keeps its own window, set above.
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
function Spark({ title, band, children }: { title: string; band: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-[3px]">
      <div className="flex justify-between gap-3.5 text-[10.5px] font-bold tracking-[0.06em]" style={{ color: C.muted }}>
        <span>{title}</span><span className="font-semibold" style={{ color: C.muted2 }}>{band}</span>
      </div>
      {children}
    </div>
  );
}
function RatingSpark({ wk }: { wk: ReturnType<typeof deriveWeeks> }) {
  const W = 330, H = 34, n = wk.weeks.length, gap = 4, bw = (W - gap * (n - 1)) / n;
  const lo = wk.ratingLo, hi = wk.ratingHi;
  const pts = wk.weeks.map((w, i) => {
    const x = i * (bw + gap) + bw / 2;
    const y = w.count ? H - 3 - ((w.avg - lo) / (hi - lo)) * (H - 8) : H - 3;
    return [x, Math.max(3, Math.min(H - 3, y))] as const;
  });
  const path = pts.filter((_, i) => wk.weeks[i].count > 0).map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
  return (
    <svg width={W} height={H} className="block">
      <path d={path} fill="none" stroke={C.accent} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      {pts.map((p, i) => wk.weeks[i].count > 0 && (
        <circle key={i} cx={p[0]} cy={p[1]} r={wk.weeks[i].partial ? 2.6 : 3} fill={wk.weeks[i].partial ? "#fff" : C.forest} stroke={C.forest} strokeWidth={1.4} />
      ))}
    </svg>
  );
}
function VolumeSpark({ wk }: { wk: ReturnType<typeof deriveWeeks> }) {
  const W = 330, H = 34, n = wk.weeks.length, gap = 4, bw = (W - gap * (n - 1)) / n;
  return (
    <svg width={W} height={H} className="block">
      {wk.weeks.map((w, i) => {
        const h = Math.max(2, (w.count / wk.maxVolume) * (H - 6));
        return <rect key={i} x={i * (bw + gap)} y={H - h} width={bw} height={h} rx={2.5} fill={w.partial ? "#b7e7cd" : C.accent} />;
      })}
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

function CommentRow({ r, mark, owed, enabled, canTick, leaving, onToggle }: {
  r: ReviewRow; mark: { by: string; on: string } | undefined; owed: boolean; enabled: boolean; canTick: boolean; leaving: boolean; onToggle: () => void;
}) {
  const replied = !!mark;
  const word = replied ? "Replied" : owed ? "Reply due" : "Mark replied";
  const starCls = r.starRating <= 2 ? C.critInk : r.starRating === 3 ? C.warnInk : C.ok;
  const tags = r.tags ?? [];
  const shown = tags.slice(0, 3), rest = tags.slice(3);
  const disabled = !enabled || !canTick;
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
        <button type="button" onClick={onToggle} disabled={disabled} aria-pressed={replied}
          title={replied ? `Ticked by ${mark!.by} on ${mark!.on} — click to undo` : disabled ? "Reply tracking not enabled" : "Tick when you have answered this player"}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[11.5px] font-bold disabled:opacity-55"
          style={replied ? { background: C.mint, borderColor: "#bfe4cf", color: C.ok } : owed ? { background: C.warnBg, borderColor: C.warnLine, color: C.warnInk } : { background: C.surface, borderColor: C.line, color: C.muted }}>
          <span className="relative box-border h-3.5 w-3.5 rounded" style={{ border: `1.5px solid ${replied ? C.ok : owed ? "#d3b25f" : "#c3d2cb"}`, background: replied ? C.ok : "#fff" }}>
            {replied && <span className="absolute left-[4px] top-[0.5px] h-2 w-1 rotate-[42deg] border-b-2 border-r-2 border-white" />}
          </span>
          {word}
        </button>
        {replied && <div className="mt-1.5 text-[10.5px]" style={{ color: C.muted }}>{mark!.by} · {mark!.on}</div>}
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
