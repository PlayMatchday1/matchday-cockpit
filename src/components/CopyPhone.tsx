"use client";

// COPY THE PHONE NUMBER — built to docs/mockups/copyphone-v1.html.
//
// Four decisions, all of them about not being noticed:
//
//   1. IT DOES NOT MOVE THE NUMBER. The tick occupies the SAME grid cell as the copy glyph, and
//      "Copied" is absolutely positioned out of flow. Swapping a 14px icon for a 48px word would
//      shift the number every single time it is used, on a panel that is read constantly. This is
//      the whole design, and it is the one thing the suite asserts by measuring.
//   2. MUTED AT REST, darker on hover and focus. The number is the content; the button is a tool.
//   3. THE HIT AREA IS BIGGER THAN THE GLYPH. 14px icon, 32px target — what you aim at and what
//      you see are not the same size.
//   4. IT COPIES THE RAW E.164 (+14697046974), never the display formatting.
//
// ON THE E.164 CHOICE: Player Lookup NORMALISES its input — detectKind (playerLookupModel.ts:20)
// strips every non-digit, so the display form would search identically. Raw E.164 is therefore a
// deliberate choice, not a constraint Lookup imposes: it is the unambiguous machine form, and it
// is what everything OTHER than Lookup expects. Recorded so nobody later "fixes" it to the pretty
// form believing Lookup requires one.
//
// FAILURE IS NOT DRESSED UP AS SUCCESS. If navigator.clipboard.writeText rejects — insecure
// context, denied permission, no clipboard API — the copied state is NOT shown. It says it could
// not copy. (The mockup's own script swallows the error and shows the tick anyway; that is the one
// place this deliberately departs from it, per the brief. A check mark for something that did not
// happen is worse than no button.)
//
// NOTHING IS LOGGED. Copying is not a write: no telemetry, no recordWrite, and the number never
// reaches change_log — which has different access rules and a longer life than a screen.

import { useEffect, useRef, useState } from "react";

type State = "idle" | "copied" | "failed";

// ONE behaviour, TWO controls. The desktop control is a glyph BESIDE the number; the mobile one
// makes the NUMBER ITSELF the button (a 32px button next to 10px text would dominate the text it
// is meant to serve). Sharing this hook is what keeps the rules — raw E.164, 1.5s revert, no
// logging, failure never dressed as success — identical in both.
function useCopy(value: string) {
  const [state, setState] = useState<State>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const copy = async () => {
    if (timer.current) clearTimeout(timer.current);
    try {
      // No fallback to execCommand: if the modern API is unavailable we say so rather than
      // silently doing something different.
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      setState("failed");
    }
    timer.current = setTimeout(() => setState("idle"), 1500);
  };
  return { state, copy, copied: state === "copied", failed: state === "failed" };
}

export default function CopyPhone({ value, className = "" }: { value: string; className?: string }) {
  const { state, copy, copied, failed } = useCopy(value);

  return (
    <button
      type="button"
      onClick={copy}
      data-testid="copy-phone"
      data-value={value}
      data-state={state}
      // The aria-label NAMES the number, so it is unambiguous out of visual context. On failure it
      // announces the failure rather than continuing to offer a copy that just did not work.
      aria-label={failed ? `Could not copy ${value}` : `Copy phone number ${value}`}
      title={failed ? "Could not copy — clipboard unavailable" : `Copy ${value}`}
      className={
        // 32px hit area around a 14px glyph. `grid` so both icons share one cell.
        "relative grid h-8 w-8 flex-none place-items-center rounded-lg border-0 bg-transparent p-0 " +
        "text-deep-green/40 transition-colors hover:bg-cream-soft hover:text-deep-green/70 " +
        "focus-visible:text-deep-green/70 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-deep-green " +
        (copied ? "text-green-700 " : "") + (failed ? "text-coral " : "") + className
      }
    >
      {/* BOTH icons live in grid cell 1/1. Only opacity changes, so the button's box — and
          therefore the number beside it — never reflows. */}
      <svg
        aria-hidden
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={"col-start-1 row-start-1 h-3.5 w-3.5 transition-opacity " + (copied ? "opacity-0" : "opacity-100")}
      >
        <rect x="5.5" y="5.5" width="8" height="8" rx="1.6" />
        <path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" />
      </svg>
      <svg
        aria-hidden
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={"col-start-1 row-start-1 h-3.5 w-3.5 text-green-700 transition-opacity " + (copied ? "opacity-100" : "opacity-0")}
      >
        <path d="M3 8.5 6.5 12 13 4.5" />
      </svg>
      {/* Out of flow — it says the word without costing the layout a pixel. */}
      <span
        aria-hidden
        data-testid="copy-phone-say"
        className={
          "pointer-events-none absolute -bottom-[19px] left-1/2 -translate-x-1/2 whitespace-nowrap " +
          "text-[10.5px] font-bold tracking-wide transition-opacity " +
          (failed ? "text-coral " : "text-green-700 ") +
          (state === "idle" ? "opacity-0" : "opacity-100")
        }
      >
        {failed ? "Couldn’t copy" : "Copied"}
      </span>
      {/* The only announcement a screen reader gets — the visual word is aria-hidden so it is not
          read twice. */}
      <span className="sr-only" role="status" aria-live="polite">
        {copied ? `Copied ${value}` : failed ? `Could not copy ${value}` : ""}
      </span>
    </button>
  );
}

