"use client";

// RECENT APP ACTIVITY — the Player context panel's card (Figma 9TgSk4sYqq4nNoTH73wRRs frame 2).
// The latest failure in the last 7 days on top, then the last 5 actions (background requests are
// hidden here), then "See all N in Player Lookup", which opens Lookup on this player with the card
// expanded. Same data and wording as the Lookup card (src/lib/appActivity.ts), 30 days.

import { useMemo } from "react";
import { annotate, summarize, recentFailure, isAction, matchLine, shortStamp, timeIn } from "@/lib/appActivity";
import { useAppActivity } from "@/components/AppActivityCard";
import { zoneOfCity } from "@/lib/matchTimezone";

const INK = "#12241d", MUTED = "#6d7b74", FAINT = "#93a49b", LINE = "#e6ebe8", RED = "#b3241f";
const FALLBACK_TZ = "America/Chicago";

export default function RecentAppActivity({ env, playerId, city }: { env: string; playerId: number; city: string | null }) {
  const { state } = useAppActivity(env, playerId, 30);
  const zone = zoneOfCity(city);
  const tz = zone ?? FALLBACK_TZ;
  const items = useMemo(() => (state.phase === "ok" ? annotate(state.data.rows) : []), [state]);
  const sum = useMemo(() => summarize(items), [items]);
  const fail = useMemo(() => recentFailure(items), [items]);
  const recent = useMemo(() => items.filter((i) => isAction(i) && i.id !== fail?.id).slice(0, 5), [items, fail]);
  const matches = state.phase === "ok" ? state.data.matches : {};
  const label = (id: number | null) => (id == null ? null : matchLine(matches[id], id));

  return (
    <div className="mx-3 mt-3" data-testid="ctx-activity">
      <div className="overflow-hidden rounded-[12px] border-[1.5px] bg-white" style={{ borderColor: "#3fcf86" }}>
        <div className="flex items-center border-b px-3 py-2" style={{ borderColor: LINE }}>
          <span className="text-[10.5px] font-[800] tracking-[0.09em]" style={{ color: MUTED }}>RECENT APP ACTIVITY</span>
          <span className="ml-auto text-[11px]" style={{ color: FAINT }}>{zone ? `${city} time` : "Central time"}</span>
        </div>
        {state.phase === "loading" && <p className="px-3 py-4 text-[12px]" style={{ color: FAINT }}>Loading…</p>}
        {state.phase === "error" && <p className="px-3 py-4 text-[12px]" style={{ color: RED }}>Couldn&apos;t load app activity: {state.error}</p>}
        {state.phase === "ok" && !items.length && <p className="px-3 py-4 text-[12px]" style={{ color: MUTED }}>No app activity in the last 30 days.</p>}
        {fail && (
          <div className="border-b px-3 py-[9px]" data-testid="ctx-activity-failure" style={{ background: "#fdf1f0", borderColor: LINE }}>
            <div className="flex items-baseline gap-2">
              <span className="mt-[5px] inline-block h-[7px] w-[7px] shrink-0 rounded-full" style={{ background: "#d93a33" }} />
              <span className="text-[13px] font-[760]" style={{ color: INK }}>{fail.title}</span>
              <span className="ml-auto shrink-0 text-[11.5px]" style={{ color: MUTED }}>{shortStamp(fail.ts, tz)}</span>
            </div>
            {(label(fail.matchRef) ?? fail.detail) && <div className="pl-[15px] text-[11.5px]" style={{ color: MUTED }}>{label(fail.matchRef) ?? fail.detail}</div>}
            <div className="pl-[15px] text-[11.5px]" style={{ color: RED }}>{fail.reason}</div>
            <div className="pl-[15px] font-mono text-[10px]" style={{ color: FAINT }}>{fail.errorCode ?? "no code"} · {fail.status}</div>
          </div>
        )}
        {recent.map((i) => (
          <div key={i.id} className="flex items-baseline gap-2 border-b px-3 py-[7px]" data-testid="ctx-activity-row" data-failed={i.failed ? "1" : "0"} style={{ borderColor: LINE }}>
            <span className="w-[86px] shrink-0 text-[11.5px]" style={{ color: MUTED }}>{shortStamp(i.ts, tz)}</span>
            <span className="mt-[5px] inline-block h-[6px] w-[6px] shrink-0 rounded-full" style={{ background: i.failed ? "#d93a33" : "#1fae5b" }} />
            <span className={`min-w-0 text-[12.5px] ${i.known ? "" : "font-mono"}`} style={{ color: i.failed ? RED : INK }}
              title={i.failed ? `${i.reason} (${i.errorCode ?? "no code"} · ${i.status} at ${timeIn(i.ts, tz)})` : undefined}>
              {i.title}{i.matchRef != null ? ` · ${(matches[i.matchRef]?.field ?? `Match #${i.matchRef}`)}` : ""}
            </span>
          </div>
        ))}
        {state.phase === "ok" && items.length > 0 && (
          <a data-testid="ctx-activity-all" href={`/match-ops/player-lookup?id=${playerId}&activity=open`}
            className="block px-3 py-[9px] text-[12px] font-[720]" style={{ color: "#12301f" }}>
            See all {sum.actions} in Player Lookup ›
          </a>
        )}
      </div>
      <p className="mt-[6px] px-1 text-[10.5px] leading-snug" style={{ color: FAINT }}>
        Failures in the last 7 days sit on top. Background requests are hidden here.
      </p>
    </div>
  );
}
