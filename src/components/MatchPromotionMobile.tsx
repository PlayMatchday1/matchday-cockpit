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

import { CHANNELS, CHANNEL_KEYS, NEW_FLAG_LABEL, coverageCaption, coverageStateOf, coverageSummary, type ChannelKey, type PromoMatch, type PromoWeek } from "@/lib/matchPromotion";

const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export type MobileDraft = {
  channels: Record<ChannelKey, boolean>;
  pushAt: string;
  promoCode: string;
  comment: string;
};

export type MobileProps = {
  week: PromoWeek;
  tab: "due" | "week" | "coverage";
  setTab: (t: "due" | "week" | "coverage") => void;
  jobs: { m: PromoMatch; at: number }[];
  overdue: number;
  openId: number | null;
  draft: MobileDraft | null;
  setDraft: (d: MobileDraft) => void;
  onOpen: (m: PromoMatch, el: HTMLElement) => void;
  onClose: () => void;
  onSave: () => void;
  saving: boolean;
  toast: { msg: string; bad: boolean } | null;
  onNav: (delta: number) => void;
  weekLabel: string;
  fmtPush: (iso: string) => { day: string; time: string };
  leadLabel: (pushIso: string, weekStart: string, dayIdx: number, minutes: number) => string;
  ranking: { code: string; canonical: string; time: string; booked: number; n: number; slot: string; city: string }[];
  rankingReady: boolean;
  rankingTotal: number;
};

/* ── shared bits ─────────────────────────────────────────────────────────────────────────────── */