// ── MOBILE: THE NUMBER ITSELF IS THE BUTTON ─────────────────────────────────
// The header number is 10px and lg:hidden. Putting a 32px control beside it would let the tool
// dominate the content it exists to serve, so on a phone the number IS the target — which is the
// obvious gesture there anyway.
//
// HOW THE BOX IS HELD STILL. At this size the tick REPLACES the number rather than sitting beside
// it, so the confirmation must not resize anything. The number therefore stays in the DOM at all
// times and merely turns invisible (visibility, NOT display) — it keeps reserving its exact width
// — while the confirmation is painted over it, absolutely positioned. The button's box is
// identical in every state, so nothing in the header shifts.
//
// IT HAS TO READ AS TAPPABLE. Plain text nobody tries is a control that does not exist: a faint
// dotted underline plus a small trailing glyph say "this does something" without shouting.
//
// min-h-8 gives a ≥32px target around 10px text.
export function CopyPhoneInline({ value, className = "" }: { value: string; className?: string }) {
  const { state, copy, copied, failed } = useCopy(value);
  const showing = copied || failed;
  return (
    <button
      type="button"
      onClick={copy}
      data-testid="copy-phone-inline"
      data-value={value}
      data-state={state}
      aria-label={failed ? `Could not copy ${value}` : `Copy phone number ${value}`}
      className={
        "relative inline-flex min-h-8 max-w-full items-center gap-1 rounded-md border-0 bg-transparent " +
        "px-1 py-1 text-left align-middle " +
        "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-deep-green " +
        className
      }
    >
      {/* Stays in the layout in EVERY state so the width never changes — invisible, not removed. */}
      <span
        data-testid="copy-phone-inline-num"
        className={
          "truncate font-mono underline decoration-dotted decoration-deep-green/30 underline-offset-2 " +
          (showing ? "invisible" : "")
        }
      >
        {value}
      </span>
      {/* the affordance glyph — small, after the number, muted */}
      <svg
        aria-hidden
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={"h-2.5 w-2.5 flex-none opacity-60 " + (showing ? "invisible" : "")}
      >
        <rect x="5.5" y="5.5" width="8" height="8" rx="1.6" />
        <path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" />
      </svg>
      {/* Painted OVER the number, out of flow — costs the layout nothing. */}
      {showing && (
        <span
          aria-hidden
          data-testid="copy-phone-inline-say"
          className={
            "pointer-events-none absolute inset-0 flex items-center gap-1 px-1 whitespace-nowrap " +
            "text-[10px] font-bold " + (failed ? "text-coral" : "text-green-700")
          }
        >
          {!failed && (
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2}
                 strokeLinecap="round" strokeLinejoin="round" className="h-2.5 w-2.5 flex-none">
              <path d="M3 8.5 6.5 12 13 4.5" />
            </svg>
          )}
          {failed ? "Couldn’t copy" : "Copied"}
        </span>
      )}
      <span className="sr-only" role="status" aria-live="polite">
        {copied ? `Copied ${value}` : failed ? `Could not copy ${value}` : ""}
      </span>
    </button>
  );
}
