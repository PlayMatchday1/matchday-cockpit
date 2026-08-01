"use client";

// Mobile-only section navigation for the Match Ops chat consoles (mockup
// matchops-mobile-v1). On a phone the desktop icon rail (ChatsRail) is
// `hidden lg:block`, so from inside a chat console every other section page —
// Master Schedule, Field Pipeline, Field Ops, Review, the other chat — was
// UNREACHABLE (the bottom tab bar was the only working nav). This restores it.
//
// Two routes to the same set (S1): a horizontally-scrollable sticky pill strip,
// and a bottom "Sections" sheet (name + one-line description) opened by the
// leading button — because a pill strip alone truncates long names.
//
// Rendered only below 900px (`min-[900px]:hidden`); desktop is untouched. On
// load the strip does NOT auto-centre the active pill (that truncates the first
// label to "r Schedule"); it scrolls only if the active pill is off-screen, by
// the minimum amount.

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { canAccess, useAuth } from "@/lib/useAuth";
import { useCrmAwaitingCount } from "@/lib/useCrmAwaitingCount";

type Section = {
  href: string;
  name: string;
  desc: string;
  access: "cities" | "clubhouse" | "chats" | "admin";
  icon: React.ReactNode;
};

function I({ children }: { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  );
}

const SECTIONS: Section[] = [
  { href: "/match-ops/master-schedule", name: "Master Schedule", desc: "Recurring weekly slots, by city", access: "cities", icon: <I><rect x="3" y="5" width="18" height="16" rx="3.2" /><path d="M3 9.6h18M8 3v3.6M16 3v3.6" /></I> },
  { href: "/match-ops/match-chats", name: "Match Chats", desc: "One WhatsApp group per match", access: "chats", icon: <I><path d="M21 12a8 8 0 0 1-11.6 7.1L4 21l1.9-5.4A8 8 0 1 1 21 12z" /></I> },
  { href: "/match-ops/player-chats", name: "Player Chats", desc: "1:1 threads with players", access: "chats", icon: <I><circle cx="12" cy="8" r="3.4" /><path d="M4.8 20a7.2 7.2 0 0 1 14.4 0" /></I> },
  { href: "/match-ops/field-pipeline", name: "Field Pipeline", desc: "Venues we're still chasing", access: "clubhouse", icon: <I><path d="M3.5 5h17l-6.6 7.7V19l-3.8 2v-8.3z" /></I> },
  { href: "/match-ops/field-ops", name: "Field Ops", desc: "Tonight's fields and staff", access: "cities", icon: <I><path d="M12 21.5s7-6.6 7-11.5a7 7 0 1 0-14 0c0 4.9 7 11.5 7 11.5z" /><circle cx="12" cy="10" r="2.5" /></I> },
  { href: "/match-ops/review", name: "Review", desc: "Slots waiting on a decision", access: "admin", icon: <I><path d="M5.5 21.5V3.5M5.5 4.5h12l-1.8 3.9 1.8 3.9h-12" /></I> },
];

