"use client";

import { useEffect, useRef, useState } from "react";

// Small (i) info button + popover that explains the city tile status
// buckets and Cancel % metric. Keyword tooltip is "click-pinnable":
// hover opens it on desktop, click pins it open (so the user can read
// it without holding the cursor in place), click again or click-outside
// closes. Click-and-hold is the only sensible mobile interaction since
// there's no hover, and the same toggle handles both.
export default function CitiesLegend() {
  const [pinned, setPinned] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pinned) return;
    function onPointerDown(e: PointerEvent) {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setPinned(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setPinned(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [pinned]);

  return (
    <div ref={ref} className="group relative inline-block align-middle">
      <button
        type="button"
        onClick={() => setPinned((v) => !v)}
        aria-label="What do these statuses mean?"
        aria-expanded={pinned}
        className="inline-flex h-[13px] w-[13px] items-center justify-center rounded-full bg-deep-green/15 text-[9px] font-bold leading-none text-deep-green/70 transition hover:bg-deep-green/25 hover:text-deep-green"
      >
        i
      </button>
      <div
        role="tooltip"
        className={`absolute left-1/2 top-[calc(100%+8px)] z-50 w-[300px] -translate-x-1/2 rounded-lg border border-cream-line bg-white p-3.5 text-[12px] leading-snug shadow-lg shadow-deep-green/15 transition-opacity ${
          pinned
            ? "opacity-100"
            : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100"
        }`}
      >
        <div className="text-[13px] font-bold text-deep-green">
          Status — is this city growing?
        </div>
        <div className="mt-1 text-deep-green/65">
          Compares match volume in the last 4 weeks vs the 4 weeks before.
        </div>
        <ul className="mt-2 space-y-1.5">
          <LegendRow
            tone="text-mint-hover"
            label="Growing"
            description="Running more matches than a month ago"
            formula="+10% or more"
          />
          <LegendRow
            tone="text-deep-green/65"
            label="Stable"
            description="Roughly the same volume as a month ago"
          />
          <LegendRow
            tone="text-coral"
            label="Declining"
            description="Running fewer matches than a month ago"
            formula="−10% or more"
          />
          <LegendRow
            tone="text-blue-info"
            label="Just launched"
            description="Less than 8 matches in the last 4 weeks"
          />
        </ul>
        <div className="mt-3 border-t border-cream-line/60 pt-2.5">
          <div className="text-[13px] font-bold text-deep-green">Cancel %</div>
          <div className="mt-1 text-deep-green/65">
            Matches that didn&apos;t run, out of matches scheduled this month.
          </div>
        </div>
      </div>
    </div>
  );
}

function LegendRow({
  tone,
  label,
  description,
  formula,
}: {
  tone: string;
  label: string;
  description: string;
  formula?: string;
}) {
  return (
    <li>
      <span className={`font-bold ${tone}`}>{label}</span>
      <span className="text-deep-green/65"> — {description}</span>
      {formula && (
        <span className="text-deep-green/40"> ({formula})</span>
      )}
    </li>
  );
}
