"use client";

// MATCH PROMOTION — THE PHONE. Spec: mockups/mktg-m1.html.
//
// WHY THIS IS A SEPARATE TREE AND NOT A SET OF BREAKPOINT CLASSES. All three desktop views are
// city × weekday grids. At 390px a column is 48px, and no amount of CSS rescues seven of them —
// each has to become a different shape, not a narrower one. Rendering both trees and hiding one
// would double the DOM and put a mobile-only block on every desktop page; this renders ONE.
//
// WHAT CHANGES SHAPE, AND WHY:
//   the week   groups by DAY, not city — on a phone you are looking at today across every city,
//              so the city moves onto the row as a chip and the header becomes the date.
//   cancel     becomes a ranking, worst first. A matrix answers "when does this city struggle";
//              a phone can only answer "which slots keep dying", which is the better question.
//   coverage   seven dots per city. Same three states as the desktop grid, no fourth.
//   due        the landing view. Nobody plans a week standing up.
//
// SAME DATA, SAME ROUTES, SAME WRITES. Every figure here is computed by the desktop's own helpers
// and passed in; nothing is re-derived and no count is redefined.

import { CHANNELS, NEW_FLAG_LABEL, channelsOn, codeFor, coverageCaption, coverageStateOf, coverageSummary, datedPushes, fmtPushIn, isPushOverdue, isPushSent, leadToKickoff, sentStamp, venueOffsetMs, type PromoMatch, type PromoPush, type PromoWeek, type PushDraft, type ZoneMode } from "@/lib/matchPromotion";
import MarkPushSent from "@/components/MarkPushSent";
import PushPlanEditor from "@/components/PushPlanEditor";
import PageComments from "@/components/PageComments";

const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** The phone edits the same draft the desktop does, through the same editor. */
export type MobileDraft = PushDraft;

/** This match's own venue offset, from its own wall/UTC pair. */
const offsetOf = (m: PromoMatch): number | null => venueOffsetMs(m.startDate ?? null, m.startDateUtc);

export type MobileProps = {
  week: PromoWeek;
  /** The tile's cancel history, keyed on field and weekday with times clustered. Optional so the
   *  phone renders uncoloured rather than crashing if the cancel data has not loaded. */
  riskOf?: (m: PromoMatch) => { cancelCount: 1 | 2 | 3 | 4; booked: number; times: string[] } | null;
  tab: "due" | "week" | "coverage";
  setTab: (t: "due" | "week" | "coverage") => void;
  jobs: { m: PromoMatch; p: PromoPush; at: number }[];
  overdue: number;
  openId: number | null;
  draft: MobileDraft | null;
  setDraft: (d: MobileDraft) => void;
  onOpen: (m: PromoMatch, el: HTMLElement) => void;
  onClose: () => void;
  onSave: () => void;
  /** Re-reads the week after a push is marked sent. The desktop's own loader, passed down. */
  onReload: () => void | Promise<void>;
  saving: boolean;
  toast: { msg: string; bad: boolean } | null;
  onNav: (delta: number) => void;
  weekLabel: string;
  /* THE CLOCK IS THE PAGE'S, NOT THE PHONE'S. Same state the desktop holds, passed down, so the
   * two surfaces cannot disagree about which zone a push time is printed in. */
  zone: ZoneMode;
  setZone: (z: ZoneMode) => void;
  /** Surfaces a failed mark-sent as the page's own toast. */
  onError?: (msg: string) => void;
};

/* ── shared bits ─────────────────────────────────────────────────────────────────────────────── */

function Chips({ m, litOnly = false }: { m: PromoMatch; litOnly?: boolean }) {
  const lit = channelsOn(m.plan);
  const list = litOnly ? CHANNELS.filter((c) => lit.includes(c.key)) : CHANNELS;
  return (
    <span className="flex min-w-0 flex-wrap gap-1" data-testid="m-chipset">
      {list.map((c) => {
        const on = lit.includes(c.key);
        return (
          <i key={c.key} data-testid="m-chip" data-on={on ? "1" : "0"}
            className={`inline-flex h-[19px] min-w-[27px] items-center justify-center rounded-[5px] border px-[5px] text-[9.5px] font-extrabold not-italic ${
              on ? "border-mint/50 bg-mint-soft/50 text-emerald-700" : "border-cream-line bg-white text-deep-green/25"}`}>
            {c.short}
          </i>
        );
      })}
    </span>
  );
}

