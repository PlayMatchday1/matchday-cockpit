"use client";

// THE MANAGER PAY PERIOD BAR — one component, two callers.
//
// EXTRACTED, NOT REBUILT. This was inline JSX inside ManagerPayView, which is why the
// city-manager view had no period controls at all: there was nothing to mount, so the tier could
// only ever see one week. Rebuilding it for /city would have been the same mistake that tier
// already made once with Reviews and Gameday Ops — a parallel implementation that drifts. The
// admin's markup is carried over verbatim; only the props differ.
//
// THE ARRIVAL CONTROL IS A WRITE, AND THAT IS WHY IT IS A PROP.
// "Change" opens an editor that PUTs /api/manager-pay/pay-arrival (and DELETEs it to reset), which
// moves the date every manager in every city is told to expect their money. A city manager must
// not have it.
//
// It is DISABLED AND VISIBLE for them, not hidden: the bar states what the arrival date is and
// says plainly that only MatchDay can move it. Hiding the control would leave a city manager
// wondering whether the date is editable and where; a greyed control with a reason answers that
// without offering a lever. (The server is the real guard either way — pay-arrival is admin-gated,
// so a hand-made request is refused regardless of what this renders.)

import type React from "react";

const C = {
  forest: "#0d3b2e", forestDeep: "#072a20", accent: "#35c77f", ink: "#12241d",
  muted: "#6d7b74", line: "#e6ebe8", surface: "#ffffff", railA: "#f6f9f7",
  chipBg: "#eef3f0", chipLine: "#e2eae5", ok: "#12704a",
  warnBg: "#fdf1d0", warnLine: "#e3c369", warnInk: "#8a6300",
};
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dshort = (iso: string) => `${MON[+iso.slice(5, 7) - 1]} ${+iso.slice(8, 10)}`;
const dfull = (iso: string) => `${MON[+iso.slice(5, 7) - 1]} ${+iso.slice(8, 10)}, ${iso.slice(0, 4)}`;

export type ArrivalOverride = { by?: string | null; at: string; reason: string } | null;

export type PayPeriodBarProps = {
  weekStart: string;          // YYYY-MM-DD (Monday)
  weekEnd: string;
  defaultWeekStart: string;   // the "last completed" Monday, for the chip
  payRun: string | null;
  effectiveArrival: string | null;
  arrivalError?: string | null;
  arrivalOverride?: ArrivalOverride;
  onWeek: (weekStart: string) => void;
  view: "both" | "pay";
  onView: (v: "both" | "pay") => void;
  // THE WRITE. Omit `onToggleArrival` (or pass canChangeArrival={false}) and the control renders
  // disabled with `arrivalDisabledReason` beside it.
  canChangeArrival: boolean;
  arrivalDisabledReason?: string;
  arrivalEditing?: boolean;
  onToggleArrival?: () => void;
  arrivalEditor?: React.ReactNode;
};