export default function MatchOpsMobileStrip() {
  const { appUser } = useAuth();
  const pathname = usePathname() ?? "";
  const router = useRouter();
  const awaiting = useCrmAwaitingCount();
  const [sheetOpen, setSheetOpen] = useState(false);
  const scRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);

  const items = useMemo(
    () =>
      SECTIONS.filter((s) =>
        s.access === "admin" ? !!appUser?.is_admin : canAccess(appUser, s.access),
      ),
    [appUser],
  );

  const isActive = (href: string) => pathname === href || pathname.startsWith(href + "/");
  const countFor = (href: string) =>
    href === "/match-ops/player-chats" && awaiting > 0 ? awaiting : null;

  // Minimal-scroll: only if the active pill is off-screen, and by the least
  // amount. Never auto-centre (that truncates the first label on first paint).
  useEffect(() => {
    const sc = scRef.current;
    const pill = activeRef.current;
    if (!sc || !pill) return;
    const left = pill.offsetLeft;
    const right = left + pill.offsetWidth;
    if (left < sc.scrollLeft) sc.scrollLeft = Math.max(0, left - 16);
    else if (right > sc.scrollLeft + sc.clientWidth) sc.scrollLeft = right - sc.clientWidth + 16;
  }, [pathname, items.length]);

  const nav = (href: string) => {
    setSheetOpen(false);
    if (!isActive(href)) router.push(href);
  };

  return (
    <div className="min-[900px]:hidden">
      {/* sticky pill strip — pays var(--sat) so the pills sit BELOW the iOS
          status band, where taps actually reach the page (M4). */}
      <div
        className="sticky top-0 z-[12] flex items-center gap-2 border-b px-3 pb-2"
        style={{ background: "#f8faf9", borderColor: "#e6ebe8", paddingTop: "calc(8px + var(--sat))" }}
      >
        <button
          type="button"
          onClick={() => setSheetOpen(true)}
          aria-label="All Match Ops sections"
          className="flex h-9 w-9 flex-none items-center justify-center rounded-full"
          style={{ color: "#42594e", background: "#eef3f0" }}
        >
          <I><path d="M4 6h16M4 12h16M4 18h16" /></I>
        </button>
        <div ref={scRef} className="flex flex-1 gap-[7px] overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {items.map((s) => {
            const on = isActive(s.href);
            const n = countFor(s.href);
            return (
              <button
                key={s.href}
                ref={on ? activeRef : undefined}
                type="button"
                onClick={() => nav(s.href)}
                className="flex h-9 flex-none items-center gap-1.5 rounded-full border px-[13px] text-[13.5px] font-[640] whitespace-nowrap"
                style={on ? { background: "#0d3b2e", borderColor: "#0d3b2e", color: "#fff", fontWeight: 700 } : { background: "#ffffff", borderColor: "#e2eae5", color: "#42594e" }}
              >
                {s.name}
                {n != null && (
                  <span className="rounded-full px-1.5 text-[11.5px] font-[750]" style={on ? { background: "rgba(255,255,255,.17)", color: "#bfe9d3" } : { background: "rgba(0,0,0,.05)", color: "#8d9c94" }}>
                    {n}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* section sheet */}
      {sheetOpen && (
        <div className="fixed inset-0 z-[60] flex flex-col justify-end" role="dialog" aria-modal="true" aria-label="Match Ops sections">
          {/* Scrim starts below the status band so no tappable dismiss layer
              sits under the OS-owned strip (M4 / hit-test rule). */}
          <button type="button" aria-label="Close" onClick={() => setSheetOpen(false)} className="absolute inset-x-0 bottom-0" style={{ top: "var(--sat)", background: "rgba(6,26,18,.42)" }} />
          <div className="relative max-h-[86%] overflow-y-auto rounded-t-[22px]" style={{ background: "#ffffff", boxShadow: "0 -2px 8px rgba(7,42,32,.06), 0 -26px 60px -20px rgba(7,42,32,.42)", paddingBottom: "calc(14px + var(--sab))" }}>
            <div className="flex justify-center pb-1 pt-2"><span className="h-[5px] w-[38px] rounded-full" style={{ background: "#dbe3df" }} /></div>
            <div className="flex items-center gap-2.5 px-[18px] pb-2.5 pt-1.5">
              <h2 className="text-[17px] font-[760] tracking-[-0.02em]" style={{ color: "#12241d" }}>Match Ops</h2>
              <button type="button" onClick={() => setSheetOpen(false)} aria-label="Close" className="ml-auto flex h-9 w-9 items-center justify-center rounded-full" style={{ color: "#42594e" }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.1} strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
            </div>
            <div className="px-2.5">
              {items.map((s) => {
                const on = isActive(s.href);
                const n = countFor(s.href);
                return (
                  <button
                    key={s.href}
                    type="button"
                    onClick={() => nav(s.href)}
                    className="flex min-h-[56px] w-full items-center gap-3 rounded-[14px] px-3 py-[11px] text-left"
                    style={on ? { background: "#e0f2e7" } : undefined}
                  >
                    <span className="flex h-9 w-9 flex-none items-center justify-center rounded-[12px] border [&_svg]:h-[18px] [&_svg]:w-[18px]" style={on ? { background: "#fff", borderColor: "#c9e8d8", color: "#12704a" } : { background: "#eef3f0", borderColor: "#e2eae5", color: "#4d6359" }}>
                      {s.icon}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15.5px] font-[650] tracking-[-0.012em]" style={{ color: on ? "#0f3d2e" : "#12241d", fontWeight: on ? 760 : 650 }}>{s.name}</span>
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
      )}
    </div>
  );
}
