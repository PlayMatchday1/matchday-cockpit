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
  // Which weekend's owner box is open for editing. Resting state shows a clean
  // owner box + a pencil; the dropdown only appears once you choose to change it.
  const [editing, setEditing] = useState<string | null>(null);

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
        .filter((u) => canAccess(u, "home"))
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
        background: "#f2f4f3",
        borderColor: "#e2e9e6",
        boxShadow: "0 1px 2px rgba(7,42,32,.05), 0 12px 30px -20px rgba(7,42,32,.45)",
      }}
    >
      <div
        className="flex items-center gap-[10px] border-b px-[18px] py-[15px]"
        style={{ borderColor: "#e2e9e6" }}
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
            ? { background: "#f0f3f2", color: "#6d7b74", borderColor: "#e2e9e6" }
            : uncoveredUpcoming > 0
              ? { background: "#fdf1d0", color: "#8a6300", borderColor: "#e2e9e6" }
              : { background: "#e0f2e7", color: "#116b42", borderColor: "#e2e9e6" }
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
                borderColor: "#e2e9e6",
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
                  <span className="inline-flex items-center gap-[7px] text-[12.5px] text-[#6d7b74]">
                    {ownerId ? <Avatar name={ownerName(ownerId)} muted /> : null}
                    {ownerName(ownerId) ?? "—"}
                  </span>
                ) : editing === weekend.satYmd ? (
                  // Editing: the dropdown, auto-focused; picking a name saves and
                  // closes; clicking away (blur) closes without a change.
                  <select
                    autoFocus
                    value={ownerId ?? ""}
                    onChange={(e) => {
                      setOwner(weekend.satYmd, e.target.value);
                      setEditing(null);
                    }}
                    onBlur={() => setEditing(null)}
                    className="w-full max-w-[240px] rounded-lg border bg-white px-2 py-[7px] text-[12.5px] text-[#12241d] outline-none"
                    style={{ borderColor: "#35c77f", boxShadow: "0 0 0 3px rgba(53,199,127,.16)", color: ownerId ? "#12241d" : "#8a6300" }}
                  >
                    <option value="">— Unassigned —</option>
                    {owners.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.full_name ?? o.email}
                      </option>
                    ))}
                  </select>
                ) : (
                  // Resting: an always-visible owner box with an edit pencil.
                  <button
                    type="button"
                    aria-label={`Change P&D owner for ${weekend.label}`}
                    onClick={() => setEditing(weekend.satYmd)}
                    className="group flex w-full max-w-[240px] items-center gap-[8px] rounded-lg border px-[10px] py-[6px] text-left text-[12.5px] transition hover:shadow-sm"
                    style={
                      ownerId
                        ? { borderColor: "#d3ddd8", background: "#fff", color: "#12241d" }
                        : { borderStyle: "dashed", borderColor: "#e3c369", background: "#fefaef", color: "#8a6300" }
                    }
                  >
                    {ownerId ? (
                      <>
                        <Avatar name={ownerName(ownerId)} />
                        <span className="min-w-0 flex-1 truncate font-[650]">{ownerName(ownerId)}</span>
                      </>
                    ) : (
                      <span className="min-w-0 flex-1 truncate font-[650]">Assign someone</span>
                    )}
                    <Pencil />
                  </button>
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

// Initials from a display name ("Ryan Mancuso" → "RM", "cesar@x.com" → "C").
function initialsOf(name: string | null): string {
  if (!name) return "?";
  const parts = name.trim().replace(/@.*$/, "").split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0][0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1][0] ?? "" : "";
  return (first + last).toUpperCase();
}

// Small initials circle, so an assigned weekend reads as a person at a glance.
function Avatar({ name, muted = false }: { name: string | null; muted?: boolean }) {
  return (
    <span
      aria-hidden
      className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full text-[10px] font-[750]"
      style={muted ? { background: "#eef1ec", color: "#8a9791" } : { background: "#e0f2e7", color: "#116b42" }}
    >
      {initialsOf(name)}
    </span>
  );
}

// The edit affordance — quiet until the row is hovered, so the boxes stay calm.
function Pencil() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="ml-auto h-[14px] w-[14px] shrink-0 opacity-45 transition group-hover:opacity-90"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
    </svg>
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
      className="flex h-[27px] w-[27px] items-center justify-center rounded-lg border text-[14px] leading-none transition hover:bg-[#e7edea]"
      style={{ borderColor: "#d3ddd8", color: "#4b6459" }}
    >
      {children}
    </button>
  );
}
