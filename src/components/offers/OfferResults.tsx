"use client";

// OFFER RESULTS (Figma 20864:72 "Offer results · Funnel"), on the Offers list: the range pill, four tiles (Chosen ›
// Can get it › Saw it › Used it), one row per offer with its mini funnel, and the audience planner. The design's
// "can't get offers yet" banner and its Add message push were taken out (Ryan, 2026-11-07); the players-without-app
// route stays for a possible per-offer button. Backend contract: docs/offers/M3-ENDPOINTS.md "Funnel". Every rule and
// string is src/lib/offersFunnel.ts.

import { useEffect, useState } from "react";
import {
  ANNOUNCEMENT_APP_NOTE, DEFAULT_NEED, DEFAULT_RANGE, RANGES, dealLines, isAnnouncementFunnel, pctText, plannerView, rangeQuery, statusLine, steps, tileSub,
  type FunnelPage, type Range,
} from "@/lib/offersFunnel";
import type { Campaign, FieldOpt, MatchOpt } from "@/lib/offersModel";
import { O, authed } from "./offersUi";

const AMBER_BG = "#fff7e6", AMBER_INK = "#b7791f", AMBER_BAR = "#f2c46d", GREEN = "#2cdb87", TRACK = "#ecece6", ARROW = "#b9bdb5";
const n = (x: number) => x.toLocaleString("en-US");

