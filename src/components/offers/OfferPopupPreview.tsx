"use client";

// THE POPUP AS A PLAYER SEES IT, at half size (Figma 20571:400). It draws exactly what the app's
// OfferPopup.tsx draws (frontend feature/offers): photo with the eyebrow pill, headline with its last
// word in green italic, the spaced line, the body, the dashed ticket (end time, Auto-applied), the
// button (upper-cased by the app) and the dismiss link, with the caption on the photo. {firstName}
// shows as "Luis"; the backend fills in each player's own. No photoUrl: the app's own bundled offer-popup-photo.jpg (frontend feature/offers), copied here.

import Image from "next/image";
import { Heebo, Titillium_Web } from "next/font/google";
import { withPreviewName, type Copy } from "@/lib/offersModel";

const titillium = Titillium_Web({ subsets: ["latin"], weight: ["700"], style: ["normal", "italic"], display: "swap" });
const heebo = Heebo({ subsets: ["latin"], weight: ["400", "500", "700"], display: "swap" });

// The app's split: the headline's last word is the italic green one ("50% *OFF*").
function splitHeadline(headline: string) {
  const words = headline.trim().split(/\s+/);
  if (words.length < 2) return { lead: words[0] ?? "", accent: "" };
  return { lead: words.slice(0, -1).join(" "), accent: words[words.length - 1] };
}

export default function OfferPopupPreview({ copy: raw, ends, showTicket }: { copy: Copy; ends: string | null; showTicket: boolean }) {
  const copy = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, k === "photoUrl" ? v : withPreviewName(v as string | null)])) as Copy;
  const { lead, accent } = splitHeadline(copy.headline);
  return (
    <div data-testid="offers-popup-preview" className="flex w-[156px] shrink-0 flex-col overflow-hidden rounded-[7.5px]" style={{ background: "#f4eee1" }}>
      <div className="relative h-[84px] w-[156px] shrink-0 overflow-hidden">
        {copy.photoUrl
          // eslint-disable-next-line @next/next/no-img-element
          ? <img alt="" src={copy.photoUrl} className="absolute inset-0 size-full object-cover" />
          : <Image alt="" src="/offers/offer-popup-photo.jpg" fill sizes="156px" className="object-cover" />}
        <div className="absolute inset-0" style={{ background: "linear-gradient(180deg, rgba(0,51,38,0) 30%, rgba(0,51,38,0.85) 100%)" }} />
        {copy.caption ? (
          <p data-testid="offers-preview-caption" className={`${heebo.className} absolute bottom-[8px] left-[8px] right-[8px] text-[7.5px] font-bold leading-[9.5px] text-white`}>{copy.caption}</p>
        ) : null}
        {copy.eyebrow ? (
          <div className="absolute left-[7px] top-[7px] rounded-full px-[5px] py-[2.5px]" style={{ background: "#003326" }}>
            <p className={`${titillium.className} whitespace-nowrap text-[6px] font-bold tracking-[0.75px]`} style={{ color: "#2cdb87" }}>{copy.eyebrow}</p>
          </div>
        ) : null}
      </div>
      <div className="flex w-full flex-col items-center gap-[7px] px-[10px] py-[9px]">
        <div className="flex flex-col items-center">
          <p data-testid="offers-preview-headline" className={`${titillium.className} whitespace-nowrap text-[24px] font-bold leading-[26px]`} style={{ color: "#0b4031" }}>
            {lead}{accent ? " " : ""}{accent ? <span className="italic" style={{ color: "#1fa866" }}>{accent}</span> : null}
          </p>
          {copy.line ? <p className={`${titillium.className} text-center text-[8px] font-bold tracking-[1.25px]`} style={{ color: "#5d7a6f" }}>{copy.line}</p> : null}
        </div>
        {copy.body ? <p className={`${heebo.className} w-[136px] text-center text-[7.5px] leading-[10.5px]`} style={{ color: "#637973" }}>{copy.body}</p> : null}
        {showTicket && (
          <div data-testid="offers-preview-ticket" className={`flex w-full items-center rounded-[5px] border-[0.5px] border-dashed bg-white px-[6px] py-[5.5px] ${ends ? "justify-between" : "justify-center"}`} style={{ borderColor: "#bac7c3" }}>
            {ends ? (
              <div className="flex items-center gap-[2.5px]">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img alt="" src="/offers/icon-clock.svg" width={7} height={7} className="block" />
                <p className={`${heebo.className} whitespace-nowrap text-[6.5px] font-medium`} style={{ color: "#0b4031" }}>{ends}</p>
              </div>
            ) : null}
            <div className="flex items-center gap-[3px]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img alt="" src="/offers/icon-tag.svg" width={8} height={8} className="block" />
              <p className={`${heebo.className} whitespace-nowrap text-[6.5px] font-medium`} style={{ color: "#1fa866" }}>Auto-applied</p>
            </div>
          </div>
        )}
        <div className="flex w-full flex-col items-center gap-[6px]">
          <div className="flex h-[26px] w-full items-center justify-center rounded-[5px]" style={{ background: "#2cdb87" }}>
            <p className={`${titillium.className} whitespace-nowrap text-[9px] font-bold uppercase`} style={{ color: "#003326" }}>{copy.buttonLabel}</p>
          </div>
          <p className={`${heebo.className} whitespace-nowrap text-[8px] underline`} style={{ color: "#637973" }}>{copy.dismissLabel || "Not now"}</p>
        </div>
      </div>
    </div>
  );
}
