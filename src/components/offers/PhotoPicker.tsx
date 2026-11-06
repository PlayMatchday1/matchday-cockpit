"use client";

// CHOOSE A PHOTO (Figma 20826:49): the modal behind Change in the Popup card. A search over field and city, chips
// for Suggested, each city and All cities, the tiles (photo, name, city; the picked one in a green border) and
// Upload a photo as the last tile. No photo on the left of the footer is the app's own default; Use photo applies
// the pick. Which photos exist and which are suggested is worked out by the panel (offersModel photoTiles /
// suggestedPhotoTiles); this only shows them. An upload here goes through the panel's own upload and is picked
// as soon as it registers, the same as Upload in the Popup card.

import { useEffect, useMemo, useState } from "react";
import { canHidePhoto, type City, type PhotoTile } from "@/lib/offersModel";
import { Btn, O } from "./offersUi";

type Scope = "suggested" | "all" | number;

export default function PhotoPicker({ tiles, suggested, suggestedLabel, cities, selected, stored, frozen, upload, onHide, onCancel, onUse }: {
  tiles: PhotoTile[]; suggested: PhotoTile[]; suggestedLabel: string; cities: City[]; selected: string | null; stored: string | null; frozen: boolean;
  upload: { pct: number | null; err: string | null; allowed: boolean; onFile: (f: File | undefined) => void };
  onHide: (url: string) => void; onCancel: () => void; onUse: (url: string | null) => void;
}) {
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<Scope>("suggested");
  const [pending, setPending] = useState<string | null>(selected);
  // An upload inside the picker is applied by the panel; follow it so the new tile reads as picked.
  useEffect(() => { setPending(selected); }, [selected]);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onCancel]);
  const cityChips = cities.filter((c) => tiles.some((t) => t.cityId === c.id));
  const needle = q.trim().toLowerCase();
  const shown = useMemo(() => {
    if (needle) return tiles.filter((t) => `${t.title} ${t.sub}`.toLowerCase().includes(needle));
    if (scope === "suggested") return suggested;
    if (scope === "all") return tiles;
    return tiles.filter((t) => t.cityId === scope);
  }, [tiles, suggested, scope, needle]);
  const label = needle ? `Results for “${q.trim()}”` : scope === "suggested" ? suggestedLabel : scope === "all" ? "All cities" : cities.find((c) => c.id === scope)?.name ?? "";
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4 py-6" style={{ background: "rgba(7,42,32,.22)" }} onClick={onCancel}>
      <div role="dialog" aria-modal="true" aria-label="Choose a photo" data-testid="offers-photo-picker" onClick={(e) => e.stopPropagation()}
        className="flex max-h-[88vh] w-full max-w-[860px] flex-col gap-[18px] rounded-[18px] px-5 py-5 shadow-[0_12px_40px_rgba(0,0,0,0.18)] sm:px-7 sm:py-6" style={{ background: O.surface }}>
        <div className="flex items-start gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="text-[20px] font-bold" style={{ color: O.ink }}>Choose a photo</div>
            <div className="text-[13px]" style={{ color: O.muted }}>Shown at the top of the popup. Starts with fields that match this offer.</div>
          </div>
          <button type="button" aria-label="Close" onClick={onCancel} className="text-[18px] leading-none" style={{ color: O.muted }}>✕</button>
        </div>
        <label className="flex items-center gap-2 rounded-[10px] border px-3.5 py-[10px]" style={{ borderColor: O.line }}>
          <span className="text-[15px] font-medium" style={{ color: O.muted }}>⌕</span>
          <input data-testid="offers-photo-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a field or city" aria-label="Search a field or city"
            className="min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-[#7d948a]" style={{ color: O.ink }} />
        </label>
        <div className="flex flex-wrap gap-2">
          <ScopeChip on={!needle && scope === "suggested"} testId="offers-photo-scope-suggested" onClick={() => { setQ(""); setScope("suggested"); }}>Suggested</ScopeChip>
          {cityChips.map((c) => <ScopeChip key={c.id} on={!needle && scope === c.id} testId={`offers-photo-scope-${c.id}`} onClick={() => { setQ(""); setScope(c.id); }}>{c.name}</ScopeChip>)}
          <ScopeChip on={!needle && scope === "all"} testId="offers-photo-scope-all" onClick={() => { setQ(""); setScope("all"); }}>All cities</ScopeChip>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
          <div data-testid="offers-photo-label" className="text-[11px] font-bold uppercase tracking-[0.5px]" style={{ color: O.muted }}>{label}</div>
          {shown.length === 0 && !upload.allowed && <div className="py-6 text-center text-[13px]" style={{ color: O.muted }}>No photos here.</div>}
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-[repeat(auto-fill,minmax(168px,1fr))]">
            {shown.map((t) => {
              const on = pending === t.url;
              const hide = t.kind === "upload" && t.key !== "custom" && !frozen && t.url !== null && canHidePhoto(t.url, stored);
              return (
                <div key={t.key} className="relative flex">
                  <button type="button" data-testid={`offers-photo-${t.key}`} data-on={on ? "1" : "0"} disabled={frozen} onClick={() => setPending(t.url)}
                    className="flex w-full flex-col overflow-hidden rounded-[10px] border-2 text-left disabled:cursor-not-allowed" style={{ borderColor: on ? O.accent : O.line, background: O.surface }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img alt="" src={t.url ?? "/offers/offer-popup-photo.jpg"} className="h-[104px] w-full object-cover" />
                    <span className="flex w-full flex-col gap-0.5 px-2.5 pb-2.5 pt-2">
                      <span className="truncate text-[13px] font-semibold" style={{ color: O.ink }}>{t.title}</span>
                      <span className="truncate text-[12px]" style={{ color: O.muted }}>{t.sub || " "}</span>
                    </span>
                  </button>
                  {hide && (
                    <button type="button" data-testid={`offers-hide-${t.key}`} aria-label={`Hide ${t.title}`} title="Hide this photo" onClick={() => onHide(t.url!)}
                      className="absolute right-1.5 top-1.5 flex h-[20px] w-[20px] items-center justify-center rounded-full text-[12px] leading-none text-white" style={{ background: "rgba(6,61,44,.85)" }}>×</button>
                  )}
                </div>
              );
            })}
            {upload.allowed && !needle && (
              <button type="button" data-testid="offers-photo-upload-tile" disabled={upload.pct !== null || frozen}
                onClick={() => document.getElementById("offers-photo-file")?.click()}
                onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
                onDrop={(e) => { e.preventDefault(); setDragging(false); upload.onFile(e.dataTransfer.files[0]); }}
                className="flex min-h-[158px] flex-col items-center justify-center gap-1.5 rounded-[10px] border-[1.5px] border-dashed px-2 text-center disabled:cursor-not-allowed"
                style={{ borderColor: dragging ? O.chipOn : O.line, background: dragging ? O.mint : O.surface }}>
                {upload.pct === null
                  ? <><span className="text-[24px] font-medium leading-none" style={{ color: O.muted }}>+</span><span className="text-[13px] font-semibold" style={{ color: O.ink }}>Upload a photo</span><span className="text-[12px]" style={{ color: O.muted }}>JPG, PNG or WebP</span></>
                  : <>
                      <span data-testid="offers-upload-pct" className="text-[12px] font-medium" style={{ color: O.ink }}>{upload.pct >= 1 ? "Finishing…" : `Uploading ${Math.round(upload.pct * 100)}%`}</span>
                      <span className="h-1 w-4/5 overflow-hidden rounded-full" style={{ background: O.line }}><span className="block h-full" style={{ width: `${Math.round(upload.pct * 100)}%`, background: O.chipOn }} /></span>
                    </>}
              </button>
            )}
          </div>
          {upload.err && <div data-testid="offers-upload-error" className="text-[12px] font-medium" style={{ color: O.critInk }}>{upload.err}</div>}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" data-testid="offers-photo-none" disabled={frozen} onClick={() => onUse(null)} className="text-[13px] font-semibold disabled:cursor-not-allowed" style={{ color: O.muted }}>No photo</button>
          <div className="flex-1" />
          <Btn testId="offers-photo-cancel" onClick={onCancel}>Cancel</Btn>
          <Btn kind="primary" testId="offers-photo-use" disabled={frozen} onClick={() => onUse(pending)}>Use photo</Btn>
        </div>
      </div>
    </div>
  );
}

function ScopeChip({ on, onClick, children, testId }: { on: boolean; onClick: () => void; children: React.ReactNode; testId: string }) {
  return (
    <button type="button" data-testid={testId} data-on={on ? "1" : "0"} onClick={onClick}
      className={`whitespace-nowrap rounded-full border px-3.5 py-[7px] text-[13px] ${on ? "font-semibold" : "font-medium"}`}
      style={on ? { background: O.chipOn, borderColor: O.chipOn, color: "#fff" } : { background: O.surface, borderColor: O.line, color: O.ink }}>{children}</button>
  );
}