export default function OfferResults({ campaigns, matches, fields }: { campaigns: Campaign[]; matches: MatchOpt[]; fields: FieldOpt[] }) {
  const [range, setRange] = useState<Range>(DEFAULT_RANGE);
  const [page, setPage] = useState<(FunnelPage & { fixture?: boolean }) | null>(null);
  const [err, setErr] = useState<{ text: string; missing: boolean } | null>(null);
  const [need, setNeed] = useState<number>(DEFAULT_NEED);
  useEffect(() => {
    let cancelled = false;
    setPage(null); setErr(null);
    (async () => {
      const r = await authed(`/api/offers/funnel${rangeQuery(range)}`);
      if (cancelled) return;
      if (r.ok) setPage(r.json as unknown as FunnelPage); else setErr({ text: String(r.json.error), missing: r.json.missing === true });
    })();
    return () => { cancelled = true; };
  }, [range]);

  const t = page?.totals;
  const plan = page ? plannerView(page.planner, need) : null;
  return (
    <section data-testid="offers-results-funnel" className="flex flex-col gap-[18px] rounded-[14px] border px-4 pb-6 pt-[22px] sm:px-6" style={{ background: O.surface, borderColor: O.line }}>
      <div className="flex items-center gap-3">
        <h2 className="m-0 text-[15px] font-bold" style={{ color: O.ink }}>Offer results</h2>
        <div className="flex-1" />
        <label className="relative rounded-full px-2.5 py-[5px] text-[12px] font-semibold" style={{ background: O.page, color: O.ink }}>
          <span className="whitespace-pre">{`${RANGES.find((r) => r.days === range)!.label}  ▾`}</span>
          <select data-testid="offers-results-range" aria-label="Date range" value={range} onChange={(e) => setRange(Number(e.target.value) as Range)} className="absolute inset-0 cursor-pointer opacity-0">
            {RANGES.map((r) => <option key={r.days} value={r.days}>{r.label}</option>)}
          </select>
        </label>
      </div>

      {err ? (
        <div data-testid="offers-results-error" className="rounded-[10px] px-3.5 py-2.5 text-[13px]" style={err.missing ? { background: O.subtle, color: O.muted } : { background: O.critBg, color: O.critInk }}>
          {err.missing ? err.text : `Couldn't load the results: ${err.text}`}
        </div>
      ) : !page || !t ? <div className="text-[13px]" style={{ color: O.muted }}>Loading results…</div> : (
        <>
          {page.fixture && <div className="rounded-[10px] px-3 py-2 text-[12px]" style={{ background: O.subtle, color: O.muted }}>Dev fixture: stand-in numbers shaped as the backend contract says. Nothing here is real.</div>}
          {/* THE TILES: offers with a deal (the planner's), then, when there are any, announcements on their own row. */}
          <Tiles st={steps(t)} prefix="offers-results-tile" note={`on app 1.88+${t.estimatedOffers > 0 ? " (est.)" : ""}`} />
          {page.announcements && page.announcements.offers > 0 && (
            <div data-testid="offers-results-announcements" className="flex flex-col gap-2">
              <div className="text-[12px] font-semibold" style={{ color: O.muted }}>Announcements (no discount) · {n(page.announcements.offers)} · not in the use rate</div>
              <Tiles st={steps({ ...page.announcements, kind: "ANNOUNCEMENT", used: null })} prefix="offers-results-ann-tile" note={`${ANNOUNCEMENT_APP_NOTE}${page.announcements.estimatedOffers > 0 ? " (est.)" : ""}`} />
            </div>
          )}

          {/* THE TABLE */}
          <div className="flex flex-col">
            <div className="hidden items-center gap-4 border-b pb-2 text-[11px] font-semibold md:flex" style={{ borderColor: O.line, color: O.muted }}>
              <div className="w-[300px] shrink-0 lg:w-[260px] xl:w-[300px]">OFFER</div>
              <div className="w-[150px] shrink-0">DEAL</div>
              <div className="flex min-w-0 flex-1 gap-2"><div className="flex-1">CHOSEN</div><div className="flex-1">CAN GET IT</div><div className="flex-1">SAW</div><div className="flex-1">USED</div></div>
              <div className="w-[110px] shrink-0">CHOSEN → USED</div>
            </div>
            {page.offers.length === 0 && <div data-testid="offers-results-empty" className="border-b py-5 text-center text-[13px]" style={{ borderColor: O.line, color: O.muted }}>No offer launched in this range.</div>}
            {page.offers.map((o) => {
              const [deal, where] = dealLines(o, campaigns, fields);
              const st = steps(o.funnel);
              // An announcement's last step is Tapped (it has no uses); its rate is chosen to tapped.
              const annRow = isAnnouncementFunnel(o.funnel);
              const last = annRow ? o.funnel.tapped ?? 0 : o.funnel.used ?? 0;
              const rate = o.funnel.chosen > 0 ? Math.round((last / o.funnel.chosen) * 100) : null;
              return (
                <div key={o.id} data-testid="offers-results-row" data-id={o.id} className="flex flex-col gap-3 border-b py-3.5 md:flex-row md:items-center md:gap-4" style={{ borderColor: O.line }}>
                  <div className="flex min-w-0 flex-col gap-0.5 md:w-[300px] md:shrink-0 lg:w-[260px] xl:w-[300px]">
                    <div className="truncate text-[13px] font-semibold" style={{ color: O.ink }}>{o.name}</div>
                    <div className="text-[11px]" style={{ color: O.muted }}>{statusLine(o)}</div>
                  </div>
                  <div className="flex min-w-0 flex-col gap-0.5 md:w-[150px] md:shrink-0">
                    <div className="text-[13px] font-semibold" style={{ color: O.ink }}>{deal}</div>
                    <div className="truncate text-[11px]" style={{ color: O.muted }}>{where}</div>
                  </div>
                  <div className="flex min-w-0 flex-1 gap-2">
                    {st.map((s) => (
                      <div key={s.key} data-testid={`offers-results-cell-${s.key}`} className="flex min-w-0 flex-1 flex-col gap-1">
                        <div className="flex items-baseline gap-1.5 whitespace-nowrap">
                          <span className="text-[14px] font-bold" style={{ color: O.ink }}>{n(s.count)}</span>
                          {s.key !== "chosen" && <span className="text-[11px]" style={{ color: O.muted }}>{pctText(s.pct)}{s.key === "canGetIt" && o.funnel.estimated ? " est." : ""}</span>}
                        </div>
                        <div className="relative h-1.5 w-full overflow-hidden rounded-[3px]" style={{ background: TRACK }}>
                          <div className="absolute inset-y-0 left-0 rounded-[3px]" style={{ width: `${s.bar}%`, background: s.key === "canGetIt" ? AMBER_BAR : GREEN }} />
                        </div>
                        {annRow && s.key === "canGetIt" && <div data-testid="offers-results-ann-note" className="text-[10.5px] leading-[13px]" style={{ color: AMBER_INK }}>{ANNOUNCEMENT_APP_NOTE}</div>}
                      </div>
                    ))}
                  </div>
                  <div className="flex flex-col gap-0.5 md:w-[110px] md:shrink-0">
                    <div className="text-[14px] font-bold" style={{ color: O.ink }}>{pctText(rate)}</div>
                    <div className="text-[11px]" style={{ color: O.muted }}>{n(last)} {annRow ? "tapped " : ""}of {n(o.funnel.chosen)}</div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* THE PLANNER */}
          <div data-testid="offers-results-planner" className="flex flex-col gap-4 rounded-[12px] px-[18px] py-4 md:flex-row md:items-center md:gap-5" style={{ background: O.page }}>
            <div className="flex flex-col gap-1 md:w-[330px] md:shrink-0">
              <div className="text-[14px] font-bold" style={{ color: O.ink }}>Audience planner</div>
              <div className="text-[12px]" style={{ color: O.muted }}>How many players to choose for a match, based on your past offers.</div>
            </div>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-semibold" style={{ color: O.muted }}>Players I need</span>
              <input data-testid="offers-results-need" type="number" min={1} value={need} onChange={(e) => setNeed(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
                className="w-[72px] rounded-[8px] border bg-white px-3 py-2 text-[15px] font-bold outline-none" style={{ borderColor: O.line, color: O.ink }} />
            </label>
            <span aria-hidden className="hidden text-[20px] md:block" style={{ color: "#9aa19c" }}>→</span>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-[11px] font-semibold" style={{ color: O.muted }}>Choose about</span>
              {plan?.ready ? (
                <>
                  <span data-testid="offers-results-choose" className="text-[15px] font-bold" style={{ color: O.ink }}>{n(plan.choose)} players</span>
                  <span className="text-[11px]" style={{ color: O.muted }}>{plan.rate}, from {n(page.planner.used)} used of {n(page.planner.chosen)} chosen.</span>
                </>
              ) : (
                <>
                  <span data-testid="offers-results-choose" className="text-[15px] font-bold" style={{ color: O.ink }}>Not enough data yet</span>
                  <span className="text-[11px]" style={{ color: O.muted }}>{plan && !plan.ready ? plan.note : ""}</span>
                </>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}

// One row of tiles (Chosen › Can get it › Saw it › Used it, or Tapped for announcements), Can get it in amber with its note.
function Tiles({ st, note, prefix }: { st: ReturnType<typeof steps>; note: string; prefix: string }) {
  return (
    <div className="grid grid-cols-2 gap-2 md:flex md:items-stretch md:gap-0">
      {st.map((s, i) => (
        <div key={s.key} className="contents md:flex md:flex-1 md:items-center">
          {i > 0 && <span aria-hidden className="hidden px-1.5 text-[22px] md:block" style={{ color: ARROW }}>›</span>}
          <div data-testid={`${prefix}-${s.key}`} className="flex h-full min-w-0 flex-1 flex-col gap-0.5 rounded-[10px] px-3.5 py-3" style={{ background: s.key === "canGetIt" ? AMBER_BG : O.page }}>
            <div className="text-[12px] font-semibold" style={{ color: O.muted }}>{s.label}</div>
            <div className="text-[24px] font-bold" style={{ color: O.ink }}>{n(s.count)}</div>
            <div className="text-[11px]" style={{ color: O.muted }}>{tileSub(s)}</div>
            {s.key === "canGetIt" && <div className="text-[11px]" style={{ color: AMBER_INK }}>{note}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}
