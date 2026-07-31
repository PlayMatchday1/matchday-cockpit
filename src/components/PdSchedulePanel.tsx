"use client";

// P&D (Presence & Direction) weekend roster — real and fully working, backed by
// our own pd_assignments table (independent of Google). One row per weekend of
// the shown month; any authenticated Clubhouse user can set/clear an owner
// (updated_by is the audit trail). Unassign sets owner_id null — never deletes
// the row. Amber row only for uncovered future weekends; no nudge/cron.
//
// weekend_start is a SQL date kept as a "YYYY-MM-DD" string throughout — see the
// date-trap note in src/lib/pdSchedule.ts. Nothing here calls new Date(string).

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { canAccess, useAuth, type AppUser } from "@/lib/useAuth";
import { todayBusinessDate } from "@/lib/goalPace";
import { classifyWeekends, weekendsOf } from "@/lib/pdSchedule";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

type Assignment = { weekend_start: string; owner_id: string | null };

export default function PdSchedulePanel() {
  const { appUser } = useAuth();
  const today = useMemo(() => todayBusinessDate(), []);
  const [curY, curM0] = useMemo(() => {
    const [y, m] = today.split("-").map(Number);
    return [y, m - 1] as const;
  }, [today]);

  const [year, setYear] = useState(curY);
  const [month0, setMonth0] = useState(curM0);
  const [assignments, setAssignments] = useState<Record<string, string | null>>({});
  const [owners, setOwners] = useState<AppUser[]>([]);

  const weekends = useMemo(() => weekendsOf(year, month0), [year, month0]);
  const classified = useMemo(
    () => classifyWeekends(weekends, today),
    [weekends, today],
  );

  // Owner dropdown = the access-list query, filtered to Clubhouse access,
  // sorted by full_name. Same query AdminUsersView uses (select *).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from("app_users").select("*");
      if (cancelled) return;
      const list = ((data ?? []) as AppUser[])
        .filter((u) => canAccess(u, "clubhouse"))
        .sort((a, b) =>
          (a.full_name ?? a.email).localeCompare(b.full_name ?? b.email),
        );
      setOwners(list);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const loadAssignments = useCallback(async () => {
    const sats = weekends.map((w) => w.satYmd);
    if (sats.length === 0) return;
    const { data } = await supabase
      .from("pd_assignments")
      .select("weekend_start,owner_id")
      .in("weekend_start", sats);
    const map: Record<string, string | null> = {};
    for (const r of (data ?? []) as Assignment[]) map[r.weekend_start] = r.owner_id;
    setAssignments(map);
  }, [weekends]);

  useEffect(() => {
    loadAssignments();
  }, [loadAssignments]);

  async function setOwner(satYmd: string, ownerId: string) {
    if (!appUser) return;
    const next = ownerId || null;
    setAssignments((a) => ({ ...a, [satYmd]: next })); // optimistic
    const { error } = await supabase.from("pd_assignments").upsert(
      {
        weekend_start: satYmd,
        owner_id: next,
        updated_at: new Date().toISOString(),
        updated_by: appUser.id,
      },
      { onConflict: "weekend_start" },
    );
    if (error) {
      alert(error.message);
      loadAssignments(); // resync on failure
    }
  }

  function shiftMonth(delta: number) {
    const d = new Date(year, month0 + delta, 1); // from parts — safe
    setYear(d.getFullYear());
    setMonth0(d.getMonth());
  }

  // Header note. Never claim coverage for a month entirely in the past.
  const monthEntirelyPast =
    year < curY || (year === curY && month0 < curM0);
  const upcoming = classified.filter((c) => c.state !== "past");
  const uncoveredUpcoming = upcoming.filter(
    (c) => !assignments[c.weekend.satYmd],
  ).length;

  const ownerName = (id: string | null) =>
    id ? (owners.find((o) => o.id === id)?.full_name ?? "Unknown") : null;

  return (
    <div
      className="overflow-hidden rounded-[14px] border"
      style={{
        background: "#fffdf7",
        borderColor: "#efe9dc",
        boxShadow: "0 1px 2px rgba(7,42,32,.05), 0 12px 30px -20px rgba(7,42,32,.45)",
      }}
    >
      <div
        className="flex items-center gap-[10px] border-b px-[18px] py-[15px]"
        style={{ borderColor: "#efe9dc" }}
      >
        <h3 className="text-[14.5px] font-bold tracking-[-0.008em] text-[#12241d]">
          P&amp;D schedule
        </h3>
        <span className="text-[12.5px] tabular-nums text-[#6d7b74]">
          {MONTHS[month0]} {year}
        </span>
        <span className="ml-auto flex items-center gap-[5px]">
          <NavBtn label="Previous month" onClick={() => shiftMonth(-1)}>
            ‹
          </NavBtn>
          <NavBtn label="Next month" onClick={() => shiftMonth(1)}>
            ›
          </NavBtn>
        </span>
      </div>

      {/* Header note */}
      <div
        className="flex items-center gap-[7px] border-b px-[18px] py-[9px] text-[12px] font-[650]"
        style={
          monthEntirelyPast
            ? { background: "#f7f4ec", color: "#6d7b74", borderColor: "#efe9dc" }
            : uncoveredUpcoming > 0
              ? { background: "#fdf1d0", color: "#8a6300", borderColor: "#efe9dc" }
              : { background: "#e0f2e7", color: "#116b42", borderColor: "#efe9dc" }
        }
      >
        {monthEntirelyPast
          ? "This month has already passed"
          : uncoveredUpcoming > 0
            ? `▲ ${uncoveredUpcoming} upcoming weekend${uncoveredUpcoming === 1 ? "" : "s"} with no P&D owner`
            : "● Every upcoming weekend is covered"}
      </div>

      {/* Rows */}
      <div>
        {classified.map(({ weekend, state }) => {
          const ownerId = assignments[weekend.satYmd] ?? null;
          const uncoveredFuture = state !== "past" && !ownerId;
          return (
            <div
              key={weekend.satYmd}
              className="relative flex items-center gap-[11px] border-b px-[18px] py-[11px]"
              style={{
                borderColor: "#efe9dc",
                ...(uncoveredFuture ? { background: "#fefaef" } : {}),
                ...(state === "past" ? { opacity: 0.48 } : {}),
              }}
            >
              {uncoveredFuture && (
                <span
                  aria-hidden
                  className="absolute inset-y-0 left-0 w-[3px]"
                  style={{ background: "#e3c369" }}
                />
              )}
              <div className="flex w-[110px] shrink-0 flex-col gap-[2px] leading-[1.25]">
                <span className="text-[12.5px] font-bold tabular-nums text-[#12241d]">
                  {weekend.label}
                </span>
                {state === "this" && (
                  <span className="text-[9px] font-[750] uppercase tracking-[0.07em] text-[#116b42]">
                    This weekend
                  </span>
                )}
                {state === "past" && (
                  <span className="text-[9px] font-[650] uppercase tracking-[0.05em] text-[#a4aeaa]">
                    Done
                  </span>
                )}
              </div>

              <div className="min-w-0 flex-1">
                {state === "past" ? (
                  <span className="text-[12.5px] text-[#6d7b74]">
                    {ownerName(ownerId) ?? "—"}
                  </span>
                ) : (
                  <select
                    value={ownerId ?? ""}
                    onChange={(e) => setOwner(weekend.satYmd, e.target.value)}
                    className="w-full max-w-[220px] rounded-lg border bg-white px-2 py-[6px] text-[12.5px] text-[#12241d]"
                    style={{
                      borderColor: uncoveredFuture ? "#e3c369" : "#e4ddcc",
                      color: ownerId ? "#12241d" : "#8a6300",
                    }}
                  >
                    <option value="">— Unassigned —</option>
                    {owners.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.full_name ?? o.email}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            </div>
          );
        })}
        {classified.length === 0 && (
          <div className="px-5 py-[30px] text-center text-[12.5px] text-[#6d7b74]">
            No weekends this month.
          </div>
        )}
      </div>
    </div>
  );
}

function NavBtn({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="flex h-[27px] w-[27px] items-center justify-center rounded-lg border text-[14px] leading-none transition hover:bg-[#f2ede2]"
      style={{ borderColor: "#e4ddcc", color: "#4b6459" }}
    >
      {children}
    </button>
  );
}
