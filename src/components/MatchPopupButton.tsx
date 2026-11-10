"use client";

// MATCH PROMOTION › POPUP CHANNEL: "Create popup" (a new no-discount popup with this match picked) or, when one already
// exists for the match, "View popup" with its status. Rules: src/lib/matchPopups.ts. Opens in a new tab so an unsaved
// plan in the drawer isn't lost.
//
// The popups are read once per page (one /admin/offers/page read) and shared by every drawer. Without Match Ops access
// (the Offers gate answers 404) nothing is drawn: the Offers page wouldn't open for that account either.

import { useEffect, useState } from "react";
import { createPopupHref, viewPopupHref, type MatchPopup } from "@/lib/matchPopups";
import { STATE_LABEL } from "@/lib/offersModel";
import { authed } from "@/components/offers/offersUi";

type Read = { kind: "ok"; byMatch: Record<number, MatchPopup[]> } | { kind: "hidden" } | { kind: "error"; text: string };
let shared: Promise<Read> | null = null;
function readPopups(): Promise<Read> {
  shared ??= authed("/api/offers/match-popups").then((r): Read => {
    if (r.status === 401 || (r.status === 404 && r.json.error === "Not found")) return { kind: "hidden" };
    if (!r.ok) { shared = null; return { kind: "error", text: String(r.json.error) }; }
    return { kind: "ok", byMatch: (r.json.byMatch ?? {}) as Record<number, MatchPopup[]> };
  });
  return shared;
}

const STATE_INK: Record<string, string> = { LIVE: "bg-mint-soft text-emerald-700", SCHEDULED: "bg-[#e8eefb] text-[#2f55b5]", PAUSED: "bg-amber-50 text-amber-700", DRAFT: "bg-[#f3f3ef] text-deep-green/60", ENDED: "bg-[#f3f3ef] text-deep-green/45" };
const BTN = "inline-flex min-h-[32px] items-center rounded-lg border border-cream-line bg-white px-3 text-[11.5px] font-bold text-deep-green/80 hover:border-mint hover:bg-mint-soft/30 hover:text-emerald-700";

export default function MatchPopupButton({ matchId }: { matchId: number }) {
  const [read, setRead] = useState<Read | null>(null);
  useEffect(() => {
    let cancelled = false;
    readPopups().then((r) => { if (!cancelled) setRead(r); });
    return () => { cancelled = true; };
  }, []);
  if (!read || read.kind === "hidden") return null;
  const popups = read.kind === "ok" ? read.byMatch[matchId] ?? [] : [];
  const first = popups[0];
  return (
    <div data-testid="popup-link" data-popup={first ? String(first.id) : ""} className="mb-2 flex flex-wrap items-center gap-2">
      {first ? (
        <>
          <a href={viewPopupHref(first.id)} target="_blank" rel="noopener" className={BTN} title={first.name}>View popup</a>
          <span data-testid="popup-state" className={`rounded-full px-2 py-[2px] text-[11px] font-bold ${STATE_INK[first.state] ?? ""}`}>{STATE_LABEL[first.state] ?? first.state}</span>
          <span className="min-w-0 truncate text-[11.5px] text-deep-green/55">{first.name}{popups.length > 1 ? ` · ${popups.length - 1} more for this match` : ""}</span>
        </>
      ) : (
        <a href={createPopupHref(matchId)} target="_blank" rel="noopener" className={BTN}>Create popup</a>
      )}
      {read.kind === "error" && <span data-testid="popup-error" className="text-[11px] text-deep-green/45">Couldn&apos;t check for an existing popup: {read.text}</span>}
    </div>
  );
}
