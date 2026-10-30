"use client";

// GROWTH › OFFERS (Figma 20571:44; backend feature/offers on the LOCAL backend, admin + OFFERS_ALLOWLIST).
//
// Recruiting's layout: the list on the left, one panel on the right. Picking an offer opens its panel
// and, once it has launched, its results card under the list: saw, used, discount given, came back
// at full price, and the one line comparing the players who got it with the ones held back. The
// panel is src/components/offers/OfferPanel.tsx; every rule and every string is in
// src/lib/offersModel.ts.

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/lib/useAuth";
import {
  STATE_LABEL, audienceText, chicagoWallNow, comparisonLine, dealText, money, progressText, resultsLines, usedPct, usesText, wallLabel,
  type Campaign, type City, type MatchOpt,
} from "@/lib/offersModel";
import OfferPanel from "./OfferPanel";
import { Banner, Btn, NotFound, O, Split, StateChip, authed, type WriteOutcome } from "./offersUi";
import { useOffersAccess } from "./useOffersAccess";

type Data = { campaigns: Campaign[]; cities: City[]; matches: MatchOpt[] };
const COLS = "grid grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1.3fr)_88px] items-center gap-3";

export default function OffersView() {
  const { isLoading } = useAuth();
  const access = useOffersAccess();
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [key, setKey] = useState(0);
  const [ver, setVer] = useState(0);
  const [open, setOpen] = useState<number | "new" | null>(null);
  // Bumped on every + New offer, so a second click starts a fresh form instead of keeping the last one.
  const [newN, setNewN] = useState(0);
  const [banner, setBanner] = useState<WriteOutcome | null>(null);

  useEffect(() => {
    if (access !== true) return;
    let cancelled = false;
    (async () => {
      const r = await authed("/api/offers");
      if (cancelled) return;
      if (!r.ok) { setErr(String(r.json.error ?? `HTTP ${r.status}`)); setData(null); return; }
      setErr(null); setData(r.json as unknown as Data); setVer((v) => v + 1);
    })();
    return () => { cancelled = true; };
  }, [access, key]);
  const landed = useCallback((o: WriteOutcome, selectId?: number) => {
    setBanner(o);
    if (selectId !== undefined) setOpen(selectId);
    setKey((k) => k + 1);
  }, []);

  if (isLoading || access === null) return <div className="px-1 py-6 text-[13px]" style={{ color: O.muted }}>Loading…</div>;
  if (access !== true) return <NotFound />;

  const current = open === "new" || open === null ? null : data?.campaigns.find((c) => c.id === open) ?? null;
  const nowWall = chicagoWallNow();
  const fieldOf = (c: Campaign) => (c.matchIds[0] ? data?.matches.find((m) => m.id === c.matchIds[0])?.fieldTitle ?? null : null);

  return (
    <div className="min-w-0 px-1 pb-16" style={{ color: O.ink }}>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <h1 className="m-0 text-[25px] font-bold" style={{ color: O.ink }}>Offers</h1>
        <div className="ml-auto" />
        <Btn onClick={() => setKey((k) => k + 1)}>Refresh</Btn>
      </div>
      {banner && <Banner outcome={banner} onDismiss={() => setBanner(null)} />}
      {err ? (
        <div data-testid="offers-error" className="rounded-[10px] border px-3 py-2.5 text-[12.5px]" style={{ background: O.critBg, borderColor: O.critLine, color: O.critInk }}>Could not load: {err}</div>
      ) : !data ? <div className="py-6 text-[13px]" style={{ color: O.muted }}>Loading…</div> : (
        <Split
          panel={open !== null && (open === "new" || current) ? (
            <OfferPanel key={`${open}:${ver}:${open === "new" ? newN : ""}`} c={current} data={data} onClose={() => setOpen(null)} onLanded={landed} />
          ) : null}
          main={
            <div className="flex flex-col gap-5">
              <div data-testid="offers-list" className="overflow-hidden rounded-[12px] border" style={{ background: O.surface, borderColor: O.line }}>
                <div className="flex items-center justify-between px-4 py-3.5">
                  <div className="text-[16px] font-bold" style={{ color: O.ink }}>Offers</div>
                  <Btn kind="primary" testId="offers-new" onClick={() => { setOpen("new"); setNewN((n) => n + 1); }}>+ New offer</Btn>
                </div>
                <div className={`${COLS} border-y px-4 py-[9px] text-[10px] font-semibold tracking-[0.6px]`} style={{ borderColor: O.line, background: O.subtle, color: O.label }}>
                  <div>OFFER</div><div>DEAL</div><div>RESULTS</div><div />
                </div>
                {data.campaigns.length === 0 ? (
                  <div data-testid="offers-empty" className="border-b px-4 py-6 text-center" style={{ borderColor: O.line }}>
                    <div className="text-[14px] font-semibold" style={{ color: O.ink }}>No offers yet</div>
                    <div className="mt-1 text-[12px]" style={{ color: O.muted }}>Make one with + New offer. It shows as a popup when players open the app.</div>
                  </div>
                ) : data.campaigns.map((c) => {
                  const [r1, r2] = resultsLines(c);
                  const m = c.matchIds[0] ? data.matches.find((x) => x.id === c.matchIds[0]) : null;
                  return (
                    <div key={c.id} data-testid="offers-row" data-id={c.id} onClick={() => setOpen(c.id)} className={`${COLS} cursor-pointer border-b px-4 py-3`}
                      style={{ borderColor: O.line, background: open === c.id ? O.mint : O.surface }}>
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <div className="truncate text-[14px] font-semibold" style={{ color: O.ink }}>{c.name || "Untitled offer"}</div>
                        <div data-testid="offers-row-who" className="truncate text-[12px]" style={{ color: O.muted }}>{audienceText(c, data.cities, fieldOf(c))}</div>
                      </div>
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <div data-testid="offers-row-deal" className="truncate text-[13px] font-medium" style={{ color: O.ink }}>{dealText(c.dealType, c.dealAmount)}</div>
                        <div className="truncate text-[12px]" style={{ color: O.muted }} title={m ? wallLabel(m.startLocal) : undefined}>{c.matchScoped ? (m ? m.name : `Match ${c.matchIds[0]}`) : usesText(c.usesPerPlayer)}</div>
                      </div>
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <div data-testid="offers-row-results" className="truncate text-[13px] font-medium" style={{ color: O.ink }}>{r1}</div>
                        {r2 && <div className="truncate text-[12px]" style={{ color: O.muted }}>{r2}</div>}
                      </div>
                      <div className="flex justify-end"><StateChip state={c.state} label={STATE_LABEL[c.state]} /></div>
                    </div>
                  );
                })}
                <div className="px-4 py-3 text-[12px] leading-[17px]" style={{ color: O.muted }}>
                  Shows on app open. One popup per open, never right after another popup. Used = booked with the offer. Came back = booked again at full price within 30 days.
                </div>
              </div>
              {current && current.state !== "DRAFT" && <ResultsCard c={current} nowWall={nowWall} />}
            </div>
          } />
      )}
    </div>
  );
}

