"use client";

// "This week" calendar panel. Reads the signed-in user's own meetings from
// /api/calendar/week (server route, service role, filtered to the caller) — never
// the REVOKE'd tables with the user's JWT.
//
// TIME: every row is formatted from start_utc into ONE fixed display zone
// (America/Chicago). start_tz is provenance and never drives rendering (item 1b).
// STATE (item 4): ended / in-progress / next-up / upcoming, classified from the
// UTC instants (start_utc/end_utc) against a LIVE clock re-evaluated every 30s
// (4a) — comparing instants, never formatted strings (4b). All-day events are
// never in-progress and never "next up" (4c).

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type Attendee = { email: string; name: string; organizer: boolean; self: boolean };
type Meeting = {
  ical_uid: string;
  summary: string | null;
  start_utc: string;
  end_utc: string | null;
  start_tz: string | null;
  all_day: boolean;
  meet_url: string | null;
  attendees: Attendee[];
};
type WeekResponse = { grantConfigured: boolean; syncHasRun: boolean; userEmail: string; meetings: Meeting[] };

const DISPLAY_TZ = "America/Chicago";
const shell = {
  background: "#f2f4f3",
  borderColor: "#e2e9e6",
  boxShadow: "0 1px 2px rgba(7,42,32,.05), 0 12px 30px -20px rgba(7,42,32,.45)",
} as const;

type Phase = "ended" | "inprogress" | "nextup" | "upcoming" | "allday";

function fmt(iso: string, allDay: boolean): string {
  const d = new Date(iso);
  return allDay
    ? d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: DISPLAY_TZ })
    : d.toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: DISPLAY_TZ });
}

