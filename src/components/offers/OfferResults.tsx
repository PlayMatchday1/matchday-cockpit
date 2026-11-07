"use client";

// OFFER RESULTS (Figma 20864:72 "Offer results · Funnel"), on the Offers list: the range pill, four tiles (Chosen ›
// Can get it › Saw it › Used it), the "can't get offers yet" banner with Add message push, one row per offer with its
// mini funnel, and the audience planner. Backend contract: docs/offers/M3-ENDPOINTS.md "Funnel". Every rule and
// string is src/lib/offersFunnel.ts.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  DEFAULT_NEED, DEFAULT_RANGE, PREFILL_KEY, RANGES, cantGetLine, dealLines, pctText, plannerView, rangeQuery, statusLine, steps, tileSub,
  type FunnelPage, type Range, type WithoutApp,
} from "@/lib/offersFunnel";
import type { Campaign, FieldOpt, MatchOpt } from "@/lib/offersModel";
import { O, authed } from "./offersUi";

const AMBER_BG = "#fff7e6", AMBER_INK = "#b7791f", AMBER_BAR = "#f2c46d", GREEN = "#2cdb87", TRACK = "#ecece6", ARROW = "#b9bdb5";
const n = (x: number) => x.toLocaleString("en-US");

export default function OfferResults({ campaigns, matches, fields }: { campaigns: Campaign[]; matches: MatchOpt[]; fields: FieldOpt[] }) {
  const router = useRouter();
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

  // ADD MESSAGE PUSH: the players each offer in the range chooses now who aren't on 1.88+, one read per offer (the
  // contract has no range-wide list), merged, then the Push Notifications editor opens with them as Exact players.
  const [adding, setAdding] = useState<{ done: number; of: number } | null>(null);
  const [addErr, setAddErr] = useState<string | null>(null);
  async function addPush() {
    if (!page || adding) return;
    const offers = page.offers.filter((o) => o.funnel.chosen - o.funnel.canGetIt > 0);
    setAddErr(null); setAdding({ done: 0, of: offers.length });
    const ids = new Set<number>();
    for (const [i, o] of offers.entries()) {
      const r = await authed(`/api/offers/${o.id}/players-without-app`);
      if (!r.ok) { setAddErr(`Couldn't read the players for "${o.name}": ${String(r.json.error)}`); setAdding(null); return; }
      for (const id of (r.json as unknown as WithoutApp).playerIds) ids.add(id);
      setAdding({ done: i + 1, of: offers.length });
    }
    setAdding(null);
    if (ids.size === 0) { setAddErr("Nobody to add: they're all on app 1.88 or newer now."); return; }
    try { sessionStorage.setItem(PREFILL_KEY, JSON.stringify({ playerIds: [...ids].sort((a, b) => a - b), from: "Offer results" })); }
    catch { setAddErr("This browser wouldn't hand the list over (private window?). Nothing was sent."); return; }
    router.push("/match-ops/push-notifications?prefill=1");
  }

  const t = page?.totals;
  const banner = t ? cantGetLine(t) : null;
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
          {/* THE TILES */}
          <div className="grid grid-cols-2 gap-2 md:flex md:items-stretch md:gap-0">
            {steps(t).map((s, i) => (
              <div key={s.key} className="contents md:flex md:flex-1 md:items-center">
                {i > 0 && <span aria-hidden className="hidden px-1.5 text-[22px] md:block" style={{ color: ARROW }}>›</span>}
                <div data-testid={`offers-results-tile-${s.key}`} className="flex h-full min-w-0 flex-1 flex-col gap-0.5 rounded-[10px] px-3.5 py-3" style={{ background: s.key === "canGetIt" ? AMBER_BG : O.page }}>
                  <div className="text-[12px] font-semibold" style={{ color: O.muted }}>{s.label}</div>
                  <div className="text-[24px] font-bold" style={{ color: O.ink }}>{n(s.count)}</div>
                  <div className="text-[11px]" style={{ color: O.muted }}>{tileSub(s)}</div>
                  {s.key === "canGetIt" && <div className="text-[11px]" style={{ color: AMBER_INK }}>on app 1.88+{t.estimatedOffers > 0 ? " (est.)" : ""}</div>}
                </div>
              </div>
            ))}
          </div>

          {/* THE BANNER */}
          {banner && (
            <div data-testid="offers-results-banner" className="flex flex-wrap items-center gap-2.5 rounded-[10px] px-3.5 py-2.5" style={{ background: AMBER_BG }}>
              <span className="text-[13px] font-bold" style={{ color: AMBER_INK }}>!</span>
              <span className="min-w-0 flex-1 text-[13px]" style={{ color: O.ink }}>{banner}</span>
              <button type="button" data-testid="offers-results-add-push" disabled={!!adding} onClick={addPush}
                className="rounded-[8px] border bg-white px-2.5 py-1.5 text-[12px] font-semibold disabled:opacity-60" style={{ borderColor: O.line, color: O.ink }}>
                {adding ? `Finding players… ${adding.done} of ${adding.of}` : "Add message push"}
              </button>
              {addErr && <div data-testid="offers-results-add-error" className="w-full text-[12px]" style={{ color: O.critInk }}>{addErr}</div>}
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
              const [deal, where] = dealLines(o, campaigns, matches, fields);
              const st = steps(o.funnel);
              const rate = o.funnel.chosen > 0 ? Math.round((o.funnel.used / o.funnel.chosen) * 100) : null;
              return (
                <div key={o.id} data-testid="offers-results-row" data-id={o.id} className="flex flex-col gap-3 border-b py-3.5 md:flex-row md:items-center md:gap-4" style={{ borderColor: O.line }}>
                  <div className="flex min-w-0 flex-col gap-0.5 md:w-[300px] md:shrink-0 lg:w-[260px] xl:w-[300px]">
                    <div className="truncate text-[13px] font-semibold" style={{ color: O.ink }}>{o.name}</div>
                    <div className="text-[11px]" style={{ color: O.muted }}>{statusLine(o)}</div>
                  </div>
                  <div className="flex min-w-0 flex-col gap-0.5 md:w-[150px] md:shrink-0">
                    <div className="text-[13px] font-semibold" style={{ color: O.ink }}>{deal}</div>
                    {where && <div className="truncate text-[11px]" style={{ color: O.muted }}>{where}</div>}
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
                      </div>
                    ))}
                  </div>
                  <div className="flex flex-col gap-0.5 md:w-[110px] md:shrink-0">
                    <div className="text-[14px] font-bold" style={{ color: O.ink }}>{pctText(rate)}</div>
                    <div className="text-[11px]" style={{ color: O.muted }}>{n(o.funnel.used)} of {n(o.funnel.chosen)}</div>
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