function Stat({ value, label, testId }: { value: string; label: string; testId: string }) {
  return (
    <div data-testid={testId} className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-[10px] px-3.5 py-3" style={{ background: O.subtle }}>
      <div className="text-[22px] font-bold" style={{ color: O.ink }}>{value}</div>
      <div className="text-[12px]" style={{ color: O.muted }}>{label}</div>
    </div>
  );
}

function ResultsCard({ c, nowWall }: { c: Campaign; nowWall: string }) {
  const r = c.results;
  const up = usedPct(r);
  return (
    <div data-testid="offers-results" className="flex flex-col gap-3.5 rounded-[12px] border p-4" style={{ background: O.surface, borderColor: O.line }}>
      <div className="flex items-start justify-between gap-3">
        <div className="text-[16px] font-bold" style={{ color: O.ink }}>{c.name} · results so far</div>
        <div data-testid="offers-progress" className="whitespace-nowrap text-[12px]" style={{ color: O.muted }}>{progressText(c, nowWall)}</div>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat testId="offers-stat-saw" value={r.saw.toLocaleString("en-US")} label="Saw it" />
        <Stat testId="offers-stat-used" value={r.used.toLocaleString("en-US")} label={up ? `Used it · ${up}` : "Used it"} />
        <Stat testId="offers-stat-discount" value={money(r.discountGiven)} label="Discount given" />
        <Stat testId="offers-stat-came-back" value={r.cameBackAtFullPrice.toLocaleString("en-US")} label="Came back at full price" />
      </div>
      <div data-testid="offers-comparison" className="rounded-[8px] px-3 py-[9px] text-[13px] font-medium" style={{ background: O.mint, color: O.ok }}>{comparisonLine(r)}</div>
    </div>
  );
}