const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export default function PayPeriodBar(p: PayPeriodBarProps) {
  return (
    <div
      data-testid="pay-period-bar"
      className="mb-3 flex flex-wrap items-center gap-3 rounded-[12px] border"
      style={{ background: C.surface, borderColor: C.line, padding: "11px 14px" }}
    >
      <div className="flex items-center gap-2">
        <button type="button" aria-label="Previous week" data-testid="pay-week-prev"
          onClick={() => p.onWeek(addDays(p.weekStart, -7))}
          className="flex h-[30px] w-[30px] items-center justify-center rounded-[8px] border"
          style={{ background: C.railA, borderColor: C.chipLine, color: C.forest }}>‹</button>
        <span className="whitespace-nowrap text-[14.5px] font-[800]" data-testid="pay-week-label" style={{ color: C.forestDeep }}>
          {dshort(p.weekStart)} – {dfull(p.weekEnd)}
        </span>
        <button type="button" aria-label="Next week" data-testid="pay-week-next"
          onClick={() => p.onWeek(addDays(p.weekStart, 7))}
          className="flex h-[30px] w-[30px] items-center justify-center rounded-[8px] border"
          style={{ background: C.railA, borderColor: C.chipLine, color: C.forest }}>›</button>
        {/* JUMP TO A WEEK. Same pattern as Master Schedule's and GamedayBoard's — see the comment
            on `day-pick` in GamedayBoard, which is written out in full.

            THIS COMPONENT DOES NO DATE ARITHMETIC FOR THE PICKER, and that was the whole reason
            the server changed rather than this file: /api/manager-pay/week and /city-week now snap
            ANY day to that week's Monday, exactly as fetchVeoWeek does, so the clicked value goes
            straight into onWeek() — the same callback ‹ › already use. Snapping here instead would
            have put a week-boundary calculation into a shared component with TWO callers, both of
            which would inherit it.

            THE VALUE IS p.weekStart, so the input always holds the displayed week's Monday and
            visibly snaps back to it after a mid-week pick. The picker and the arrows are one
            state and one setter and cannot disagree. */}
        <input type="date" aria-label="Jump to a week" data-testid="pay-week-pick"
          title="Jump to the week containing this date"
          value={p.weekStart} onChange={(e) => { if (e.target.value) p.onWeek(e.target.value); }}
          className="h-[30px] rounded-[8px] border px-2 text-[12.5px] font-[700]"
          style={{ background: C.surface, borderColor: C.chipLine, color: C.forest }} />
      </div>

      <span className="rounded-full border px-[9px] py-[3px] text-[10.5px] font-[800] tracking-[0.05em]"
        data-testid="pay-week-chip"
        style={{ background: C.chipBg, borderColor: C.chipLine, color: C.muted }}>
        {p.weekStart === p.defaultWeekStart ? "LAST COMPLETED" : p.weekStart > p.defaultWeekStart ? "IN PROGRESS" : "PAST WEEK"}
      </span>

      <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px]" style={{ color: C.muted }}>
        <span>Pay run <b style={{ color: C.ink }} data-testid="pay-run">{p.payRun ? dfull(p.payRun) : "—"}</b></span>
        <span className="inline-flex items-center gap-1.5">
          Est. arrival{" "}
          <b style={{ color: C.ink }} data-testid="pay-arrival">
            {p.effectiveArrival ? dfull(p.effectiveArrival) : (p.arrivalError ? "unavailable" : "—")}
          </b>
          {p.arrivalOverride && (
            <span title={`Adjusted by ${p.arrivalOverride.by ?? "an admin"} on ${p.arrivalOverride.at} — ${p.arrivalOverride.reason}`}
              className="rounded-full border px-[7px] py-[2px] text-[9.5px] font-[800]"
              style={{ background: C.warnBg, borderColor: C.warnLine, color: C.warnInk }}>ADJUSTED</span>
          )}
          {p.canChangeArrival ? (
            <button type="button" data-testid="pay-arrival-change" onClick={p.onToggleArrival}
              className="text-[10.5px] font-bold underline" style={{ color: C.ok }}>
              {p.arrivalEditing ? "Close" : "Change"}
            </button>
          ) : (
            // DISABLED AND VISIBLE, with the reason next to it — see the header comment.
            <>
              <button type="button" disabled data-testid="pay-arrival-change-disabled"
                className="text-[10.5px] font-bold underline" style={{ color: C.muted, cursor: "not-allowed", opacity: 0.6 }}>
                Change
              </button>
              {p.arrivalDisabledReason && (
                <i className="not-italic text-[10.5px]" data-testid="pay-arrival-reason" style={{ color: C.muted }}>
                  {p.arrivalDisabledReason}
                </i>
              )}
            </>
          )}
        </span>
      </div>

      {p.canChangeArrival && p.arrivalEditing && p.arrivalEditor && (
        <div className="w-full">{p.arrivalEditor}</div>
      )}

      <div className="inline-flex overflow-hidden rounded-[9px] border" data-testid="pay-view-toggle"
        style={{ borderColor: C.chipLine, background: C.railA }}>
        <button type="button" onClick={() => p.onView("both")} data-testid="pay-view-both"
          className="px-[13px] py-[7px] text-[12.5px] font-bold"
          style={p.view === "both" ? { background: C.accent, color: "#06281d" } : { background: "transparent", color: C.muted }}>Week + pay</button>
        <button type="button" onClick={() => p.onView("pay")} data-testid="pay-view-pay"
          className="px-[13px] py-[7px] text-[12.5px] font-bold"
          style={p.view === "pay" ? { background: C.accent, color: "#06281d" } : { background: "transparent", color: C.muted }}>Pay only</button>
      </div>
    </div>
  );
}
