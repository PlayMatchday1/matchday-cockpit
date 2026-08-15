"use client";

// Player context pane (mockup playerchats-v1, 292px, right side). Gives the
// agent who they're talking to before they reply. Mist tone.
//
// EVERY field here is sourced from real data (see the ship report / Step-1
// recon). Fields the data can't support are OMITTED, never shown as a dash or
// a zero: lifetime spend (fin_revenue has no per-player key), membership
// renewal date (no renewal column exists), and prior-conversation count
// (one-thread-per-phone). There is also no Stripe refund write-path and no
// player-profile route, so the pane renders NO action buttons — a button that
// bounces advertises a page you can't open.
//
// Data comes from /api/crm/threads/{id}/context (fetched lazily when the pane
// is visible). played_lifetime / no_show_count were added to that route.

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import CopyPhone from "@/components/CopyPhone";
import { colorForCity } from "@/lib/cityColors";

type RecentMatch = {
  venue: string | null;
  start_date: string | null;
  start_date_utc: string | null;
  city_identifier: string | null;
  status: "Played" | "Upcoming" | "No-show" | "Canceled";
};

type ContextResponse = {
  player:
    | {
        first_name: string | null;
        last_name: string | null;
        preferable_city_normalized: string | null;
        preferable_city_name: string | null;
        is_member: boolean | null;
        created_at: string | null;
        played_lifetime: number | null;
        no_show_count: number | null;
      }
    | null;
  membership: { status: string; canceled_at: string | null } | null;
  recent_matches: RecentMatch[];
};

function initialsOf(first: string | null, last: string | null): string {
  const a = (first ?? "").trim();
  const b = (last ?? "").trim();
  const i = (a[0] ?? "") + (b[0] ?? "");
  return (i || "?").toUpperCase();
}