export default function CalendarPanel() {
  const [data, setData] = useState<WeekResponse | null>(null);
  const [ui, setUi] = useState<"loading" | "error" | "ready">("loading");
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { data: sess } = await supabase.auth.getSession();
        const token = sess.session?.access_token;
        if (!token) throw new Error("no session");
        const res = await fetch("/api/calendar/week", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as WeekResponse;
        if (alive) {
          setData(json);
          setUi("ready");
        }
      } catch {
        if (alive) setUi("error");
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Live clock — re-evaluate state every 30s so a row crosses next-up → in-progress
  // → ended while the tab sits open (item 4a).
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const meetings = (data?.meetings ?? []).slice().sort((a, b) => Date.parse(a.start_utc) - Date.parse(b.start_utc));
  // Classify each meeting from instants (item 4b). Exactly one non-all-day, not-yet-
  // started meeting is "next up" (item 4c excludes all-day).
  const nextUpKey = (() => {
    const upcoming = meetings.filter((m) => !m.all_day && Date.parse(m.start_utc) > now);
    return upcoming.length ? `${upcoming[0].ical_uid} ${upcoming[0].start_utc}` : null;
  })();
  const phaseOf = (m: Meeting): Phase => {
    if (m.all_day) return "allday";
    const start = Date.parse(m.start_utc);
    const end = m.end_utc ? Date.parse(m.end_utc) : start + 3600_000;
    if (end <= now) return "ended";
    if (start <= now) return "inprogress";
    return `${m.ical_uid} ${m.start_utc}` === nextUpKey ? "nextup" : "upcoming";
  };

  const allEnded = meetings.length > 0 && meetings.every((m) => phaseOf(m) === "ended");

  return (
    <div className="overflow-hidden rounded-[14px] border" style={shell}>
      <div className="flex items-center gap-[10px] border-b px-[18px] py-[15px]" style={{ borderColor: "#e2e9e6" }}>
        <h3 className="text-[14.5px] font-bold tracking-[-0.008em] text-[#12241d]">This week</h3>
      </div>

      {ui === "loading" && <Centered icon="◷" title="Loading your week…" body="" />}
      {ui === "error" && <Centered icon="◷" title="Couldn’t load your calendar" body="Refresh to try again." />}

      {ui === "ready" && data && (
        <>
          {!data.grantConfigured ? (
            <Centered icon="◷" title="Calendar not connected" body="A Workspace admin needs to authorize Calendar access before meetings can appear here." />
          ) : !data.syncHasRun ? (
            <Centered icon="◷" title="Connected · sync hasn’t run yet" body="Your meetings will appear here after the first sync runs." />
          ) : meetings.length === 0 ? (
            <Centered icon="✓" title="Connected · no meetings this week" body="Nothing on your calendar with 2 or more people this week." />
          ) : allEnded ? (
            <>
              <div className="px-[22px] pb-1 pt-[24px] text-center">
                <div className="mx-auto mb-2 flex h-[38px] w-[38px] items-center justify-center rounded-[12px] text-[17px]" style={{ background: "#e0f2e7", color: "#1a7a52" }}>✓</div>
                <h4 className="text-[13.5px] font-bold text-[#12241d]">All done for the week</h4>
              </div>
              <MeetingList meetings={meetings} phaseOf={phaseOf} />
            </>
          ) : (
            <MeetingList meetings={meetings} phaseOf={phaseOf} />
          )}
        </>
      )}

      <div className="mx-[18px] mb-[16px] mt-[14px] rounded-[10px] border px-[13px] py-[11px] text-[11.5px] leading-[1.6]" style={{ background: "#f5f9f6", borderColor: "#e2eee8", color: "#5f7d6f" }}>
        Only meetings with <b style={{ color: "#14563c" }}>2 or more people</b> are ever stored. Anything you mark{" "}
        <b style={{ color: "#14563c" }}>Private</b> in Google Calendar is skipped entirely. Descriptions and locations are never saved.
      </div>
    </div>
  );
}

function MeetingList({ meetings, phaseOf }: { meetings: Meeting[]; phaseOf: (m: Meeting) => Phase }) {
  return (
    <ul className="divide-y" style={{ borderColor: "#e9efeb" }}>
      {meetings.map((m) => {
        const phase = phaseOf(m);
        const ended = phase === "ended";
        const live = phase === "inprogress";
        // Order: organizer → signed-in user → everyone else alphabetically (item 5).
        const ordered = m.attendees.slice().sort((a, b) => {
          if (a.organizer !== b.organizer) return a.organizer ? -1 : 1;
          if (a.self !== b.self) return a.self ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        const CUTOFF = 4; // show the first 4, then "+N more" (full list on hover)
        const label = (a: Attendee) => a.name + (a.organizer ? " (organizer)" : "");
        const shown = ordered.slice(0, CUTOFF).map(label).join(", ");
        const more = ordered.length - CUTOFF;
        const namesShort = more > 0 ? `${shown}, +${more} more` : shown;
        const namesFull = ordered.map(label).join(", ");
        return (
          <li key={`${m.ical_uid} ${m.start_utc}`} className={"px-[18px] py-[12px]" + (ended ? " opacity-45" : "")} style={live ? { background: "#eafaf1" } : undefined}>
            <div className="flex items-baseline justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                {live && <span className="inline-block h-[7px] w-[7px] shrink-0 animate-pulse rounded-full" style={{ background: "#12b06b" }} aria-label="in progress" />}
                <span className="truncate text-[13.5px] font-bold text-[#12241d]">{m.summary || "(no title)"}</span>
                {phase === "nextup" && <Badge text="Next up" bg="#dcefff" fg="#1b4fcb" />}
                {phase === "allday" && <Badge text="All day" bg="#eef1ef" fg="#5f7d6f" />}
              </div>
              <span className="shrink-0 text-[11.5px] font-semibold text-[#6d7b74]">{live ? "Now" : fmt(m.start_utc, m.all_day)}</span>
            </div>
            <div className="mt-1 flex items-center justify-between gap-3">
              <span className="truncate text-[11.5px] leading-[1.5] text-[#6d7b74]" title={namesFull}>{namesShort}</span>
              {m.meet_url && !ended && (
                <a
                  href={m.meet_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={
                    "shrink-0 rounded-[8px] px-[11px] py-[5px] text-[11px] font-bold transition " +
                    (live ? "text-white" : "border")
                  }
                  style={live ? { background: "#12b06b" } : { color: "#14563c", borderColor: "#bfe3cf", background: "#f5f9f6" }}
                >
                  Join
                </a>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function Badge({ text, bg, fg }: { text: string; bg: string; fg: string }) {
  return (
    <span className="shrink-0 rounded-full px-[7px] py-[1px] text-[9.5px] font-black uppercase tracking-wide" style={{ background: bg, color: fg }}>
      {text}
    </span>
  );
}

function Centered({ icon, title, body }: { icon: string; title: string; body: string }) {
  return (
    <div className="px-[22px] pb-2 pt-[30px] text-center">
      <div className="mx-auto mb-3 flex h-[42px] w-[42px] items-center justify-center rounded-[12px] text-[19px]" style={{ background: "#e0f2e7", color: "#1a7a52" }}>
        {icon}
      </div>
      <h4 className="mb-[7px] text-[14px] font-bold text-[#12241d]">{title}</h4>
      {body && <p className="mx-auto max-w-[38ch] text-[12.5px] leading-[1.6] text-[#6d7b74]">{body}</p>}
    </div>
  );
}
