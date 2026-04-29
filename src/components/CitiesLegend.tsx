"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

// (i) info button + smart-positioned popover. Click to open, click
// outside / Escape to close. No hover behavior — too finicky inside
// a Link-wrapped card. Renders into document.body via portal so the
// popover escapes the parent card's stacking context and the
// width/z-index are predictable across all viewports.

const TOOLTIP_WIDTH = 320;
const VIEWPORT_PADDING = 12; // min gap between tooltip edge and viewport edge
const GAP = 8; // gap between trigger and tooltip
const MOBILE_BREAKPOINT = 640;

type Position = {
  top: number;
  left: number;
  isMobile: boolean;
};

export default function CitiesLegend() {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [position, setPosition] = useState<Position | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  // Hydration-safe portal — only render after first mount.
  useEffect(() => {
    setMounted(true);
  }, []);

  // Compute position when open. Re-runs on scroll, resize, and after
  // the tooltip first mounts (RAF) to use the measured height instead
  // of an estimate.
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }

    const compute = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const isMobile = window.innerWidth < MOBILE_BREAKPOINT;
      if (isMobile) {
        setPosition({ top: 0, left: 0, isMobile: true });
        return;
      }

      const rect = trigger.getBoundingClientRect();
      const tooltipH = tooltipRef.current?.offsetHeight ?? 360;

      // Vertical: prefer below; flip above if not enough room.
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;
      const placeAbove =
        spaceBelow < tooltipH + GAP + VIEWPORT_PADDING &&
        spaceAbove > spaceBelow;
      const top = placeAbove
        ? rect.top - tooltipH - GAP
        : rect.bottom + GAP;

      // Horizontal: try centered on trigger; clamp to viewport edges.
      let left = rect.left + rect.width / 2 - TOOLTIP_WIDTH / 2;
      const maxLeft = window.innerWidth - TOOLTIP_WIDTH - VIEWPORT_PADDING;
      if (left > maxLeft) left = maxLeft;
      if (left < VIEWPORT_PADDING) left = VIEWPORT_PADDING;

      setPosition({ top, left, isMobile: false });
    };

    compute();
    const raf = requestAnimationFrame(compute); // re-measure once tooltip is laid out

    const onScroll = () => compute();
    const onResize = () => compute();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  // Click-outside + Escape to close.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (triggerRef.current?.contains(e.target as Node)) return;
      if (tooltipRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const portalNode = open && mounted ? renderPortal(position, tooltipRef) : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={(e) => {
          // Trigger sits inside a Link-wrapped card; without these the
          // click bubbles up and navigates away.
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        aria-label="What do these statuses mean?"
        aria-expanded={open}
        className="inline-flex h-[13px] w-[13px] items-center justify-center rounded-full bg-deep-green/15 text-[9px] font-bold leading-none text-deep-green/70 transition hover:bg-deep-green/25 hover:text-deep-green"
      >
        i
      </button>
      {portalNode && createPortal(portalNode, document.body)}
    </>
  );
}

function renderPortal(
  position: Position | null,
  tooltipRef: React.RefObject<HTMLDivElement | null>,
): ReactNode {
  if (!position) {
    // First render before useLayoutEffect computes — render hidden so
    // we can measure height without a visible flash.
    return (
      <div
        ref={tooltipRef}
        role="tooltip"
        aria-hidden
        style={{
          position: "fixed",
          top: -9999,
          left: -9999,
          width: TOOLTIP_WIDTH,
          visibility: "hidden",
        }}
        className="rounded-lg border border-cream-line bg-white p-3.5 text-[12px] leading-snug"
      >
        <TooltipBody />
      </div>
    );
  }

  if (position.isMobile) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
        <div className="absolute inset-0 bg-deep-green/30" aria-hidden />
        <div
          ref={tooltipRef}
          role="dialog"
          aria-modal="true"
          className="relative w-full max-w-[340px] rounded-lg border border-cream-line bg-white p-4 text-[12px] leading-snug shadow-xl shadow-deep-green/30"
        >
          <TooltipBody />
        </div>
      </div>
    );
  }

  return (
    <div
      ref={tooltipRef}
      role="tooltip"
      style={{
        position: "fixed",
        top: position.top,
        left: position.left,
        width: TOOLTIP_WIDTH,
      }}
      className="z-50 rounded-lg border border-cream-line bg-white p-3.5 text-[12px] leading-snug shadow-lg shadow-deep-green/15"
    >
      <TooltipBody />
    </div>
  );
}

function TooltipBody() {
  return (
    <>
      <div className="mb-2.5 text-deep-green/65">
        Toggle{" "}
        <span className="font-bold text-deep-green">
          This week / Last week
        </span>{" "}
        to see complete-week numbers (current week is in-progress).
      </div>
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
          Stays month-to-date regardless of week toggle for sample-size reasons.
        </div>
      </div>
    </>
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
      {formula && <span className="text-deep-green/40"> ({formula})</span>}
    </li>
  );
}
