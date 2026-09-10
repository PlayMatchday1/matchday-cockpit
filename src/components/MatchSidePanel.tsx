"use client";

/* THE RIGHT-HAND MATCH PANEL — Details and Chat, one panel, two tabs.
 *
 * LIFTED OUT OF GamedayBoard RATHER THAN COPIED, because the Veo page is the third surface that
 * wants it and a third copy of a tab strip is where they start to disagree.
 *
 * IT KEEPS GAMEDAY'S CLASS NAMES ON PURPOSE. The panel's styles live in GamedayBoard's own CSS
 * string, scoped `.gdo .gpanel…`. Renaming them would have meant editing that stylesheet and
 * re-proving a heavily-used page looks the same — and the brief for this change says that if the
 * lift changes anything on Gameday Ops, that is a regression rather than a side effect. So the DOM
 * and the classes are byte-identical to what GamedayBoard rendered before; Gameday's rules still
 * match it, and a host page that is not `.gdo` supplies its own copy of the rules.
 *
 * WHAT STAYED BEHIND. Gameday's prev/next stepping, its unsaved-edit guard and its CRM-dock
 * collapse are all board state, and they are passed IN rather than moved: the Veo page has no
 * sibling list to step through and no dock to collapse. The component assumes neither.
 */

import { useState, type ReactNode } from "react";
import MatchPanel, { type PanelSavedPatch } from "@/components/MatchPanel";
import ChatPane from "@/app/(internal)/match-ops/match-chats/ChatPane";

export type PanelTab = "details" | "chat";

export default function MatchSidePanel({
  matchId, tab, onTab, onClose, width, right = 0, className = "", notice, steps, onDirtyChange,
  onSaved, onCancelLanded, slot,
}: {
  /** The match api id. It is ALSO the chat id — proven, and no second lookup. */
  matchId: number;
  /** The recurring slot this match sits in, computed server-side by veoSchedule.slotKeyOf and
   *  carried on the schedule row. PASSED THROUGH, NOT DERIVED: the weekday is wall-clock date math
   *  and the field is the raw title, and one implementation of that key is the point. Absent on a
   *  host that has no schedule row for the match, and the CAMERA section is then absent too. */
  slot?: { city: string; field: string; weekday: number; hhmm: string } | null;
  tab: PanelTab;
  onTab: (t: PanelTab) => void;
  onClose: () => void;
  width: number;
  /** Pixels of right offset, so a host with a docked chat can sit the panel beside it. */
  right?: number;
  className?: string;
  notice?: ReactNode;
  /** Optional prev/next. Absent on a host with no sibling list, and the control is then absent too. */
  steps?: { onPrev: () => void; onNext: () => void; canPrev: boolean; canNext: boolean };
  /** Gameday's unsaved-edit guard hangs off this. It is passed THROUGH, not dropped: leaving it out
   *  would have silently disabled the "you have unsaved changes" guard on that board. */
  onDirtyChange?: (dirty: boolean) => void;
  /* PASSED THROUGH, LIKE onDirtyChange. A host with a grid keeps one card in sync without a
   * reload; a host without one passes neither and the panel behaves exactly as it did. */
  onSaved?: (patch: PanelSavedPatch) => void;
  onCancelLanded?: () => void;
}) {
  return (
    <aside className={`gpanel ${className}`} data-testid="gday-panel"
      /* --panel-right travels with `right` so the stylesheet can hold the panel to 92vw of the
         space it actually has, rather than of the whole window, when a dock sits beside it. */
      style={{ ["--panel-w" as string]: `${width}px`, ["--panel-right" as string]: `${right}px`, right }}>
      <div className="gpanel-bar">
        <button className="gpanel-x" data-testid="gday-panel-close" aria-label="Close panel" onClick={onClose}>✕ Close</button>
        {steps && (
          <span className="gpanel-step">
            <button data-testid="gday-prev" aria-label="Previous match" disabled={!steps.canPrev} onClick={steps.onPrev}>‹</button>
            <button data-testid="gday-next" aria-label="Next match" disabled={!steps.canNext} onClick={steps.onNext}>›</button>
          </span>
        )}
      </div>
      {notice}
      {/* THE TAB STRIP. Two tabs, one panel. */}
      <div className="gpanel-tabs" role="tablist" data-testid="gday-panel-tabs">
        <button type="button" role="tab" data-testid="gday-tab-details"
          aria-selected={tab === "details"} className={tab === "details" ? "on" : ""}
          onClick={() => onTab("details")}>Details</button>
        <button type="button" role="tab" data-testid="gday-tab-chat"
          aria-selected={tab === "chat"} className={tab === "chat" ? "on" : ""}
          onClick={() => onTab("chat")}>Chat</button>
      </div>
      {/* DETAILS IS HIDDEN, NOT UNMOUNTED. Unmounting it would throw away unsaved edits on every
          tab switch — the operator changes the minimum, flips to Chat to ask the manager about it,
          comes back and the change is gone. */}
      <div className={"gpanel-body" + (tab === "details" ? "" : " gpanel-hide")}
        data-testid="gday-panel-details" aria-hidden={tab !== "details"}>
        <MatchPanel key={matchId} matchId={String(matchId)} onDirtyChange={onDirtyChange}
          onSaved={onSaved} onCancelLanded={onCancelLanded} slot={slot} />
      </div>
      {/* CHAT RESOLVES THE THREAD THE WAY IT WAS PROVEN TO RESOLVE: chatId is the match api_id. */}
      <div className={"gpanel-body gpanel-chat" + (tab === "chat" ? "" : " gpanel-hide")}
        data-testid="gday-panel-chat" aria-hidden={tab !== "chat"} data-chat-id={String(matchId)}>
        <ChatPane chatId={String(matchId)} showOnMobile={false} embedded onBack={() => onTab("details")} />
      </div>
    </aside>
  );
}