function monthYear(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

function matchWhen(m: RecentMatch): string {
  const iso = m.start_date_utc ?? m.start_date;
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

const STATUS_STYLE: Record<RecentMatch["status"], { color: string }> = {
  Played: { color: "#12704a" },
  Upcoming: { color: "#4a539a" },
  "No-show": { color: "#a83b1c" },
  Canceled: { color: "#a83b1c" },
};

export default function ContextPane({ threadId, phone }: { threadId: string; phone?: string | null }) {
  const [data, setData] = useState<ContextResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let off = false;
    setData(null);
    setError(null);
    (async () => {
      try {
        const { data: s } = await supabase.auth.getSession();
        const token = s.session?.access_token;
        if (!token) return;
        const res = await fetch(`/api/crm/threads/${threadId}/context`, {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (!off) setData((await res.json()) as ContextResponse);
      } catch (e) {
        if (!off) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      off = true;
    };
  }, [threadId]);

  const p = data?.player ?? null;
  const cityCode = p?.preferable_city_normalized || null;
  const cityName = p?.preferable_city_name || cityCode || null;
  const joined = monthYear(p?.created_at ?? null);
  const name = p ? `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim() || "Player" : "Player";
  const badgeColor = cityCode ? colorForCity(cityCode) : "#6d7b74";
  const inGoodStanding = !!data?.membership && !data.membership.canceled_at;

  const stats: { v: number; k: string }[] = [];
  if (p?.played_lifetime != null) stats.push({ v: p.played_lifetime, k: "matches played" });
  if (p?.no_show_count != null) stats.push({ v: p.no_show_count, k: "no-shows" });

  const recent = (data?.recent_matches ?? []).slice(0, 3);

  return (
    <aside
      className="hidden min-h-0 w-[292px] shrink-0 flex-col overflow-y-auto border-l min-[1260px]:flex"
      style={{ background: "linear-gradient(180deg,#fafbfa,#f6f9f7)", borderColor: "#e6ebe8" }}
    >
      {!p && !error && !data && (
        <div className="px-4 py-8 text-center text-[12px]" style={{ color: "#93a49b" }}>
          Loading player…
        </div>
      )}
      {/* LOADED BUT UNMATCHED. Previously this state fell through to "Loading player…" forever —
          an unknown thread looked like a pane that never finished. It is also the thread where the
          NUMBER matters most, because working out who this is starts with pasting it into Player
          Lookup, so it gets the number and the copy control. */}
      {!p && !error && data && (
        <div className="px-4 py-6 text-center text-[12px]" style={{ color: "#6d7b74" }}>
          <div className="font-[760]" style={{ color: "#12241d" }}>Unknown number</div>
          <p className="mt-1 text-[11.5px]">No player account matched this number.</p>
          {phone && (
            <div className="mt-2 inline-flex items-center gap-0.5">
              <span className="font-mono text-[12px]" data-testid="ctx-phone-unknown" style={{ color: "#6d7b74" }}>{phone}</span>
              <CopyPhone value={phone} />
            </div>
          )}
        </div>
      )}
      {error && (
        <div className="m-3 rounded-lg border px-3 py-2 text-xs" style={{ borderColor: "#e3c369", background: "#fdf1d0", color: "#8a6300" }}>
          Couldn&apos;t load player details.
        </div>
      )}
      {p && (
        <>
          {/* Top */}
          <div className="border-b px-4 pb-[13px] pt-4 text-center" style={{ borderColor: "#e6ebe8" }}>
            <div
              className="mx-auto mb-[9px] flex h-[52px] w-[52px] items-center justify-center rounded-full text-[16px] font-[780]"
              style={{ background: `${badgeColor}1f`, color: badgeColor, boxShadow: "0 0 0 4px rgba(255,255,255,.7)" }}
            >
              {initialsOf(p.first_name, p.last_name)}
            </div>
            <div className="text-[15px] font-[760] tracking-[-0.015em]" style={{ color: "#12241d" }}>{name}</div>
            {(cityName || joined) && (
              <div className="mt-[3px] text-[11.5px] font-semibold" style={{ color: "#6d7b74" }}>
                {[cityName, joined ? `joined ${joined}` : null].filter(Boolean).join(" · ")}
              </div>
            )}
            {/* The number, with copy beside it — this is the desktop surface you paste into Player
                Lookup from. The glyph shares the number's row so it travels with it. */}
            {phone && (
              <div className="mt-[5px] inline-flex items-center justify-center gap-0.5">
                <span className="font-mono text-[11.5px]" data-testid="ctx-phone" style={{ color: "#6d7b74" }}>{phone}</span>
                <CopyPhone value={phone} />
              </div>
            )}
            <div className="mt-[9px] flex flex-wrap justify-center gap-[5px]">
              <span className="rounded-full border px-2 py-[2.5px] text-[10px] font-[780]" style={{ background: "#eef0fa", color: "#4a539a", borderColor: "#dde1f4" }}>
                {p.is_member ? "Member" : "Casual"}
              </span>
              {inGoodStanding && (
                <span className="rounded-full border px-2 py-[2.5px] text-[10px] font-[780]" style={{ background: "#e0f2e7", color: "#12704a", borderColor: "#c9e8d8" }}>
                  Good standing
                </span>
              )}
            </div>
          </div>

          {/* Play */}
          {stats.length > 0 && (
            <div className="border-b px-4 py-[13px]" style={{ borderColor: "#e6ebe8" }}>
              <div className="mb-[9px] text-[9.5px] font-extrabold uppercase tracking-[0.13em]" style={{ color: "#93a49b" }}>Play</div>
              <div className="grid grid-cols-2 gap-x-[10px] gap-y-[11px]">
                {stats.map((s) => (
                  <div key={s.k}>
                    <div className="text-[15px] font-[770] leading-[1.15] tracking-[-0.02em]" style={{ color: "#12241d" }}>{s.v}</div>
                    <div className="mt-[2px] text-[10.5px] font-semibold" style={{ color: "#6d7b74" }}>{s.k}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Recent matches */}
          {recent.length > 0 && (
            <div className="border-b px-4 py-[13px]" style={{ borderColor: "#e6ebe8" }}>
              <div className="mb-[9px] text-[9.5px] font-extrabold uppercase tracking-[0.13em]" style={{ color: "#93a49b" }}>Recent matches</div>
              {recent.map((m, i) => {
                const cc = m.city_identifier || cityCode || "";
                const col = cc ? colorForCity(cc) : "#6d7b74";
                return (
                  <div key={i} className="flex items-center gap-2 py-[6px]" style={i > 0 ? { borderTop: "1px solid #eff3f1" } : undefined}>
                    <span className="flex h-[26px] w-[26px] flex-none items-center justify-center rounded-[8px] text-[8.5px] font-[800]" style={{ background: `${col}1f`, color: col }}>
                      {cc || "—"}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] font-[650]" style={{ color: "#12241d" }}>{m.venue ?? "—"}</span>
                      <span className="block truncate text-[10.5px] font-semibold" style={{ color: "#6d7b74" }}>{matchWhen(m)}</span>
                    </span>
                    <span className="flex-none text-[10px] font-[780]" style={{ color: STATUS_STYLE[m.status].color }}>{m.status}</span>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </aside>
  );
}
