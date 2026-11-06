"use client";

// THE CANCEL REASON (Ryan, 2026-11-01), required on every Clubhouse cancel: the six staff reasons as
// chips, a note that is required only for Other. Not enough players comes first (Ryan, 2026-11-06): it
// is the same "players" reason MatchDay's own auto-cancels are read as (src/lib/cancelReasons.ts), so
// Health counts both together. The Cancel button beside this is disabled until the hook's canRun.

import { NOTE_MAX, REASON_HINT, REASON_LABEL, STAFF_REASONS } from "@/lib/cancelReasons";
import type { CancelState } from "@/lib/useCancelMatch";

export default function CancelReasonPicker({ cancel, testPrefix }: { cancel: CancelState; testPrefix: string }) {
  return (
    <div data-testid={`${testPrefix}-reason`} style={{ margin: "0 0 12px" }}>
      <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: ".04em", color: "#5a1611", margin: "0 0 6px" }}>REASON (REQUIRED)</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {STAFF_REASONS.map((r) => {
          const on = cancel.reason === r;
          return (
            <button key={r} type="button" data-testid={`${testPrefix}-reason-${r}`} aria-pressed={on} title={REASON_HINT[r]}
              disabled={cancel.busy} onClick={() => cancel.setReason(on ? null : r)}
              style={{ borderRadius: 999, padding: "5px 11px", fontSize: 12.5, fontWeight: 700, cursor: "pointer",
                border: `1.5px solid ${on ? "#a8341f" : "#e2c9c4"}`, background: on ? "#a8341f" : "#fff", color: on ? "#fff" : "#5a1611" }}>
              {REASON_LABEL[r]}
            </button>
          );
        })}
      </div>
      {cancel.reason ? <div style={{ fontSize: 12, color: "#7a4a42", marginTop: 5 }}>{REASON_HINT[cancel.reason]}</div> : null}
      <textarea data-testid={`${testPrefix}-reason-note`} value={cancel.note} maxLength={NOTE_MAX} disabled={cancel.busy}
        onChange={(e) => cancel.setNote(e.target.value)} rows={2}
        placeholder={cancel.reason === "other" ? "A short note (required for Other)" : "Note (optional)"}
        style={{ width: "100%", marginTop: 8, borderRadius: 8, border: "1.5px solid #e2c9c4", padding: "6px 8px", fontSize: 13, resize: "vertical" }} />
      {cancel.reasonMissing ? <div data-testid={`${testPrefix}-reason-missing`} style={{ fontSize: 12, color: "#a8341f", marginTop: 4 }}>{cancel.reasonMissing}</div> : null}
    </div>
  );
}
