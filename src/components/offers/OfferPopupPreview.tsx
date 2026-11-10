"use client";

// THE POPUP AS A PLAYER SEES IT (Figma 20825:102 at full size, 320 wide; the border from section 14 · Targeted Offer Popup,
// 20568:20243: 3px #2CDB87 inside the edge, radius 15, photo clipped by the card). It draws exactly what the app's
// OfferPopup.tsx draws (frontend feature/offers): photo with the eyebrow pill, headline with its last
// word in green italic, the spaced line, the body, the dashed ticket (end time, Auto-applied), the
// button (upper-cased by the app) and the dismiss link, with the caption on the photo. {firstName}
// shows as "Luis"; the backend fills in each player's own. No photoUrl: the app's own bundled offer-popup-photo.jpg (frontend feature/offers), copied here.
//
// `width` sets the size; every measure is the half-size mock (156 wide) scaled, so 320 is the mock's full size to the pixel.

import Image from "next/image";
import { Heebo, Titillium_Web } from "next/font/google";
import { withPreviewName, type Copy } from "@/lib/offersModel";
import { HEADLINE_PAD, POPUP_HEADLINE_SIZE, headlineLineHeight, popupHeadlineFit, popupHeadlineParts } from "@/lib/headlineFit";

const titillium = Titillium_Web({ subsets: ["latin"], weight: ["700"], style: ["normal", "italic"], display: "swap" });
const heebo = Heebo({ subsets: ["latin"], weight: ["400", "500", "700"], display: "swap" });

export const POPUP_BASE_WIDTH = 156;

