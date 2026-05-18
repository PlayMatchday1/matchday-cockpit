"use client";

// Player context panel rendered as a right column on lg: viewports
// and as a slide-up sheet on mobile (mirrors the GoalEditDrawer
// pattern from src/components/GoalEditDrawer.tsx).
//
// Sections:
//   - Header: avatar (lg), name, city + member pills
//   - Vital stats grid: phone, email, total matches, member-since
//   - Upcoming + Recent matches lists
//   - Ambiguous-match info note (top of body when match_ambiguous)
//
// Data: fetched lazily from /api/crm/threads/{id}/context, only when
// the panel is visible. Results cached per thread_id in a ref Map so
// switching back and forth doesn't refetch. The chat pane no longer
// blocks on these heavier queries.

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { UNKNOWN_CITY } from "@/lib/cityColors";
import { formatMatchTitle } from "@/lib/cityTimezones";
import { supabase } from "@/lib/supabase";
import PlayerAvatar from "@/components/PlayerAvatar";
import CityChip from "@/components/CityChip";
import MatchStatusPill, {
  type MatchStatus,
} from "@/components/MatchStatusPill";

export type ContextPlayer = {
  id: number;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone_number: string | null;
  preferable_city_normalized: string | null;
  preferable_city_name: string | null;
  is_member: boolean | null;
  created_at: string | null;
  played_in_2026: number | null;
};

export type ContextRecentMatch = {
  match_api_id: number;
  venue: string | null;
  start_date: string | null;
  start_date_utc: string | null;
  city_identifier: string | null;
  status: MatchStatus;
};

export type ContextUpcomingMatch = {
  match_api_id: number;
  venue: string | null;
  start_date: string | null;
  start_date_utc: string | null;
  city_identifier: string | null;
  team: number | null;
  player_number: number | null;
  is_cancelled: boolean;
};

export type ContextThreadSummary = {
  id: string;
  phone_number: string;
  match_ambiguous: boolean;
};

type FetchedContext = {
  player: ContextPlayer | null;
  recentMatches: ContextRecentMatch[];
  upcomingMatches: ContextUpcomingMatch[];
  historicalAccountCount: number | null;
};

const EMPTY_CONTEXT: FetchedContext = {
  player: null,
  recentMatches: [],
  upcomingMatches: [],
  historicalAccountCount: null,
};

type Props = {
  thread: ContextThreadSummary | null;
  mode: "column" | "sheet";
  open: boolean;
  visible: boolean;
  onClose?: () => void;
};

