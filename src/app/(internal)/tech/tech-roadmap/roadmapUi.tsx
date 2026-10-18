"use client";

// Shared look for Tech Roadmap 2.0 (Figma "Clubhouse · Tech Roadmap 2.0"): the palette and the
// chips the board, the releases tab and the work panel all draw.

import type { KanbanCard, RoadmapAssignee } from "@/lib/kanban";
import { ASSIGNEE_LABEL, type ReleaseStatus } from "@/lib/roadmapReleases";

export const C = {
  ink: "#0b2e22", muted: "#5d7a6f", faint: "#7d948a", forest: "#063d2c", accent: "#2cdb87",
  mint: "#e2f7ec", link: "#288c5f", line: "#e0e0db", column: "#eaede8", soft: "#f3f4f0",
  softer: "#f7f8f5", grey: "#eeefec", white: "#ffffff", danger: "#b4342c",
  blueBg: "#e6f4ff", blueInk: "#1f5f99", amberBg: "#fff4cf", amberInk: "#8a6a12",
  planBg: "#d6e8de", planLine: "#aac8b9", today: "#d64541",
  // Ready for release: violet, so it reads apart from amber (Working on it) and green (Done).
  ready: "#8b5cf6", readyBg: "#efe9fe", readyInk: "#5b3fb3",
};

export const PRIORITY_COLOR: Record<string, string> = { High: "#d64541", Medium: "#e8aa28", Low: "#aabeb4" };

export const STAGE_LABEL: Record<string, string> = {
  ideas: "Ideas", in_plan: "Up next", in_progress: "Working on it", ready: "Ready for release", shipped: "Done",
};

export function VersionChip({ v, size = "sm" }: { v: string; size?: "sm" | "md" }) {
  return (
    <span data-testid="version-chip" className={`inline-flex flex-none items-center rounded-[6px] font-semibold text-white ${size === "md" ? "px-2 py-1 text-[12px]" : "px-1.5 py-[2px] text-[11px]"}`}
      style={{ background: C.forest }}>{v}</span>
  );
}

export function Pill({ children, bg, ink, testid }: { children: React.ReactNode; bg: string; ink: string; testid?: string }) {
  return (
    <span data-testid={testid} className="inline-flex flex-none items-center whitespace-nowrap rounded-full px-[9px] py-[3px] text-[11px] font-semibold"
      style={{ background: bg, color: ink }}>{children}</span>
  );
}

export function WhoChip({ who }: { who: RoadmapAssignee | null | undefined }) {
  if (who === "ryan") return <Pill testid="who-chip" bg={C.mint} ink={C.forest}>{ASSIGNEE_LABEL.ryan}</Pill>;
  if (who === "scrumlaunch") return <Pill testid="who-chip" bg={C.blueBg} ink={C.blueInk}>{ASSIGNEE_LABEL.scrumlaunch}</Pill>;
  return <Pill testid="who-chip" bg={C.grey} ink={C.muted}>No one yet</Pill>;
}

export function StageChip({ stage }: { stage: string }) {
  if (stage === "in_progress") return <Pill testid="stage-chip" bg={C.amberBg} ink={C.amberInk}>Working on it</Pill>;
  if (stage === "ready") return <Pill testid="stage-chip" bg={C.readyBg} ink={C.readyInk}>Ready for release</Pill>;
  if (stage === "shipped") return <Pill testid="stage-chip" bg={C.mint} ink={C.forest}>Done</Pill>;
  return <Pill testid="stage-chip" bg={C.grey} ink={C.muted}>{STAGE_LABEL[stage] ?? stage}</Pill>;
}

export function ReleaseStatusChip({ status }: { status: ReleaseStatus }) {
  const s = status === "building" ? { bg: C.accent, ink: C.forest, t: "Building" }
    : status === "out" ? { bg: C.mint, ink: C.forest, t: "Out" }
    : { bg: C.grey, ink: C.muted, t: "Planned" };
  return <span data-testid="release-status" className="inline-flex flex-none items-center rounded-full px-[10px] py-1 text-[12px] font-semibold" style={{ background: s.bg, color: s.ink }}>{s.t}</span>;
}

/** The dot at the start of a release row: amber for Working on it, violet for Ready for release, a
 *  check for Done, a ring otherwise. */
export function StageDot({ stage }: { stage: string }) {
  const src = stage === "in_progress" ? "/roadmap/status-working.svg" : stage === "ready" ? "/roadmap/status-ready.svg" : stage === "shipped" ? "/roadmap/done-check.svg" : "/roadmap/status-open.svg";
  return <img src={src} alt="" width={14} height={14} className="block flex-none" />;
}

export const priorityOf = (c: KanbanCard): string | null => {
  const p = c.data?.priority;
  return p === "High" || p === "Medium" || p === "Low" ? p : null;
};
export const descriptionOf = (c: KanbanCard): string => (typeof c.data?.description === "string" ? c.data.description : "");