// announcement (Figma 20892:20143, backend announcements.md): a popup with no discount. Its headline is the plain part
// plus an accent as typed (no accent: the last word, as before), and its ticket is only the match's kickoff, centred,
// with no "Auto-applied". Left out for an offer with a deal, which draws exactly as it always has.
export type AnnouncementLook = { accent: string | null; ticket: string | null };
export default function OfferPopupPreview({ copy: raw, ends, showTicket, width = POPUP_BASE_WIDTH, announcement }: { copy: Copy; ends: string | null; showTicket: boolean; width?: number; announcement?: AnnouncementLook }) {
  const copy = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, k === "photoUrl" ? v : withPreviewName(v as string | null)])) as Copy;
  const { lead, accent } = popupHeadlineParts(raw.headline, announcement?.accent, !!announcement);
  // THE APP'S AUTO-FIT (lib/headlineFit): 48pt on one line when it fits, smaller down to 28pt, then two lines at 28pt. In
  // the half-size mock's units a point is 0.5, so 48pt is the 24 the short headline has always drawn at.
  const fit = popupHeadlineFit(lead, accent);
  const lineHeight = headlineLineHeight(fit.size, POPUP_HEADLINE_SIZE);
  const wrapped = fit.lines.length > 1;
  const s = width / POPUP_BASE_WIDTH;
  const px = (n: number) => `${Math.round(n * s * 100) / 100}px`;
  return (
    <div data-testid="offers-popup-preview" className="flex shrink-0 flex-col overflow-hidden border-solid"
      style={{ width: px(156), background: "#f4eee1", borderColor: "#2cdb87", borderWidth: px(1.5), borderRadius: px(7.5), boxShadow: s > 1 ? `0 ${px(6)} ${px(16)} rgba(0,51,38,0.35)` : undefined }}>
      <div className="relative w-full shrink-0 overflow-hidden" style={{ height: px(84) }}>
        {copy.photoUrl
          // eslint-disable-next-line @next/next/no-img-element
          ? <img alt="" src={copy.photoUrl} className="absolute inset-0 size-full object-cover" />
          : <Image alt="" src="/offers/offer-popup-photo.jpg" fill sizes={`${Math.round(width)}px`} className="object-cover" />}
        <div className="absolute inset-0" style={{ background: "linear-gradient(180deg, rgba(0,51,38,0) 30%, rgba(0,51,38,0.85) 100%)" }} />
        {copy.caption ? (
          <p data-testid="offers-preview-caption" className={`${heebo.className} absolute font-bold text-white`} style={{ bottom: px(8), left: px(8), right: px(8), fontSize: px(7.5), lineHeight: px(9.5) }}>{copy.caption}</p>
        ) : null}
        {copy.eyebrow ? (
          <div className="absolute rounded-full" style={{ left: px(7), top: px(7), padding: `${px(2.5)} ${px(5)}`, background: "#003326" }}>
            <p className={`${titillium.className} whitespace-nowrap font-bold`} style={{ color: "#2cdb87", fontSize: px(6), letterSpacing: px(0.75) }}>{copy.eyebrow}</p>
          </div>
        ) : null}
      </div>
      <div className="flex w-full flex-col items-center" style={{ gap: px(7), padding: `${px(9)} ${px(10)}` }}>
        <div className="flex flex-col items-center" style={wrapped ? { alignSelf: "stretch", marginLeft: px(-HEADLINE_PAD / 2), marginRight: px(-HEADLINE_PAD / 2) } : undefined}>
          {fit.lines.map((l, i) => (
            // Wrapped (the app's 815ede42): each line may spill the 8pt of its blank padding into the card's own, and a word
            // wider than that ends in "…".
            <p key={i} data-testid="offers-preview-headline" data-size={fit.size} data-lines={fit.lines.length} data-line-height={lineHeight}
              className={`${titillium.className} whitespace-nowrap font-bold uppercase ${wrapped ? "max-w-full overflow-hidden text-ellipsis" : ""}`}
              style={{ color: "#0b4031", fontSize: px(fit.size / 2), lineHeight: px(lineHeight / 2) }}>
              {l.lead}{l.lead && l.accent ? " " : ""}{l.accent ? <span className="italic" style={{ color: "#2cdb87" }}>{l.accent}</span> : null}
            </p>
          ))}
          {copy.line ? <p className={`${titillium.className} text-center font-bold`} style={{ color: "#5d7a6f", fontSize: px(8), letterSpacing: px(1.25) }}>{copy.line}</p> : null}
        </div>
        {copy.body ? <p className={`${heebo.className} w-full text-center`} style={{ color: "#637973", fontSize: px(7.5), lineHeight: px(10.5) }}>{copy.body}</p> : null}
        {announcement ? (announcement.ticket ? (
          <div data-testid="offers-preview-ticket" data-kind="announcement" className="flex w-full items-center justify-center border-dashed bg-white"
            style={{ borderColor: "#bac7c3", borderWidth: px(0.5), borderRadius: px(5), padding: `${px(5.5)} ${px(6)}` }}>
            <div className="flex items-center" style={{ gap: px(2.5) }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img alt="" src="/offers/icon-clock.svg" className="block" style={{ width: px(7), height: px(7) }} />
              <p className={`${heebo.className} whitespace-nowrap font-medium`} style={{ color: "#0b4031", fontSize: px(6.5) }}>{announcement.ticket}</p>
            </div>
          </div>
        ) : null) : showTicket && (
          <div data-testid="offers-preview-ticket" className={`flex w-full items-center border-dashed bg-white ${ends ? "justify-between" : "justify-center"}`}
            style={{ borderColor: "#bac7c3", borderWidth: px(0.5), borderRadius: px(5), padding: `${px(5.5)} ${px(6)}` }}>
            {ends ? (
              <div className="flex items-center" style={{ gap: px(2.5) }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img alt="" src="/offers/icon-clock.svg" className="block" style={{ width: px(7), height: px(7) }} />
                <p className={`${heebo.className} whitespace-nowrap font-medium`} style={{ color: "#0b4031", fontSize: px(6.5) }}>{ends}</p>
              </div>
            ) : null}
            <div className="flex items-center" style={{ gap: px(3) }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img alt="" src="/offers/icon-tag.svg" className="block" style={{ width: px(8), height: px(8) }} />
              <p className={`${heebo.className} whitespace-nowrap font-medium`} style={{ color: "#1fa866", fontSize: px(6.5) }}>Auto-applied</p>
            </div>
          </div>
        )}
        <div className="flex w-full flex-col items-center" style={{ gap: px(6) }}>
          <div className="flex w-full items-center justify-center" style={{ height: px(26), borderRadius: px(5), background: "#2cdb87" }}>
            <p className={`${titillium.className} whitespace-nowrap font-bold uppercase`} style={{ color: "#003326", fontSize: px(9) }}>{copy.buttonLabel}</p>
          </div>
          <p className={`${heebo.className} whitespace-nowrap underline`} style={{ color: "#637973", fontSize: px(8) }}>{copy.dismissLabel || "Not now"}</p>
        </div>
      </div>
    </div>
  );
}
