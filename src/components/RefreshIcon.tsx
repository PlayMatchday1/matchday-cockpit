// THE refresh glyph, in one place.
//
// It lived inline in GamedayBoard, so when that got a proper circular arrow the Chats header kept
// the old thin ring with no arrowhead — a shape that reads as a spinner stuck mid-spin, or as
// nothing at all. Anything that offers a refresh imports this; there is nothing left to miss.
//
// `spinning` rotates the SAME glyph rather than swapping in a different one, so idle and in-flight
// are recognisably one control.

export default function RefreshIcon({ size = 18, spinning = false, className = "" }: { size?: number; spinning?: boolean; className?: string }) {
  return (
    <svg
      className={`mo-ricon${spinning ? " on" : ""}${className ? ` ${className}` : ""}`}
      data-testid="refresh-icon"
      data-spinning={spinning ? "true" : "false"}
      viewBox="0 0 24 24" width={size} height={size}
      fill="none" stroke="currentColor" strokeWidth={2.1} strokeLinecap="round" strokeLinejoin="round"
      aria-hidden
    >
      {/* the arc, stopping short so the arrowhead reads as a direction rather than a closed ring */}
      <path d="M20 11a8 8 0 1 0-2.3 5.7" />
      {/* the arrowhead — the part the old glyph was missing */}
      <path d="M20 4.5V11h-6.2" />
      <style>{`
        .mo-ricon{display:block;transform-origin:50% 50%}
        .mo-ricon.on{animation:mo-rspin .8s linear infinite}
        @keyframes mo-rspin{to{transform:rotate(360deg)}}
        @media(prefers-reduced-motion:reduce){.mo-ricon.on{animation:none}}
      `}</style>
    </svg>
  );
}