function Chips({ m, litOnly = false }: { m: PromoMatch; litOnly?: boolean }) {
  const list = litOnly ? CHANNELS.filter((c) => m.plan?.channels[c.key]) : CHANNELS;
  return (
    <span className="flex min-w-0 flex-wrap gap-1" data-testid="m-chipset">
      {list.map((c) => {
        const on = m.plan?.channels[c.key] === true;
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

function Due({ jobs, overdue, now, fmtPush, onOpen }: {
  jobs: { m: PromoMatch; at: number }[]; overdue: number; now: number;
  fmtPush: MobileProps["fmtPush"]; onOpen: MobileProps["onOpen"];
}) {
  return (
    <div data-testid="m-due">
      <div className="px-3 pb-0.5 pt-3.5">
        <h2 className="m-0 text-[11px] font-extrabold uppercase tracking-[0.09em] text-deep-green/45">Due next</h2>
        <div className="mb-2 text-[11.5px] font-bold text-deep-green/65" data-testid="m-due-counts">
          {jobs.length} push{jobs.length === 1 ? "" : "es"} · {overdue} overdue
        </div>
      </div>
      {jobs.length === 0 && <p className="px-3 pb-4 text-[12.5px] text-deep-green/40">Nothing scheduled this week.</p>}
      {jobs.map(({ m, at }) => {
        const late = at < now;
        const soon = !late && at - now < 12 * 3600_000;
        const p = fmtPush(m.plan!.pushAt!);
        return (
          <div key={m.apiId} data-testid="m-due-card"
            className={`mx-3 mb-2 rounded-[11px] border px-3 py-2.5 ${
              late ? "border-coral/45 bg-coral-soft/40" : soon ? "border-amber-300 bg-amber-50" : "border-cream-line bg-white"}`}>
            <div className="flex items-baseline gap-2">
              <span className={`text-[13px] font-extrabold ${late ? "text-coral" : soon ? "text-amber-700" : ""}`}>
                {late ? "Overdue · " : ""}{p.day} {p.time}
              </span>
              <button type="button" data-testid="m-send"
                onClick={(e) => onOpen(m, e.currentTarget as HTMLElement)}
                className="ml-auto min-h-[32px] px-1 text-[12px] font-extrabold text-emerald-700">
                Send ›
              </button>
            </div>
            {/* A phone has no column headers, so the row carries field, kick-off AND city. */}
            <div className="mb-[7px] mt-0.5 text-[12.5px] text-deep-green/65" data-testid="m-due-what">
              {m.venue} · {DOW[m.dayIdx]} {m.time} · {m.city}
            </div>
            {/* ONLY THE CHANNELS GOING OUT — in a worklist an unsent channel is not work. */}
            <Chips m={m} litOnly />
          </div>
        );
      })}
    </div>
  );
}

/* ── THE WEEK, BY DAY ────────────────────────────────────────────────────────────────────────── */

function WeekByDay(p: MobileProps & { panel: React.ReactNode }) {
  const { week, openId, onOpen, fmtPush, leadLabel, panel } = p;
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
                  data-new={m.newFlag ?? ""}
                  className={`mb-2 rounded-[11px] border bg-white px-3 py-[11px] ${
                    m.state === "needs-decision" ? "border-amber-300 bg-amber-50"
                    : m.state === "none" ? "border-dashed border-cream-line" : "border-cream-line border-l-[3px] border-l-mint"} ${
                    m.apiId === openId ? "border-deep-green shadow-[0_0_0_2px_#e6efe9]" : ""}`}>
                  <div className="flex items-baseline gap-2">
                    <span className="text-[15px] font-black tabular-nums">{m.time}</span>
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
                  {/* ONLY WHAT IS PLANNED — see the Tile note in MatchPromotionView. An unlit chip,
                      an absent code and an absent push are one fact stated three times. */}
                  {(CHANNEL_KEYS.some((k) => m.plan?.channels[k]) || m.plan?.promoCode) && (
                    <div className="mt-2 flex flex-wrap items-center gap-[7px]">
                      <Chips m={m} litOnly />
                      {m.plan?.promoCode && (
                        <span className="rounded-[5px] border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[9.5px] font-extrabold text-amber-800">
                          {m.plan.promoCode}
                        </span>
                      )}
                    </div>
                  )}
                  {m.state === "planned" && m.plan?.pushAt && (
                    <div className="mt-[7px] text-[11.5px] font-bold text-deep-green/45">
                      Push <b className="text-deep-green/70">{fmtPush(m.plan.pushAt).day} {fmtPush(m.plan.pushAt).time}</b> · {leadLabel(m.plan.pushAt, week.weekStart, m.dayIdx, m.minutes)}
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

function monthOf(iso: string): string {
  const M = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return M[Number(iso.split("-")[1]) - 1] ?? "";
}

/* ── THE PANEL, ONE COLUMN ───────────────────────────────────────────────────────────────────── */

function Panel(p: MobileProps) {
  const { week, openId, draft, setDraft, onClose, onSave, saving, toast, leadLabel } = p;
  const m = week.matches.find((x) => x.apiId === openId);
  if (!m || !draft) return null;
  return (
    // NOT position:fixed. It is in the flow, directly under its row.
    <div data-testid="m-panel"
      className="mb-2 rounded-[11px] border border-deep-green bg-[#fbfdfc] p-3">
      <h3 className="m-0 mb-2.5 text-[13px] font-extrabold">{m.venue} · {DOW[m.dayIdx]} {m.time}</h3>

      <div className="mb-[7px] text-[9px] font-extrabold uppercase tracking-[0.09em] text-deep-green/45">Channels</div>
      {CHANNELS.map((c) => (
        <label key={c.key} data-testid={`m-ch-${c.key}`}
          className="flex cursor-pointer items-center gap-2.5 border-b border-cream-line/60 py-[7px] text-[13.5px] font-semibold text-deep-green/70 last:border-b-0">
          <input type="checkbox" className="peer sr-only" checked={draft.channels[c.key]}
            onChange={(e) => setDraft({ ...draft, channels: { ...draft.channels, [c.key]: e.target.checked } })} />
          <span className="relative h-[21px] w-9 flex-none rounded-full bg-[#e6eae8] transition after:absolute after:left-0.5 after:top-0.5 after:h-[17px] after:w-[17px] after:rounded-full after:bg-white after:shadow-sm after:transition peer-checked:bg-mint peer-checked:after:left-[17px]" />
          {c.label}
        </label>
      ))}

      {/* 15px MINIMUM ON EVERY INPUT — below that iOS zooms the page on focus and the layout the
          rest of this file is careful about is thrown away by the browser. */}
      <div className="mt-3">
        <label className="mb-1 block text-[9px] font-extrabold uppercase tracking-[0.09em] text-deep-green/45">When</label>
        <input type="datetime-local" data-testid="m-push-at" value={draft.pushAt}
          onChange={(e) => setDraft({ ...draft, pushAt: e.target.value })}
          className="w-full rounded-[9px] border border-cream-line bg-white px-[11px] py-2.5 text-[15px] font-semibold" />
        <div className="mt-1 text-[11.5px] font-bold text-deep-green/45" data-testid="m-lead">
          {draft.pushAt
            ? leadLabel(new Date(draft.pushAt).toISOString(), week.weekStart, m.dayIdx, m.minutes)
            : "needs a decision"}
        </div>
      </div>

      <div className="mt-3">
        <label className="mb-1 block text-[9px] font-extrabold uppercase tracking-[0.09em] text-deep-green/45">Code</label>
        <input type="text" data-testid="m-promo-code" value={draft.promoCode} placeholder="none"
          onChange={(e) => setDraft({ ...draft, promoCode: e.target.value })}
          className="w-full rounded-[9px] border border-cream-line bg-white px-[11px] py-2.5 text-[15px] font-semibold" />
      </div>

      <div className="mt-3">
        <label className="mb-1 block text-[9px] font-extrabold uppercase tracking-[0.09em] text-deep-green/45">Comment</label>
        <textarea data-testid="m-comment" value={draft.comment} placeholder="Offer, limit, who it targets"
          onChange={(e) => setDraft({ ...draft, comment: e.target.value })}
          className="min-h-[62px] w-full resize-y rounded-[9px] border border-cream-line bg-white px-[11px] py-2.5 text-[15px]" />
      </div>

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

/* ── CANCEL PATTERNS AS A RANKING ────────────────────────────────────────────────────────────── */

const TIER: Record<number, string> = {
  4: "bg-[#c0392b] text-white",
  3: "bg-[#7d3220] text-white",
  2: "bg-[#e6a532] text-[#3d2a05]",
  1: "bg-[#eef0ee] text-deep-green/65 border border-cream-line",
};

function Ranking({ ranking, ready, total }: { ranking: MobileProps["ranking"]; ready: boolean; total: number }) {
  if (!ready) return <div className="px-3 py-5 text-[12.5px] text-deep-green/45">Loading cancel patterns…</div>;
  return (
    <div data-testid="m-cancel">
      <div className="px-3 pb-0.5 pt-4">
        <h2 className="m-0 text-[11px] font-extrabold uppercase tracking-[0.09em] text-deep-green/45">Cancel patterns</h2>
        <div className="mb-2 text-[11.5px] font-bold text-deep-green/65" data-testid="m-cancel-counts">
          {total} slots · last 4 completed weeks
        </div>
      </div>
      {ranking.length === 0 && <p className="px-3 pb-4 text-[12.5px] text-deep-green/40">No slot died more than once.</p>}
      {ranking.map((s) => (
        <div key={s.slot} data-testid="m-cancel-row" data-n={s.n}
          className="mx-3 mb-2 flex items-center gap-2.5 rounded-[11px] border border-cream-line bg-white px-3 py-[11px]">
          {/* THE BADGE PRINTS THE NUMBER. A shade alone is unreadable in sun, in print, and to
              anyone who cannot separate 3/4 from 2/4 by colour. */}
          <span className={`flex h-[38px] w-[38px] flex-none items-center justify-center rounded-[9px] text-[11.5px] font-extrabold tabular-nums ${TIER[s.n]}`}>
            {s.n}/4
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13.5px] font-extrabold">{s.canonical} · {DOW[Number(s.slot.split("|")[1])]} {s.time}</div>
            <div className="mt-px text-[11.5px] font-bold text-deep-green/45">{s.booked} spots booked · {s.city}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

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
          <b>match_promotion_plan is not in the database yet.</b> Saving will refuse rather than pretend.
        </div>
      )}

      {tab === "due" && <Due jobs={p.jobs} overdue={p.overdue} now={now} fmtPush={p.fmtPush} onOpen={p.onOpen} />}
      {tab === "week" && <WeekByDay {...p} panel={<Panel {...p} />} />}
      {tab === "coverage" && <Coverage week={week} />}
      {tab === "week" && <Ranking ranking={p.ranking} ready={p.rankingReady} total={p.rankingTotal} />}

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

export { CHANNEL_KEYS };