export default function ContextPanel({
  thread,
  mode,
  open,
  visible,
  onClose,
}: Props) {
  const cacheRef = useRef<Map<string, FetchedContext>>(new Map());
  const [data, setData] = useState<FetchedContext>(EMPTY_CONTEXT);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (mode !== "sheet" || !open || !onClose) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose?.();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, open, onClose]);

  // Lazy fetch: only when the panel is actually visible and a thread
  // is selected. Cached results show instantly on revisit; we still
  // refetch in the background so stale data converges. Bail on stale
  // responses if the user switched threads mid-flight.
  useEffect(() => {
    if (!visible || !thread) return;
    const threadId = thread.id;
    const cached = cacheRef.current.get(threadId);
    if (cached) {
      setData(cached);
    } else {
      setData(EMPTY_CONTEXT);
      setLoading(true);
    }
    let cancelled = false;
    (async () => {
      try {
        const { data: sess } = await supabase.auth.getSession();
        const token = sess.session?.access_token;
        if (!token) return;
        const res = await fetch(`/api/crm/threads/${threadId}/context`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;
        const json = (await res.json()) as {
          player: ContextPlayer | null;
          recent_matches: ContextRecentMatch[];
          upcoming_matches: ContextUpcomingMatch[];
          historical_account_count: number | null;
        };
        const next: FetchedContext = {
          player: json.player,
          recentMatches: json.recent_matches ?? [],
          upcomingMatches: json.upcoming_matches ?? [],
          historicalAccountCount: json.historical_account_count,
        };
        cacheRef.current.set(threadId, next);
        if (!cancelled) setData(next);
      } catch (err) {
        console.error("[ContextPanel] context fetch failed", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, thread]);

  const bodyProps = {
    thread,
    player: data.player,
    recentMatches: data.recentMatches,
    upcomingMatches: data.upcomingMatches,
    historicalAccountCount: data.historicalAccountCount,
    loading,
  };

  if (mode === "column") {
    return (
      <aside className="hidden w-[240px] shrink-0 flex-col overflow-y-auto overflow-x-hidden border-l border-cream-line bg-cream-soft lg:flex">
        <ContextBody {...bodyProps} />
      </aside>
    );
  }

  // Sheet mode (mobile). When closed, return null so the dialog
  // markup leaves the DOM entirely — closes a click-block surface at
  // md viewports where lg:hidden doesn't apply and pointer-events:
  // none on a parent doesn't always neutralize a child with
  // role=dialog + aria-modal + transition-transform under iOS Safari.
  //
  // The open animation runs once on mount via the
  // `animate-sheet-slide-up` keyframe defined in globals.css. We
  // skip the close-out animation; the sheet unmounts immediately,
  // which matches iOS native sheet dismissal behavior on backdrop
  // tap.
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 lg:hidden" role="presentation">
      <div
        className="absolute inset-0 bg-deep-green/40 opacity-100"
        onClick={onClose}
      />
      <div
        className="animate-sheet-slide-up absolute inset-x-0 bottom-0 flex max-h-[85vh] flex-col rounded-t-2xl bg-cream-soft shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-label="Player context"
      >
        {/* Grab handle + close */}
        <div className="flex items-center justify-between border-b border-cream-line px-3 py-2">
          <span
            aria-hidden
            className="mx-auto h-1 w-12 rounded-full bg-deep-green/15"
          />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close context"
            className="absolute right-3 top-2 inline-flex h-8 w-8 items-center justify-center rounded-full text-deep-green/60 hover:bg-cream-soft hover:text-deep-green"
          >
            <X aria-hidden className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto overflow-x-hidden">
          <ContextBody {...bodyProps} />
        </div>
      </div>
    </div>
  );
}

type BodyProps = {
  thread: ContextThreadSummary | null;
  player: ContextPlayer | null;
  recentMatches: ContextRecentMatch[];
  upcomingMatches: ContextUpcomingMatch[];
  historicalAccountCount: number | null;
  loading: boolean;
};

function ContextBody({
  thread,
  player,
  recentMatches,
  upcomingMatches,
  historicalAccountCount,
  loading,
}: BodyProps) {
  if (!thread) {
    return (
      <div className="p-4 text-xs text-deep-green/45">No player selected.</div>
    );
  }

  const ambiguous = thread.match_ambiguous;

  return (
    <div className="p-4">
      {ambiguous && (
        <div className="mb-3 flex items-start gap-1.5 rounded-md border border-cream-line bg-white p-2 text-xs text-deep-green/60">
          <span aria-hidden className="mt-px shrink-0">
            ⓘ
          </span>
          <span>
            Phone has{" "}
            {historicalAccountCount != null && historicalAccountCount > 0
              ? `${historicalAccountCount} historical account${historicalAccountCount === 1 ? "" : "s"}`
              : "historical accounts"}{" "}
            on file — showing the most recent.
          </span>
        </div>
      )}

      {loading && !player && (
        <div className="text-xs text-deep-green/50">Loading…</div>
      )}

      {/* Header card */}
      {player ? (
        <section className="rounded-lg bg-white p-4 shadow-sm">
          <div className="flex flex-col items-center text-center">
            <PlayerAvatar
              name={`${player.first_name ?? ""} ${player.last_name ?? ""}`.trim() || null}
              seed={String(player.id)}
              size="lg"
              isMember={player.is_member === true}
            />
            <div className="mt-2 text-sm font-extrabold tracking-tight text-deep-green">
              {[player.first_name, player.last_name]
                .filter(Boolean)
                .join(" ")
                .trim() || "(no name)"}
            </div>
            <div className="mt-1.5 flex flex-wrap items-center justify-center gap-1.5">
              <CityChip
                code={player.preferable_city_normalized ?? UNKNOWN_CITY}
              />
              {player.is_member === true && (
                <span className="rounded-full bg-purple-done/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-purple-done">
                  Member
                </span>
              )}
            </div>
          </div>

          <dl className="mt-4 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
            <Cell label="Phone">
              <span className="font-mono">{player.phone_number ?? "—"}</span>
            </Cell>
            <Cell label="Matches (2026)">
              {player.played_in_2026 ?? "—"}
            </Cell>
            <Cell label="Email" wide>
              <span className="break-all">{player.email ?? "—"}</span>
            </Cell>
            <Cell label="Joined">
              {player.created_at
                ? new Date(player.created_at).toLocaleDateString(undefined, {
                    month: "short",
                    year: "numeric",
                  })
                : "—"}
            </Cell>
          </dl>
        </section>
      ) : !loading ? (
        <section className="rounded-lg border border-dashed border-cream-line bg-white p-4 text-xs text-deep-green/70">
          <div className="font-bold text-deep-green">Unknown number</div>
          <p className="mt-1">
            No mdapi_users row matched this phone. Look up the player manually
            for now.
          </p>
          <div className="mt-2 font-mono text-deep-green/50">
            {thread.phone_number}
          </div>
        </section>
      ) : null}

      {/* Upcoming bookings — sits ABOVE Recent so the next match
          an operator might need to reroute is the first thing they
          see when a player WhatsApps in. Cancelled future
          registrations are shown but de-emphasized; operators can
          tell at a glance that a player already withdrew before
          they reply. */}
      <section className="mt-4 rounded-lg bg-white p-4 shadow-sm">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-deep-green/40">
          Upcoming
        </div>
        {loading ? (
          <div className="mt-2 text-xs text-deep-green/45">Loading…</div>
        ) : !player ? (
          <div className="mt-2 text-xs text-deep-green/45">
            No player linked.
          </div>
        ) : upcomingMatches.length === 0 ? (
          <div className="mt-2 text-xs text-deep-green/45">
            No upcoming matches.
          </div>
        ) : (
          <ul className="mt-2 divide-y divide-cream-line">
            {upcomingMatches.map((m) => (
              <li
                key={m.match_api_id}
                className={`flex flex-col gap-0.5 py-2 first:pt-0 last:pb-0 ${
                  m.is_cancelled ? "opacity-50" : ""
                }`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-xs font-semibold text-deep-green">
                    {m.venue?.trim() || "(no venue)"}
                  </span>
                  {m.is_cancelled && (
                    <span className="shrink-0 rounded-full bg-muted-soft px-1.5 py-px text-[9px] font-medium uppercase tracking-wider text-muted">
                      canceled
                    </span>
                  )}
                </div>
                <div className="text-[10px] text-deep-green/55">
                  <VenueLocalDateTime
                    cityCode={m.city_identifier}
                    startDateUtc={m.start_date_utc}
                  />
                  {m.team != null && (
                    <>
                      {" · "}Team {m.team}
                    </>
                  )}
                  {m.player_number != null && (
                    <>
                      {" · "}Spot {m.player_number}
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Recent matches */}
      <section className="mt-4 rounded-lg bg-white p-4 shadow-sm">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-deep-green/40">
          Recent matches
        </div>
        {loading ? (
          <div className="mt-2 text-xs text-deep-green/45">Loading…</div>
        ) : !player ? (
          <div className="mt-2 text-xs text-deep-green/45">
            No player linked.
          </div>
        ) : recentMatches.length === 0 ? (
          <div className="mt-2 text-xs text-deep-green/45">
            No recent matches.
          </div>
        ) : (
          <ul className="mt-2 divide-y divide-cream-line">
            {recentMatches.map((m) => (
              <li
                key={m.match_api_id}
                className="flex flex-col gap-1 py-2 first:pt-0 last:pb-0"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-xs font-semibold text-deep-green">
                    {m.venue?.trim() || "(no venue)"}
                  </span>
                  <span className="shrink-0 text-[10px] text-deep-green/50">
                    <VenueLocalDateTime
                      cityCode={m.city_identifier}
                      startDateUtc={m.start_date_utc}
                    />
                  </span>
                </div>
                <div>
                  <MatchStatusPill status={m.status} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

    </div>
  );
}

function Cell({
  label,
  children,
  wide,
}: {
  label: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={wide ? "col-span-2" : ""}>
      <dt className="text-[10px] uppercase tracking-wide text-deep-green/45">
        {label}
      </dt>
      <dd className="mt-0.5 text-deep-green">{children}</dd>
    </div>
  );
}

// Renders venue-local "Thu May 14 · 9:00 PM". cityCode is required
// to look up the IANA zone via timezoneFor() inside formatMatchTitle;
// when the city is unknown the formatter falls back to UTC and tags
// the output with a small "(UTC)" so the visible gap is honest.
function VenueLocalDateTime({
  cityCode,
  startDateUtc,
}: {
  cityCode: string | null;
  startDateUtc: string | null;
}) {
  const t = formatMatchTitle({
    cityCode,
    startDateIso: startDateUtc,
    fieldTitle: null,
  });
  return (
    <>
      {t.date}
      {t.time && (
        <>
          {" · "}
          {t.time}
        </>
      )}
      {t.isUtcFallback && t.time && (
        <span className="ml-0.5 text-deep-green/35">(UTC)</span>
      )}
    </>
  );
}
