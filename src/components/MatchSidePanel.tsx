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
import MatchPanel from "@/components/MatchPanel";
import ChatPane from "@/app/(internal)/match-ops/match-chats/ChatPane";

export type PanelTab = "details" | "chat";

export default function MatchSidePanel({
  matchId, tab, onTab, onClose, width, right = 0, className = "", notice, steps, onDirtyChange,
}: {
  /** The match api id. It is ALSO the chat id — proven, and no second lookup. */
  matchId: number;
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
        <MatchPanel key={matchId} matchId={String(matchId)} onDirtyChange={onDirtyChange} />
      </div>
      {/* CHAT RESOLVES THE THREAD THE WAY IT WAS PROVEN TO RESOLVE: chatId is the match api_id. */}
      <div className={"gpanel-body gpanel-chat" + (tab === "chat" ? "" : " gpanel-hide")}
        data-testid="gday-panel-chat" aria-hidden={tab !== "chat"} data-chat-id={String(matchId)}>
        <ChatPane chatId={String(matchId)} showOnMobile={false} embedded onBack={() => onTab("details")} />
      </div>
    </aside>
  );
}

/** Used by any host page that is not `.gdo` and therefore does not inherit Gameday's panel rules. */
export const MATCH_SIDE_PANEL_CSS = `
.gpanel{position:fixed;top:0;bottom:0;height:100dvh;width:min(var(--panel-w,600px),96vw);max-width:100vw;background:#eef2f0;border-left:1px solid #d4e0da;box-shadow:-8px 0 26px rgba(4,26,18,.12);z-index:60;display:flex;flex-direction:column}
.gpanel-bar{display:flex;align-items:center;gap:8px;padding:9px 12px;background:#04291d;color:#fff;flex:0 0 auto}
.gpanel-x{border:1px solid #2a5644;background:transparent;color:#cfe7dc;border-radius:8px;padding:7px 13px;font:inherit;font-size:12.5px;font-weight:600;cursor:pointer}
.gpanel-x:hover{background:#14432f;color:#fff}
.gpanel-step{margin-left:auto;display:inline-flex;gap:5px}
.gpanel-tabs{display:flex;gap:2px;padding:0 12px;border-bottom:1px solid #DCE5E0;flex:0 0 auto;background:#fff}
.gpanel-tabs button{border:0;background:none;font:inherit;font-size:12.5px;font-weight:700;padding:10px 12px;color:#5C7368;border-bottom:2px solid transparent;cursor:pointer}
.gpanel-tabs button:hover{color:#1B3227}
.gpanel-tabs button.on{color:#046B45;border-bottom-color:#046B45}
.gpanel-body{flex:1;min-height:0;overflow:hidden;padding:12px;display:flex;flex-direction:column}
.gpanel-hide{display:none !important}
.gpanel-chat{padding:0;display:flex;flex-direction:column;min-height:0}
`;