/* ── DUE ─────────────────────────────────────────────────────────────────────────────────────── */

function Due({ jobs, overdue, now, zone, onOpen, onReload, onError }: {
  jobs: MobileProps["jobs"]; overdue: number; now: number; zone: ZoneMode;
  onOpen: MobileProps["onOpen"];
  onReload: () => void | Promise<void>; onError?: (msg: string) => void;
}) {
  /* THE SAME COUNTS AS THE DESKTOP STRIP, from the same functions, now per push. The phone's Due
   * list read `at < now` of its own, which is the other half of why a sent push stayed red. */
  const sentCount = jobs.filter((j) => isPushSent(j.p)).length;
  return (
    <div data-testid="m-due">
      <div className="px-3 pb-0.5 pt-3.5">
        <h2 className="m-0 text-[11px] font-extrabold uppercase tracking-[0.09em] text-deep-green/45">Due next</h2>
        <div className="mb-2 text-[11.5px] font-bold text-deep-green/65" data-testid="m-due-counts">
          {jobs.length} push{jobs.length === 1 ? "" : "es"}
          {sentCount > 0 && <> · <b data-testid="m-due-sent">{sentCount} sent</b></>}
          {" · "}{overdue} overdue
        </div>
      </div>
      {jobs.length === 0 && <p className="px-3 pb-4 text-[12.5px] text-deep-green/40">Nothing scheduled this week.</p>}
      {jobs.map(({ m, p, at }) => {
        /* SENT GOES QUIET, NOT AWAY — the row stays on the list so everyone can see it was done. */
        const sent = isPushSent(p);
        const late = isPushOverdue(p, now);
        const soon = !sent && !late && at - now < 12 * 3600_000;
        const t = fmtPushIn(p.pushAt, zone, offsetOf(m));
        const chan = CHANNELS.find((c) => c.key === p.channel);
        return (
          <div key={p.id} data-testid="m-due-card" data-push-id={p.id} data-channel={p.channel}
            data-sent={sent ? "1" : "0"} data-late={late ? "1" : "0"}
            className={`mx-3 mb-2 rounded-[11px] border px-3 py-2.5 ${
              sent ? "border-cream-line bg-[#f4f7f5]"
                : late ? "border-coral/45 bg-coral-soft/40" : soon ? "border-amber-300 bg-amber-50" : "border-cream-line bg-white"}`}>
            <div className="flex flex-wrap items-baseline gap-2">
              <span className={`text-[13px] font-extrabold ${
                sent ? "text-deep-green/45 line-through" : late ? "text-coral" : soon ? "text-amber-700" : ""}`}>
                {late ? "Overdue · " : ""}{t.day} {t.time}
              </span>
              <i data-testid="m-due-chan" className={`inline-flex h-[19px] min-w-[27px] items-center justify-center rounded-[5px] border px-[5px] text-[9.5px] font-extrabold not-italic ${
                sent ? "border-cream-line bg-[#eef3f0] text-deep-green/40" : "border-mint/50 bg-mint-soft/50 text-emerald-700"}`}>
                {chan?.short ?? p.channel}
              </i>
              {sent && <span data-testid="m-due-stamp" className="text-[11px] text-deep-green/45">{sentStamp(p)}</span>}
              {/* THE SAME CONTROL THE DESKTOP STRIP USES, not a second implementation of one. */}
              <MarkPushSent push={p} onDone={onReload} onError={onError} />
              <button type="button" data-testid="m-send"
                onClick={(e) => onOpen(m, e.currentTarget as HTMLElement)}
                className="min-h-[32px] px-1 text-[12px] font-extrabold text-emerald-700">
                Send ›
              </button>
            </div>
            {/* THE TOPIC IS WHAT TELLS TWO PUSHES ON ONE MATCH APART. */}
            {p.topic && <div data-testid="m-due-topic" className="mt-1 text-[12px] text-deep-green/55">{p.topic}</div>}
            {/* A phone has no column headers, so the row carries field, kick-off AND city. */}
            <div className="mb-[7px] mt-0.5 text-[12.5px] text-deep-green/65" data-testid="m-due-what">
              {m.venue} · {DOW[m.dayIdx]} {m.time} · {m.city}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── THE WEEK, BY DAY ────────────────────────────────────────────────────────────────────────── */

function WeekByDay(p: MobileProps & { panel: React.ReactNode }) {
  const { week, openId, onOpen, zone, panel } = p;
  return (
    <div data-testid="m-week">
      {week.days.map((d, i) => {
        const dayMatches = week.matches.filter((m) => m.dayIdx === i).sort((a, b) => a.minutes - b.minutes);
        if (dayMatches.length === 0) return null;
        return (
          <div key={d.iso} className="px-3 pt-4" data-testid="m-day">
            <div className="mb-2 flex items-baseline gap-2 py-1">
              <b className={`text-[14px] font-black ${d.today ? "text-emerald-700" : ""}`}>{d.dow}</b>
              <span className="text-[12px] font-bold text-deep-green/45">{d.date} {monthOf(d.iso)}</span>
              <span className="ml-auto text-[11px] font-bold text-deep-green/45">
                {dayMatches.length} match{dayMatches.length === 1 ? "" : "es"}
              </span>
              {dayMatches.some((m) => m.newFlag) && (
                <span className="text-[11px] font-extrabold text-deep-green" data-testid="m-day-new-count">
                  {dayMatches.filter((m) => m.newFlag).length} new
                </span>
              )}
            </div>
            {dayMatches.map((m) => (
              <div key={m.apiId}>
                <div data-testid="m-row" data-state={m.state} data-api-id={m.apiId}
                  onClick={(e) => onOpen(m, e.currentTarget as HTMLElement)}
                  data-new={m.newFlag ?? ""} data-r={p.riskOf?.(m)?.cancelCount ?? 0}
                  data-booked={m.state === "cancelled" ? String(m.playerCount ?? 0) : undefined}
                  /* NO bg-white IN THE BASE — see the Tile note in MatchPromotionView: it ties
                     with the wash class on specificity and wins on emission order. */
                  className={`mb-2 rounded-[11px] border px-3 py-[11px] ${
                    m.state === "cancelled" ? "border-dashed border-cream-line bg-[#f7f8f7]"
                    : M_WASH[p.riskOf?.(m)?.cancelCount ?? 0]
                    ?? (m.state === "needs-decision" ? "border-amber-300 bg-amber-50"
                    : m.state === "none" ? "border-dashed border-cream-line bg-white" : "border-cream-line border-l-[3px] border-l-mint bg-white")} ${
                    m.apiId === openId ? "border-deep-green shadow-[0_0_0_2px_#e6efe9]" : ""}`}>
                  <div className="flex items-baseline gap-2">
                    <span className={`text-[15px] font-black tabular-nums ${m.state === "cancelled" ? "text-deep-green/40 line-through" : ""}`}>{m.time}</span>
                    {/* THE SAME RAMP AND THE SAME RATIO AS THE DESKTOP TILE. One metric, one scale,
                        on both surfaces — see MatchPromotionView's RAMP_HEX. */}
                    {(p.riskOf?.(m)?.cancelCount ?? 0) > 0 && (
                      <i data-testid="m-risk-chip" data-r={p.riskOf!(m)!.cancelCount}
                        className="rounded-[4px] px-[5px] py-px text-[9px] font-extrabold not-italic"
                        style={{ background: M_RAMP_HEX[p.riskOf!(m)!.cancelCount], color: M_RAMP_INK[p.riskOf!(m)!.cancelCount] }}>
                        {p.riskOf!(m)!.cancelCount}/4
                      </i>
                    )}
                    <span className="min-w-0 flex-1 truncate text-[13.5px] font-bold">{m.venue}</span>
                    {m.newFlag && (
                      <span data-testid="m-new-badge" data-flag={m.newFlag}
                        className="whitespace-nowrap rounded-[5px] bg-deep-green px-[5px] py-0.5 text-[9px] font-extrabold tracking-[0.04em] text-white">
                        {NEW_FLAG_LABEL[m.newFlag]}
                      </span>
                    )}
                    {/* THE CITY CHIP IS NOT OPTIONAL — the section header is the day now, so the
                        row is the only thing that can say where this match is. */}
                    <span data-testid="m-city"
                      className="whitespace-nowrap rounded-[5px] border border-cream-line bg-[#f2f5f3] px-[5px] py-0.5 text-[9px] font-extrabold uppercase tracking-[0.05em] text-deep-green/65">
                      {m.city}
                    </span>
                  </div>
                  {/* A CANCELLED MATCH IS ITS OWN STATE, and the booked count is the point. */}
                  {m.state === "cancelled" && (
                    <div className="mt-1.5 flex items-center gap-2">
                      <i data-testid="m-cx-tag" className="rounded-[4px] border border-cream-line bg-white px-[5px] py-px text-[9px] font-extrabold not-italic uppercase tracking-[0.05em] text-deep-green/45">Cancelled</i>
                      <span data-testid="m-booked" data-heavy={(m.playerCount ?? 0) >= 10 ? "1" : "0"}
                        className={`text-[13px] font-extrabold ${(m.playerCount ?? 0) >= 10 ? "text-coral" : "text-deep-green/70"}`}>
                        {m.playerCount ?? 0} booked
                      </span>
                    </div>
                  )}
                  {/* ONLY WHAT IS PLANNED — see the Tile note in MatchPromotionView. An unlit chip,
                      an absent code and an absent push are one fact stated three times. */}
                  {(channelsOn(m.plan).length > 0 || firstCode(m)) && (
                    <div className="mt-2 flex flex-wrap items-center gap-[7px]">
                      <Chips m={m} litOnly />
                      {firstCode(m) && (
                        <span className="rounded-[5px] border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[9.5px] font-extrabold text-amber-800">
                          {firstCode(m)}
                        </span>
                      )}
                    </div>
                  )}
                  {/* THE FIRST PUSH AND HOW MANY MORE, in the clock on screen. Not six lines. */}
                  {datedPushes(m.plan).length > 0 && (
                    <div className="mt-[7px] text-[11.5px] font-bold text-deep-green/45" data-testid="m-row-plan">
                      Push <b className="text-deep-green/70">{rowFirst(m, zone)}</b> · {rowLead(m)}
                      {datedPushes(m.plan).length > 1 && (
                        <span data-testid="m-row-more"> and <b className="text-deep-green/70">{datedPushes(m.plan).length - 1}</b> more</span>
                      )}
                    </div>
                  )}
                  {m.state === "needs-decision" && (
                    <div className="mt-[7px] text-[11.5px] font-bold text-amber-700">Needs a decision</div>
                  )}
                </div>
                {/* The panel opens UNDER ITS OWN ROW. Not a modal — a modal on a phone loses your
                    place in a sixty-row list, and there is nothing here that needs to trap focus. */}
                {m.apiId === openId && panel}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

/** The first code on any of this match's channels. One per channel; the row has space for one. */
function firstCode(m: PromoMatch): string | null {
  for (const k of channelsOn(m.plan)) { const c = codeFor(m.plan, k); if (c) return c; }
  return null;
}
const rowFirst = (m: PromoMatch, zone: ZoneMode): string => {
  const f = datedPushes(m.plan)[0];
  if (!f) return "";
  const t = fmtPushIn(f.pushAt, zone, offsetOf(m));
  return `${t.day} ${t.time}`;
};
const rowLead = (m: PromoMatch): string =>
  leadToKickoff(datedPushes(m.plan)[0]?.pushAt ?? null, m.startDateUtc)?.text ?? "";

function monthOf(iso: string): string {
  const M = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return M[Number(iso.split("-")[1]) - 1] ?? "";
}

/* ── THE PANEL, ONE COLUMN ───────────────────────────────────────────────────────────────────── */

function Panel(p: MobileProps) {
  const { week, openId, draft, setDraft, onClose, onSave, saving, toast, zone, setZone } = p;
  const m = week.matches.find((x) => x.apiId === openId);
  if (!m || !draft) return null;
  return (
    // NOT position:fixed. It is in the flow, directly under its row.
    <div data-testid="m-panel"
      className="mb-2 rounded-[11px] border border-deep-green bg-[#fbfdfc] p-3">
      <h3 className="m-0 mb-2.5 text-[13px] font-extrabold">{m.venue} · {m.city}</h3>

      {/* THE SAME EDITOR THE DESKTOP RENDERS. Its own grid collapses to one column below 640px,
          which is what a channel block has to do on a phone — not a second tree that has to be
          kept in step by hand. */}
      <PushPlanEditor m={m} draft={draft} setDraft={setDraft} zone={zone} setZone={setZone} />

      <div className="mt-3 flex gap-2.5">
        <button type="button" data-testid="m-save" onClick={onSave} disabled={saving}
          className="flex-1 rounded-full bg-deep-green py-3 text-[14px] font-extrabold text-white disabled:opacity-50">
          {saving ? "Saving…" : "Save plan"}
        </button>
        <button type="button" data-testid="m-cancel" onClick={onClose}
          className="flex-none rounded-full border border-cream-line bg-white px-5 py-3 text-[14px] font-bold text-deep-green/65">
          Cancel
        </button>
      </div>
      {toast && <div className={`mt-2 text-[12px] font-bold ${toast.bad ? "text-coral" : "text-emerald-700"}`}>{toast.msg}</div>}
    </div>
  );
}

/* THE CANCEL RANKING IS GONE FROM THIS SCREEN. The history lives on the row itself now — same
 * ramp, same ratio chip as the desktop tile — so a separate list of the same cancellations below
 * the week was the page saying it twice. components/CancelRanking stays; Slate Review still
 * renders it, and this screen's own TIER went with the list that used it. */

/* ── COVERAGE AS SEVEN DOTS ──────────────────────────────────────────────────────────────────── */

/* SAME RULE AS THE DESKTOP GRID — colour marks the exception, and with nothing planned there is no
 * exception to mark. See coverageSummary in lib/matchPromotion. The state letter still separates a
 * day with matches and no push (·) from a day with no matches (–), so the distinction survives the
 * colour going away. */
function Coverage({ week }: { week: PromoWeek }) {
  const cities = [...new Set(week.matches.map((m) => m.city))].sort();
  const summary = coverageSummary(week);
  return (
    <div data-testid="m-coverage">
      <div className="px-3 pb-0.5 pt-4">
        <h2 className="m-0 text-[11px] font-extrabold uppercase tracking-[0.09em] text-deep-green/45">Coverage</h2>
        <div className={`mb-2 text-[11.5px] ${summary.anyPlanned ? "font-bold text-deep-green/65" : "font-extrabold text-deep-green"}`}
          data-testid="m-coverage-caption" data-any-planned={summary.anyPlanned ? "1" : "0"}>
          {coverageCaption(summary)}
        </div>
      </div>
      {cities.map((city) => {
        const perDay = week.days.map((_, i) => {
          const st = coverageStateOf(week.matches.filter((m) => m.city === city && m.dayIdx === i));
          return st === "planned" ? ("p" as const) : st === "open" ? ("o" as const) : ("n" as const);
        });
        const planned = perDay.filter((x) => x === "p").length;
        const open = perDay.filter((x) => x === "o").length;
        return (
          <div key={city} data-testid="m-cov-card" className="mx-3 mb-2 rounded-[11px] border border-cream-line bg-white px-3 py-[11px]">
            <div className="mb-2 flex items-baseline gap-2">
              <span className="text-[13px] font-extrabold tracking-[0.03em]">{city}</span>
              <span className="ml-auto text-[11.5px] font-bold text-deep-green/45">
                {planned} planned{open ? ` · ${open} open` : ""}
              </span>
            </div>
            <div className="grid grid-cols-7 gap-[5px]">
              {perDay.map((st, i) => (
                <span key={i} data-testid="m-dot" data-st={st} data-marked={st === "o" && summary.anyPlanned ? "1" : "0"}
                  className={`rounded-[7px] px-0 pb-[5px] pt-1.5 text-center text-[9px] font-extrabold uppercase tracking-[0.03em] ${
                    st === "p" ? "border border-mint/60 bg-mint-soft text-emerald-700"
                    : st === "o"
                      ? (summary.anyPlanned
                          ? "border border-cream-line border-l-2 border-l-coral/70 bg-white text-deep-green/70"
                          : "border border-cream-line bg-white text-deep-green/55")
                    : "border border-cream-line/70 bg-[#fafbfa] text-deep-green/25"}`}>
                  {DOW[i]}
                  {/* ✓ covered · · matches, no push · – no matches. The glyph carries the
                      distinction so it survives with no colour at all. */}
                  <i className="mt-0.5 block text-[12px] not-italic">{st === "p" ? "✓" : st === "o" ? "·" : "–"}</i>
                </span>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── THE PHONE SHELL ─────────────────────────────────────────────────────────────────────────── */

/* THE RAMP AND THE WASH, THE DESKTOP'S OWN VALUES. Duplicated as constants rather than imported
 * because MatchPromotionView imports this file and the cycle is not worth a shared module for four
 * hex strings; the ramp assertion checks BOTH surfaces so they cannot drift apart silently. */
const M_RAMP_HEX: Record<number, string> = { 1: "#F4C430", 2: "#E8862A", 3: "#D9452F", 4: "#8F2A17" };
const M_RAMP_INK: Record<number, string> = { 1: "#3A2A00", 2: "#2E1B00", 3: "#ffffff", 4: "#ffffff" };
const M_WASH: Record<number, string | undefined> = {
  0: undefined,
  1: "bg-[#FEF8E7] border-[#F4C430]", 2: "bg-[#FDF0E3] border-[#E8862A]",
  3: "bg-[#FBE9E6] border-[#D9452F]", 4: "bg-[#F6E4E0] border-[#8F2A17]",
};

export default function MatchPromotionMobile(p: MobileProps) {
  const { tab, setTab, weekLabel, onNav, week } = p;
  const now = Date.now();
  return (
    <div className="mx-auto min-h-screen max-w-[430px] pb-16" data-testid="m-root">
      <div className="sticky top-0 z-20 bg-deep-green px-3.5 pb-2.5 pt-[11px] text-white">
        <h1 className="m-0 text-[16px] font-black uppercase tracking-[-0.01em]">Match Promotion</h1>
        <div className="mt-2 flex items-center gap-2.5">
          <button type="button" onClick={() => onNav(-1)} data-testid="m-prev"
            className="h-[34px] w-[34px] flex-none rounded-lg bg-white/15 text-[15px]">‹</button>
          <span className="flex-1 text-center text-[13px] font-extrabold">{weekLabel}</span>
          <button type="button" onClick={() => onNav(1)} data-testid="m-next"
            className="h-[34px] w-[34px] flex-none rounded-lg bg-white/15 text-[15px]">›</button>
        </div>
        <div className="mt-2.5 flex rounded-[9px] bg-white/15 p-0.5" data-testid="m-tabs">
          {(["due", "week", "coverage"] as const).map((t) => (
            <button key={t} type="button" data-testid={`m-tab-${t}`} data-on={tab === t ? "1" : "0"}
              onClick={() => setTab(t)}
              className={`min-h-[32px] flex-1 rounded-[7px] py-[7px] text-[12.5px] font-extrabold capitalize ${
                tab === t ? "bg-white text-deep-green" : "text-white/70"}`}>
              {t}
            </button>
          ))}
        </div>
      </div>

      {!week.planTableReady && (
        <div className="mx-3 mt-3 rounded-[11px] border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-900">
          <b>match_promotion_push is not in the database yet.</b> Saving will refuse rather than pretend.
        </div>
      )}

      {tab === "due" && <Due jobs={p.jobs} overdue={p.overdue} now={now} zone={p.zone} onOpen={p.onOpen}
        onReload={p.onReload} onError={(msg) => p.onError?.(msg)} />}
      {/* THE SAME LIST AS THE DESKTOP, from the same table and the same route. */}
      <PageComments weekStart={week.weekStart} placeholder="Suggestion about this week" />
      {tab === "week" && <WeekByDay {...p} panel={<Panel {...p} />} />}
      {tab === "coverage" && <Coverage week={week} />}

      {/* The legend explains the coverage dots and the row states. It is not on DUE, where there
          are neither — a key to symbols that are not on screen is just noise above the fold. */}
      {tab === "coverage" && (
        <div className="px-3.5 pb-6 pt-3 text-[11.5px] leading-[1.8] text-deep-green/65">
          <b>✓</b> push planned · <b>!</b> matches, no push · <b>–</b> no matches
        </div>
      )}
      {tab === "week" && (
        <div className="px-3.5 pb-6 pt-3 text-[11.5px] leading-[1.8] text-deep-green/65">
          A dashed row has no plan. Amber needs a push date.
        </div>
      )}
    </div>
  );
}