/** THE PANEL'S STYLESHEET, AND THE ONLY COPY OF IT.
 *
 * IT USED TO BE TWO. GamedayBoard kept `.gdo .gpanel…` rules and this export was described as the
 * copy "used by any host page that is not .gdo" — and it was an INCOMPLETE copy. It was missing the
 * four height-chain rules, the safe-area padding on the bar, and all three media queries. Master
 * Schedule adopted the panel, got this export, and Ryan found the result: the panel would not
 * scroll (the touch fell through to the grid behind it) and "× Close" was drawn under the iOS
 * clock. GamedayBoard had already documented that exact failure — .mp-body measured 2626px inside
 * an 864px panel — fixed it in its own stylesheet, and this copy never got the fix.
 *
 * So there is one now, and GamedayBoard consumes it. Same lesson MatchDrawer's header drew about
 * editors: two copies on one route is how they drift.
 *
 * THE RULES ARE UNPREFIXED. They were `.gdo`-prefixed, which is more specific — but nothing else in
 * GamedayBoard's stylesheet targets a .gpanel element (checked: only .gtile and .mpick are near,
 * and neither is inside the panel), so there is nothing left for the lower specificity to lose to.
 * Verified by comparing computed styles on Gameday Ops before and after at three widths. */
export const MATCH_SIDE_PANEL_CSS = `
/* Fixed right edge; the right offset is set inline to the dock width when they coexist (>=1600) so
   the two never overlap. --panel-right is subtracted so 92vw is of the space the panel actually
   has, not of the whole window. */
.gpanel{position:fixed;top:0;bottom:0;height:100dvh;width:min(var(--panel-w,600px),calc(92vw - var(--panel-right,0px)));max-width:100vw;background:#eef2f0;border-left:1px solid #d4e0da;box-shadow:-8px 0 26px rgba(4,26,18,.12);z-index:60;display:flex;flex-direction:column;overscroll-behavior:contain}
/* SAFE AREA. The panel is position:fixed top:0, so without this the header renders beneath the iOS
   status bar and the Dynamic Island — "× Close" was drawn straight through the clock and could not
   be tapped without rotating the device. The bar is STICKY and starts BELOW the inset; the body
   scrolls under it. env() is 0 on desktop, so this changes nothing there. */
.gpanel-bar{display:flex;align-items:center;gap:8px;padding:9px 12px;background:#04291d;color:#fff;flex:0 0 auto;
  position:sticky;top:0;z-index:2;padding-top:calc(9px + var(--sat));
  padding-left:calc(12px + var(--sal, 0px));padding-right:calc(12px + var(--sar, 0px))}
/* >=44px: this is the only way out of the panel on a phone. */
.gpanel-x{border:1px solid #2a5644;background:transparent;color:#cfe7dc;border-radius:8px;padding:7px 13px;
  min-height:44px;min-width:44px;font:inherit;font-size:13px;font-weight:600;cursor:pointer}
.gpanel-x:hover{background:#14432f;color:#fff}
.gpanel-step{margin-left:auto;display:inline-flex;gap:5px}
.gpanel-step button{border:1px solid #2a5644;background:transparent;color:#cfe7dc;border-radius:8px;min-width:36px;min-height:34px;font:inherit;font-size:17px;cursor:pointer}
.gpanel-step button:disabled{opacity:.4;cursor:not-allowed}
.gpanel-notice{display:flex;align-items:center;gap:10px;background:#fdf2e0;border-bottom:1px solid #e8c383;color:#6b4400;font-size:12px;line-height:1.4;padding:9px 12px;flex:0 0 auto}
.gpanel-notice button{margin-left:auto;border:1px solid #e8c383;background:#fff;border-radius:6px;padding:4px 10px;font:inherit;font-size:11.5px;font-weight:600;cursor:pointer;white-space:nowrap}
/* THE PANEL DOES NOT SCROLL — THE FORM INSIDE IT DOES, and that is the whole of the save-bar fix.
   This was overflow-y:auto, so MatchPanel sat inside it as ordinary content: .mp-panel's own
   display:flex + overflow:hidden never received a bounded height, it grew to its content, and
   .mp-foot scrolled away with it — measured at top:2782px in a 950px viewport on desktop and
   top:4112px in 780px on a phone.
   The bottom padding moves to .mp-foot, which is now the element actually touching the bottom. */
.gpanel-body{flex:1;min-height:0;overflow:hidden;padding:12px;display:flex;flex-direction:column;overscroll-behavior:contain}
/* ── THE HEIGHT CHAIN. FOUR RULES, AND ALL FOUR ARE LOAD-BEARING. ───────────────────────────────
   Only in the panel. The standalone /match-ops/match-panel/[id] page is a document that scrolls
   with the window, and giving it a viewport height there would trap it in a box — which is why
   every one of these is scoped under .gpanel-body and none of them touches that page. */
.gpanel-body>.mp{min-height:0;flex:1 1 auto;display:flex}
/* AND THE PANEL INSIDE IT MUST NOT RE-CAP THE WIDTH. .mp-panel carries max-width:860px at >=1100
   for the standalone /match-panel page; inside this panel the panel IS the width, and leaving the
   cap on threw away most of what widening it just bought. */
.gpanel-body>.mp>.mp-panel{height:100%;max-width:none}
/* THE FIELDSET IS THE FLEX CHILD, not .mp-body. .mp-body lives inside <fieldset class="mp-fs">,
   which wraps the whole form so a read-only viewer gets a genuinely disabled control set rather
   than one that only looks disabled. Without this the fieldset takes its content height, .mp-body
   never shrinks (measured 2626px inside an 864px panel) and the foot is pushed off the bottom —
   which is what the first attempt at this fix missed, and what Master Schedule shipped with:
   .mp-body had no bounded height, so it had nothing to scroll and the touch fell through to the
   grid behind the panel. */
.gpanel-body>.mp>.mp-panel>.mp-fs{flex:1 1 auto;min-height:0;display:flex;flex-direction:column}
/* ── AND THE SCROLL STOPS AT THE PANEL'S EDGE ─────────────────────────────────────────────────
 * overscroll-behavior was auto, so the moment .mp-body reached its end the browser CHAINED the
 * scroll to the page behind — measured: seven wheel notches took .mp-body to its 2579px end and
 * the eighth moved the WINDOW by 500 with the panel unmoved. On a trackpad one flick carries
 * straight through, and what an operator sees is a form that stops responding while the page
 * behind it lurches.
 *
 * IT LOOKS LIKE A BROKEN PANEL IN MONTH VIEW SPECIFICALLY, which is why it was reported there and
 * not in Week: Month's grid is a tall calendar that visibly jumps, and its page has 2365px to give.
 * The panel itself is identical in both — the chain walk matches link for link. Nothing was ever
 * wrong with the layout; the scroll was simply allowed to leave.
 *
 * NO BACKTICKS IN HERE: this stylesheet is a template literal and one inside a comment ends the
 * string — which is exactly what happened writing this block. contain keeps normal scrolling inside and refuses only the propagation. On .gpanel too, so a
 * scroller the panel gains later (the chat pane already has one) inherits the same rule. */
.gpanel-body>.mp>.mp-panel>.mp-fs>.mp-body{flex:1 1 auto;min-height:0;overscroll-behavior:contain}

/* ── THE TWO TABS ──────────────────────────────────────────────────────────────────────────── */
.gpanel-tabs{display:flex;gap:2px;padding:0 12px;border-bottom:1px solid #DCE5E0;flex:0 0 auto;background:#fff}
.gpanel-tabs button{border:0;background:none;font:inherit;font-size:12.5px;font-weight:700;
  color:#66786E;padding:9px 14px;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px}
.gpanel-tabs button:hover{color:#1B3227}
.gpanel-tabs button.on{color:#046B45;border-bottom-color:#046B45}
/* HIDDEN, NOT UNMOUNTED - display:none keeps the React tree alive so unsaved edits survive. */
.gpanel-hide{display:none !important}
.gpanel-chat{padding:0;display:flex;flex-direction:column;min-height:0}

/* FULL WIDTH once the window is narrow enough that a side drawer is the wrong shape. */
@media (max-width: 759px) {
  .gpanel{width:100vw;right:0 !important}
}
/* THE EDITOR IS A BOTTOM SHEET ON A PHONE, not a 600px side drawer on a 390px screen. Full height,
   every field kept including the highlighted minimum, and the footer pinned so Save and Cancel are
   reachable without scrolling past the form. */
@media (max-width: 639.98px) {
  .gpanel{position:fixed;inset:0;left:0;right:0;width:100vw;max-width:100vw;
    border-radius:14px 14px 0 0;display:flex;flex-direction:column;z-index:60}
  .gpanel-body{flex:1 1 auto;min-height:0;overflow:hidden}
  .gpanel-bar{flex:0 0 auto}
  .gpanel-body>.mp>.mp-panel>.mp-fs>.mp-foot{position:sticky;bottom:0;background:#fff;
    border-top:1px solid #DCE5E0;padding-bottom:max(env(safe-area-inset-bottom),10px)}
  .gpanel-tabs button{padding:12px 16px;font-size:14px}
}
`;
