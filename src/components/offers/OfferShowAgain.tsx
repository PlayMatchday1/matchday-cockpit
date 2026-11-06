"use client";

// "SHOW AGAIN" (backend 08145ea): on a launched offer's results card. A read first (GET .../show-again) says what a
// press would do: "Show again to N players who saw it but haven't booked", or why it can't run now, in plain words,
// with the button greyed. The press asks first, then POSTs as the signed-in person; LANDED moves the page to the
// campaign the backend returns (its popupRound one higher). The history line is what the backend exposes: the current
// round and the last press (who, when). Earlier rounds, each round's reach and bookings after each round are kept in
// the backend's offer_popup_rounds but not readable from here (no route lists them).

import { useCallback, useEffect, useState } from "react";
import { showAgainHistory, showAgainLine, showAgainWhy, type Campaign, type ListChange, type ShowAgainPreview } from "@/lib/offersModel";
import { Btn, ConfirmDialog, O, VerdictLine, authed, outcomeOf, type WriteOutcome } from "./offersUi";

export default function ShowAgainRow({ c, onLanded }: { c: Campaign; onLanded: (o: WriteOutcome, selectId?: number, change?: ListChange) => void }) {
  const [preview, setPreview] = useState<ShowAgainPreview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [outcome, setOutcome] = useState<WriteOutcome | null>(null);
  const load = useCallback(async () => {
    setErr(null);
    const r = await authed(`/api/offers/${c.id}/show-again`);
    if (r.ok) setPreview(r.json as unknown as ShowAgainPreview); else { setPreview(null); setErr(String(r.json.error)); }
  }, [c.id]);
  // Read on open and again after each press (the campaign's round changes, and so does the preview).
  useEffect(() => { void load(); }, [load, c.popupRound]);
  async function press(): Promise<WriteOutcome> {
    const r = await authed(`/api/offers/${c.id}/show-again`, { method: "POST", body: JSON.stringify({ fromRound: preview?.round ?? c.popupRound ?? 1 }) });
    const reached = typeof r.json.reached === "number" ? (r.json.reached as number) : null;
    const o = outcomeOf(r, `Shown again${reached !== null ? ` to ${reached.toLocaleString("en-US")} ${reached === 1 ? "player" : "players"}` : ""}. They see the popup once more on their next app open.`);
    setOutcome(o);
    if (o.verdict === "LANDED") {
      const after = (r.json.after ?? null) as Campaign | null;
      onLanded(o, c.id, after ? { kind: "saved", campaign: after } : undefined);
    }
    return o;
  }
  const why = preview ? showAgainWhy(preview.reason, preview.nextAllowedAt) : null;
  const history = showAgainHistory(c);
  return (
    <div data-testid="offers-show-again" data-allowed={preview ? (preview.allowed ? "1" : "0") : "?"} className="flex flex-col gap-2 rounded-[8px] px-3 py-2.5" style={{ background: O.subtle }}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex min-w-[200px] flex-1 flex-col gap-0.5">
          <div data-testid="offers-show-again-line" className="text-[13px] font-semibold" style={{ color: O.ink }}>
            {err ? `Show again: ${err}` : !preview ? "Show again: checking who it would reach…" : preview.allowed ? showAgainLine(preview.reach) : `Show again isn't available now`}
          </div>
          {preview && !preview.allowed && why && <div data-testid="offers-show-again-why" className="text-[12px]" style={{ color: O.muted }}>{why}</div>}
          {preview?.allowed && <div className="text-[12px]" style={{ color: O.muted }}>Once a day per offer. Held-back players and used-up offers never come back.</div>}
          {history && <div data-testid="offers-show-again-history" className="text-[12px]" style={{ color: O.muted }}>{history}</div>}
        </div>
        {err
          ? <button type="button" className="text-[12px] font-semibold underline" style={{ color: O.ink }} onClick={() => void load()}>Retry</button>
          : <Btn kind="primary" testId="offers-show-again-go" disabled={!preview?.allowed} title={why ?? undefined} onClick={() => setConfirm(true)}>Show again</Btn>}
      </div>
      {outcome && <VerdictLine outcome={outcome} />}
      {confirm && preview && (
        <ConfirmDialog title={`Show ${c.name} again?`} note={`${showAgainLine(preview.reach)}. They get the popup once more on their next app open; players who never saw it, held-back players and used-up offers are not affected. This can run once a day.`}
          action="Show again" onCancel={() => setConfirm(false)}
          onConfirm={async () => { const o = await press(); if (o.verdict === "LANDED") setConfirm(false); return o; }} />
      )}
    </div>
  );
}
