"use client";

// GIVE CREDIT, inline above the reply box (Figma 20852:339).
//
// THE SAME WRITE AS PLAYER LOOKUP AND THE OLD CONTEXT PANE. POST
// /api/matchday/{env}/players/{id}/credits with { deltaCents, expectedBeforeCents, reason }: the
// route checks EDIT CREDITS and the city, re-reads the balance and aborts if it moved, writes once,
// re-reads to confirm and records it in change_log through recordWrite (source "Player Lookup ·
// credits" — the route's allowlist; a new source would be a backend change). Nothing here retries:
// a retry is a second money movement nobody asked for. Every outcome is reported as LANDED / NOT
// APPLIED / FAILED / UNKNOWN / ABORTED.
//
// Adding to the balance only: the presets and Other are positive. A deduction stays on the Credits
// tab, which carries the full +/- form.
//
// "Add … to my reply" appends one line to the reply box ONLY after the write LANDED. It never sends.

import { useCallback, useState } from "react";
import { Check, X } from "lucide-react";
import { FULL_EDITOR_ENV } from "@/lib/matchEnv";
import { validateAdjustment, fmtUsd, REASON_REQUIRED } from "@/lib/creditsModel";
import { CREDIT_PRESETS_CENTS, creditReplyLine, dollars, presetRaw } from "@/lib/inbox2Model";
import { authFetch } from "../components/ContextPane";

const ENV = FULL_EDITOR_ENV;

