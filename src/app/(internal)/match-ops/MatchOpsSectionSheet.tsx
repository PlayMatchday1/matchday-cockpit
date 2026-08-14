"use client";

// The Match Ops screen picker, as a bottom sheet. On a phone, Gameday Ops replaces
// the horizontal tab scroller (the since-deleted MatchOpsMobileStrip) with a title BUTTON that opens
// this — eleven destinations is a list you read, not a strip you hunt in. Self-
// contained: it owns the shared badge-count hooks and the section list, so a caller
// only toggles `open`. The current screen is marked from the pathname (aria-current).
//
// Same visual language as that strip's sheet (safe-area padding, scrim below
// the OS status band) so the two nav surfaces feel identical; this one is used by the
// Gameday board, that one by every other Match Ops route.

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo } from "react";
import { useAuth } from "@/lib/useAuth";
import { useCrmAwaitingCount } from "@/lib/useCrmAwaitingCount";
import { useManagerPayAttnCount } from "@/lib/useManagerPayAttnCount";
import { usePartnerDashboardsCount } from "@/lib/usePartnerDashboardsCount";
import { visibleSections, tabForPath } from "./sections";
import SectionSwitch from "./SectionSwitch";

export default function MatchOpsSectionSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { appUser } = useAuth();
  const pathname = usePathname() ?? "";
  const router = useRouter();
  const awaiting = useCrmAwaitingCount();
  const managerPayAttn = useManagerPayAttnCount();
  const partnerCount = usePartnerDashboardsCount();

  // Phase 24 — only the CURRENT tab's items. The tab is derived from the route; there is no
  // tab state to fall out of sync with where the operator actually is.
  const items = useMemo(() => visibleSections(appUser, tabForPath(pathname)), [appUser, pathname]);
  const isActive = (href: string) => pathname === href || pathname.startsWith(href + "/");
  const countFor = (badge?: "awaiting" | "manager-pay" | "partner-dashboards") => {
    const n = badge === "awaiting" ? awaiting : badge === "manager-pay" ? managerPayAttn : badge === "partner-dashboards" ? partnerCount : 0;
    return n > 0 ? n : null;
  };
  const nav = (href: string) => { onClose(); if (!isActive(href)) router.push(href); };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex flex-col justify-end" role="dialog" aria-modal="true" aria-label="Go to Match Ops screen" data-testid="screen-sheet">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-x-0 bottom-0" style={{ top: "var(--sat)", background: "rgba(6,26,18,.42)" }} />
      <div className="relative max-h-[86%] overflow-y-auto rounded-t-[22px]" style={{ background: "#ffffff", boxShadow: "0 -2px 8px rgba(7,42,32,.06), 0 -26px 60px -20px rgba(7,42,32,.42)", paddingBottom: "calc(14px + var(--sab))" }}>
        <div className="flex justify-center pb-1 pt-2"><span className="h-[5px] w-[38px] rounded-full" style={{ background: "#dbe3df" }} /></div>
        <div className="flex items-center gap-2.5 px-[18px] pb-2.5 pt-1.5">
          <h2 className="text-[17px] font-[760] tracking-[-0.02em]" style={{ color: "#12241d" }}>Match Ops</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="ml-auto flex h-9 w-9 items-center justify-center rounded-full" style={{ color: "#42594e" }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.1} strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>
        <div className="px-2.5">
          <SectionSwitch />
          {items.map((s) => {
            const on = isActive(s.href);
            const n = countFor(s.badge);
            return (
              <button
                key={s.href}
                type="button"
                onClick={() => nav(s.href)}
                data-testid={`screen-dest-${s.key}`}
                aria-current={on ? "page" : undefined}
                className="flex min-h-[56px] w-full items-center gap-3 rounded-[14px] px-3 py-[11px] text-left"
                style={on ? { background: "#e0f2e7" } : undefined}
              >
                <span className="flex h-9 w-9 flex-none items-center justify-center rounded-[12px] border [&_svg]:h-[18px] [&_svg]:w-[18px]" style={on ? { background: "#fff", borderColor: "#c9e8d8", color: "#12704a" } : { background: "#eef3f0", borderColor: "#e2eae5", color: "#4d6359" }}>
                  {s.icon}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15.5px] font-[650] tracking-[-0.012em]" style={{ color: on ? "#0f3d2e" : "#12241d", fontWeight: on ? 760 : 650 }}>{s.label}</span>
                  <span className="block truncate text-[12.5px] font-[540]" style={{ color: "#6d7b74" }}>{s.desc}</span>
                </span>
                {n != null && (
                  <span className="flex-none rounded-full px-[9px] py-0.5 text-[12.5px] font-[730]" style={on ? { background: "#fff", color: "#12704a" } : { background: "rgba(0,0,0,.05)", color: "#8d9c94" }}>{n}</span>
                )}
                {on && (
                  <svg viewBox="0 0 24 24" className="h-5 w-5 flex-none" fill="none" stroke="#12764c" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 12.5l4.5 4.5L19 7" /></svg>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
