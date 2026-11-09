"use client";

// THE PREVIEW COLUMN (Figma 20825:87; the Push tab is 20826:121): LIVE PREVIEW · Pinned while you scroll, the Popup /
// Push tabs, a real-size phone, and the line under it saying where the button goes. Pinned by the panel (sticky
// above 1100px wide; on top of the form below that). Every edit in the form redraws it at once: it draws from the
// same copy and push text the form holds.

import { useEffect, useRef, useState } from "react";
import type { Copy } from "@/lib/offersModel";
import OfferPopupPreview, { type AnnouncementLook } from "./OfferPopupPreview";
import { PushLockScreen } from "./OfferPush";
import { O } from "./offersUi";

export type PreviewTab = "popup" | "push";
const POPUP_FULL = 320;
const POPUP_INSET = 18;

export default function OfferPreview({ tab, setTab, copy, ends, showTicket, opens, push, dateLine, popupOff = false, announcement }: {
  tab: PreviewTab; setTab: (t: PreviewTab) => void; copy: Copy; ends: string | null; showTicket: boolean;
  // A popup with no discount draws its own headline accent and match ticket (OfferPopupPreview).
  announcement?: AnnouncementLook;
  // Push only: the Popup tab is greyed (there is no popup to show) and the Push tab is the one drawn.
  popupOff?: boolean;
  // "↳ Opens Find a match" (offersModel opensText): the popup's button and the push's tap go to the same place.
  opens: string;
  // The push as the phone shows it, or null when this offer sends none (or pushes aren't shown to this account).
  push: { title: string; body: string } | null; dateLine: string;
}) {
  const [screen, width] = useWidth<HTMLDivElement>();
  const popupWidth = Math.max(200, Math.min(POPUP_FULL, width - POPUP_INSET * 2));
  const opensWhat = opens.replace(/^↳ Opens /, "");
  return (
    <div data-testid="offers-preview" data-tab={tab} className="flex flex-col items-center gap-3.5">
      <div className="flex w-full items-center gap-2">
        <span className="text-[11px] font-bold tracking-[0.5px]" style={{ color: O.muted }}>LIVE PREVIEW</span>
        <span className="rounded-full px-2 py-[3px] text-[11px] font-semibold" style={{ background: O.mint, color: O.chipOn }}>Pinned while you scroll</span>
      </div>
      <div className="flex gap-1 rounded-full border p-1" style={{ background: O.surface, borderColor: O.line }}>
        {(["popup", "push"] as const).map((t) => (
          <button key={t} type="button" data-testid={`offers-preview-${t}`} data-on={tab === t ? "1" : "0"} onClick={() => setTab(t)}
            disabled={t === "popup" && popupOff} title={t === "popup" && popupOff ? "The popup is off for this offer" : undefined}
            className={`rounded-full px-4 py-[7px] text-[13px] disabled:cursor-not-allowed disabled:opacity-40 ${tab === t ? "font-semibold" : "font-medium"}`}
            style={tab === t ? { background: O.chipOn, color: "#fff" } : { color: O.muted }}>{t === "popup" ? "Popup" : "Push"}</button>
        ))}
      </div>
      {/* The phone: 380 × 780 in the mock. Shorter on a short window so the whole thing stays pinned in view. */}
      <div data-testid="offers-phone" className="w-full max-w-[380px] rounded-[54px] p-3" style={{ background: "#141717", height: "min(780px, max(560px, calc(100dvh - 230px)))" }}>
        <div ref={screen} className="relative flex h-full w-full items-center justify-center overflow-hidden rounded-[44px]" style={{ background: "#f5f2eb" }}>
          {tab === "popup" ? (
            <>
              <div className="absolute inset-0" style={{ background: "rgba(0,0,0,0.45)" }} />
              <div className="relative">
                <OfferPopupPreview copy={copy} ends={ends} showTicket={showTicket} width={popupWidth} announcement={announcement} />
              </div>
            </>
          ) : push ? (
            <PushLockScreen title={push.title} body={push.body} photoUrl={copy.photoUrl} dateLine={dateLine} />
          ) : (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img alt="" src={copy.photoUrl ?? "/offers/offer-popup-photo.jpg"} className="absolute inset-0 size-full object-cover" />
              <div className="absolute inset-0" style={{ background: "rgba(0,0,0,0.55)" }} />
              <div data-testid="offers-preview-no-push" className="relative rounded-full px-4 py-2 text-[13px] font-semibold" style={{ background: "rgba(245,245,245,0.92)", color: O.ink }}>No push for this offer</div>
            </>
          )}
        </div>
      </div>
      <div data-testid="offers-opens" className="text-center text-[12px] font-medium" style={{ color: O.muted }}>
        {tab === "popup" ? `↳ Button opens ${opensWhat}` : push ? `↳ Tapping opens ${opensWhat}${announcement ? "" : " with the offer applied"}` : "Turn on Also send as a push to see it here"}
      </div>
    </div>
  );
}

// The screen's width, so the popup draws at the mock's 320 when it fits and narrower on a phone.
function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(356);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => { const cw = entries[0]?.contentRect.width; if (cw) setW(cw); });
    ro.observe(el);
    setW(el.clientWidth || 356);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}
