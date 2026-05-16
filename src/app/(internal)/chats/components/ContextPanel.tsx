"use client";

// Player context panel rendered as a right column on lg: viewports
// and as a slide-up sheet on mobile (mirrors the GoalEditDrawer
// pattern from src/components/GoalEditDrawer.tsx).
//
// Sections:
//   - Header: avatar (lg), name, city + member pills
//   - Vital stats grid: phone, email, total matches, member-since
//   - Recent matches list (already loaded by /api/crm/threads/[id])
//   - Overflow menu: View in Supabase, ambiguous-match info note
//
// Renders a body shell + a mobile-only sheet wrapper. Parent decides
// which mode by passing `mode = "column" | "sheet"`.

import { useEffect } from "react";
import { X } from "lucide-react";
import { UNKNOWN_CITY } from "@/lib/cityColors";
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
  // Replaces the old all-time `total_match_count`. Counts only
  // matches the player actually played in calendar-year 2026 —
  // see loadPlayed2026Count in the API route.
  played_in_2026: number | null;
};

export type ContextRecentMatch = {
  match_api_id: number;
  venue: string | null;
  start_date: string | null;
  status: MatchStatus;
};

// One row per future booking — listed in the new UPCOMING section
// above Recent. Cancelled rows are included with is_cancelled=true
// and rendered de-emphasized; operators see them so they don't
// re-ask the player about a booking the player already withdrew.
// team and player_number come straight from mdapi_match_players —
// both integers. team renders as "Team N" because the upstream
// API doesn't expose a string name (e.g. "Dark Tee" / "White Tee"
// are consumer-app conventions, not values on our rows).
export type ContextUpcomingMatch = {
  match_api_id: number;
  venue: string | null;
  start_date: string | null;
  team: number | null;
  player_number: number | null;
  is_cancelled: boolean;
};

export type ContextThreadSummary = {
  phone_number: string;
  match_ambiguous: boolean;
};

type Props = {
  thread: ContextThreadSummary | null;
  player: ContextPlayer | null;
  recentMatches: ContextRecentMatch[];
  upcomingMatches: ContextUpcomingMatch[];
  historicalAccountCount: number | null;
  supabaseProjectRef: string | null;
  loading: boolean;
};

export default function ContextPanel({
  mode,
  open,
  onClose,
  ...props
}: Props & {
  mode: "column" | "sheet";
  open: boolean;
  onClose?: () => void;
}) {
  // Sheet variant: backdrop + slide-up panel. Only mounted when
  // `mode === "sheet"`. Desktop renders the column variant
  // unconditionally as part of the page layout.
  useEffect(() => {
    if (mode !== "sheet" || !open || !onClose) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose?.();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, open, onClose]);

  if (mode === "column") {
    return (
      <aside className="hidden w-[240px] shrink-0 flex-col overflow-y-auto border-l border-cream-line bg-cream-soft lg:flex">
        <ContextBody {...props} />
      </aside>
    );
  }

  // Sheet mode (mobile). Mirrors GoalEditDrawer's structure but
  // slides up from the bottom rather than in from the right.
  return (
    <div
      className={`fixed inset-0 z-40 lg:hidden ${
        open ? "" : "pointer-events-none"
      }`}
      aria-hidden={!open}
    >
      <div
        className={`absolute inset-0 bg-deep-green/40 transition-opacity duration-200 ${
          open ? "opacity-100" : "opacity-0"
        }`}
        onClick={onClose}
      />
      <div
        className={`absolute inset-x-0 bottom-0 flex max-h-[85vh] flex-col rounded-t-2xl bg-cream-soft shadow-2xl transition-transform duration-200 ease-out ${
          open ? "translate-y-0" : "translate-y-full"
        }`}
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
        <div className="flex-1 overflow-y-auto">
          <ContextBody {...props} />
        </div>
      </div>
    </div>
  );
}

function ContextBody({
  thread,
  player,
  recentMatches,
  upcomingMatches,
  historicalAccountCount,
  supabaseProjectRef,
  loading,
}: Props) {
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
                  {formatUpcomingDate(m.start_date)}
                  {" · "}
                  {formatMatchTime(m.start_date)}
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
                    {formatMatchDate(m.start_date)}
                    {" · "}
                    {formatMatchTime(m.start_date)}
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

      {player && supabaseProjectRef && (
        <a
          href={`https://supabase.com/dashboard/project/${supabaseProjectRef}/editor?schema=public&table=mdapi_users&filter=id%3Aeq%3A${player.id}`}
          target="_blank"
          rel="noreferrer"
          className="mt-3 inline-block text-xs font-medium text-deep-green underline decoration-deep-green/30 underline-offset-2 hover:decoration-deep-green"
        >
          View in Supabase →
        </a>
      )}
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

function formatMatchDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// "7:30 PM" — en-US `hour: numeric` already drops the leading
// zero (gives "7" not "07"). Uses the viewer's local zone, same
// as formatMatchDate — we deliberately don't introduce a new tz
// convention for Recent / Upcoming.
function formatMatchTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

// "Fri May 23" — includes weekday so operators can scan the
// Upcoming list and immediately tell a "tonight" booking from a
// "Saturday morning" one. Recent matches use the shorter
// formatMatchDate() because the status pill ("Played" /
// "Canceled") already carries most of the temporal context.
function formatUpcomingDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}