export default function GiveCreditPanel({ playerId, playerName, firstName, balanceCents, canCredit, onBalance, onAddLine, onClose }: {
  playerId: number;
  playerName: string;
  firstName: string;
  balanceCents: number;
  canCredit: boolean;
  onBalance: (cents: number) => void;
  onAddLine: (line: string) => void;
  onClose: () => void;
}) {
  const [preset, setPreset] = useState<number | "other" | null>(null);
  const [other, setOther] = useState("");
  const [reason, setReason] = useState("");
  const [addLine, setAddLine] = useState(true);
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ verdict: string; text: string } | null>(null);

  // A typed "Other" is an amount to ADD: a leading minus is refused here (the Credits tab deducts).
  const otherNegative = /^\s*[-−]/.test(other);
  const raw = preset === "other" ? (otherNegative ? "" : other) : preset == null ? "" : presetRaw(preset);
  const v = validateAdjustment({ raw, reason, beforeCents: balanceCents, playerName, canEdit: canCredit });
  const errors = [
    ...(otherNegative ? ["Give credit only adds. To take credit away, use the Credits tab."] : []),
    ...v.errors.filter((e) => e !== REASON_REQUIRED || attempted),
  ];
  const amount = v.deltaCents != null && v.deltaCents > 0 ? v.deltaCents : null;

  const apply = useCallback(async () => {
    if (!v.ok || amount == null || busy) return;
    setBusy(true); setRes(null);
    try {
      // ONE ATTEMPT, no retry on any outcome.
      const r = await authFetch(`/api/matchday/${ENV}/players/${playerId}/credits`, {
        method: "POST",
        body: JSON.stringify({ deltaCents: amount, expectedBeforeCents: balanceCents, reason: reason.trim() }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.status === 409 && j.aborted) {
        if (typeof j.balanceCents === "number") onBalance(j.balanceCents);
        setRes({ verdict: "ABORTED", text: String(j.error) }); return;
      }
      if (!r.ok) { setRes({ verdict: j.outcome === "UNKNOWN" ? "UNKNOWN" : "FAILED", text: String(j.error ?? `HTTP ${r.status}`) }); return; }
      if (typeof j.balanceCents === "number") onBalance(j.balanceCents);
      if (j.landed) {
        setRes({ verdict: "LANDED", text: `Balance is now ${fmtUsd(j.balanceCents)}. Logged with your reason.${addLine ? " The line is in your reply; nothing was sent." : ""}` });
        if (addLine) onAddLine(creditReplyLine(amount));
        setPreset(null); setOther(""); setReason(""); setAttempted(false);
      } else {
        setRes({ verdict: "NOT APPLIED", text: `The server accepted the write but a re-read shows ${fmtUsd(j.balanceCents)}. Nothing was retried.` });
      }
    } catch (e) {
      setRes({ verdict: "UNKNOWN", text: `${e instanceof Error ? e.message : String(e)}. It may or may not have landed. Nothing was retried; check the Credits tab.` });
    } finally { setBusy(false); }
  }, [v.ok, amount, busy, playerId, balanceCents, reason, addLine, onBalance, onAddLine]);

  const pill = (on: boolean) =>
    `rounded-[8px] border px-[14px] py-[7px] text-[13px] font-semibold transition ${on ? "border-[#0e3b2c] bg-[#0e3b2c] text-white" : "border-[#e3e3db] bg-white text-[#13241d] hover:bg-[#f7f7f3]"}`;

  return (
    <div data-testid="give-credit" className="flex flex-col gap-[10px] rounded-[12px] border border-[#e3e3db] bg-white px-4 py-[14px]">
      <div className="flex items-center gap-2">
        <span className="text-[14px] font-semibold text-[#13241d]">Give {firstName || "this player"} credit</span>
        <span className="text-[12px] text-[#7c8782]">balance {fmtUsd(balanceCents)}</span>
        <button type="button" onClick={onClose} aria-label="Close Give credit" className="ml-auto rounded p-1 text-[#7c8782] hover:bg-[#f3f3ef]">
          <X aria-hidden className="h-3.5 w-3.5" />
        </button>
      </div>
      {!canCredit ? (
        <p className="text-[12px] text-[#5e6b66]" data-testid="give-credit-locked">
          Giving credit needs <b>EDIT CREDITS</b>, which is granted separately from Match Ops.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {CREDIT_PRESETS_CENTS.map((c) => (
              <button key={c} type="button" data-testid={`give-credit-${c}`} className={pill(preset === c)} onClick={() => setPreset(c)}>{dollars(c)}</button>
            ))}
            <button type="button" data-testid="give-credit-other" className={pill(preset === "other")} onClick={() => setPreset("other")}>Other</button>
            {preset === "other" && (
              <input autoFocus value={other} onChange={(e) => setOther(e.target.value)} inputMode="decimal" placeholder="$ amount"
                data-testid="give-credit-other-amount" aria-label="Other amount"
                className="w-[96px] rounded-[8px] border border-[#cfd6d2] px-2 py-[7px] text-[13px]" />
            )}
          </div>
          <input value={reason} onChange={(e) => setReason(e.target.value)} onBlur={() => setAttempted(true)}
            placeholder="Reason (required, written to the change log)" data-testid="give-credit-reason" aria-label="Reason"
            className="w-full rounded-[8px] border border-[#cfd6d2] px-3 py-[9px] text-[13px] text-[#13241d] placeholder:text-[#7c8782]" />
          {v.consequence && amount != null && <p className="text-[12px] text-[#5e6b66]" data-testid="give-credit-sentence">{v.consequence}</p>}
          {errors.map((e) => <p key={e} className="text-[12px] font-semibold text-[#a83b1c]" data-testid="give-credit-error">{e}</p>)}
          <div className="flex flex-wrap items-center gap-[10px]">
            <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-[12px] text-[#13241d]">
              <input type="checkbox" checked={addLine} onChange={(e) => setAddLine(e.target.checked)} className="peer sr-only" data-testid="give-credit-addline" />
              <span className={`flex h-[14px] w-[14px] items-center justify-center rounded-[3px] border ${addLine ? "border-[#0e3b2c] bg-[#0e3b2c] text-white" : "border-[#cfd6d2]"}`}>
                {addLine && <Check aria-hidden className="h-2.5 w-2.5" strokeWidth={3} />}
              </span>
              {amount != null ? <>Add &ldquo;{creditReplyLine(amount).replace(/\.$/, "")}&rdquo; to my reply</> : "Add a line saying so to my reply"}
            </label>
            <button type="button" data-testid="give-credit-apply" disabled={!v.ok || amount == null || busy}
              onClick={() => { setAttempted(true); void apply(); }}
              className="rounded-[8px] bg-[#0e3b2c] px-[14px] py-[7px] text-[13px] font-semibold text-white disabled:opacity-40">
              {busy ? "Giving…" : amount != null ? `Give ${dollars(amount)}` : "Give credit"}
            </button>
          </div>
        </>
      )}
      {res && (
        <p className="text-[12px] font-semibold" data-testid="give-credit-result" data-verdict={res.verdict}
          style={{ color: res.verdict === "LANDED" ? "#12704a" : "#a83b1c" }}>{res.verdict}: {res.text}</p>
      )}
    </div>
  );
}
