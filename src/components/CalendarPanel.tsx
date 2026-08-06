"use client";

// "This week" calendar panel. Reads the signed-in user's own meetings from
// /api/calendar/week — a server route that queries the service-role-only calendar
// tables and filters to the caller server-side (the browser can't read those
// tables directly). Renders three real states so an empty week never reads as a
// broken connection.

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type Attendee = { email: string; display_name: string | null; organizer: boolean };
type Meeting = {
  ical_uid: string;
  summary: string | null;
  start_utc: string;
  end_utc: string | null;
  start_tz: string | null;
  all_day: boolean;
  attendees: Attendee[];
};
type WeekResponse = { grantConfigured: boolean; syncHasRun: boolean; userEmail: string; meetings: Meeting[] };

const shell = {
  background: "#f2f4f3",
  borderColor: "#e2e9e6",
  boxShadow: "0 1px 2px rgba(7,42,32,.05), 0 12px 30px -20px rgba(7,42,32,.45)",
} as const;

function fmtTime(iso: string, tz: string | null, allDay: boolean): string {
  const d = new Date(iso);
  if (allDay) return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: tz ?? "America/Chicago" });
  return d.toLocaleString("en-US", {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZone: tz ?? "America/Chicago",
  });
}

export default function CalendarPanel() {
  const [data, setData] = useState<WeekResponse | null>(null);
  const [state, setState] = useState<"loading" | "error" | "ready">("loading");

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
          setState("ready");
        }
      } catch {
        if (alive) setState("error");
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="overflow-hidden rounded-[14px] border" style={shell}>
      <div className="flex items-center gap-[10px] border-b px-[18px] py-[15px]" style={{ borderColor: "#e2e9e6" }}>
        <h3 className="text-[14.5px] font-bold tracking-[-0.008em] text-[#12241d]">This week</h3>
      </div>

      {state === "loading" && <Centered icon="◷" title="Loading your week…" body="" />}
      {state === "error" && <Centered icon="◷" title="Couldn’t load your calendar" body="Refresh to try again." />}

      {state === "ready" && data && (
        <>
          {!data.grantConfigured ? (
            <Centered
              icon="◷"
              title="Calendar not connected"
              body="A Workspace admin needs to authorize Calendar access before meetings can appear here."
            />
          ) : !data.syncHasRun ? (
            <Centered icon="◷" title="Connected · sync hasn’t run yet" body="Your meetings will appear here after the first sync runs." />
          ) : data.meetings.length === 0 ? (
            <Centered icon="✓" title="Connected · no meetings this week" body="Nothing on your calendar with 2 or more people this week." />
          ) : (
            <ul className="divide-y" style={{ borderColor: "#e9efeb" }}>
              {data.meetings.map((m) => (
                <li key={`${m.ical_uid} ${m.start_utc}`} className="px-[18px] py-[13px]">
                  <div className="flex items-baseline justify-between gap-3">
                    <div className="text-[13.5px] font-bold text-[#12241d]">{m.summary || "(no title)"}</div>
                    <div className="shrink-0 text-[11.5px] font-semibold text-[#6d7b74]">{fmtTime(m.start_utc, m.start_tz, m.all_day)}</div>
                  </div>
                  <div className="mt-1 text-[11.5px] leading-[1.5] text-[#6d7b74]">
                    {m.attendees
                      .slice()
                      .sort((a, b) => Number(b.organizer) - Number(a.organizer))
                      .map((a) => a.display_name || a.email)
                      .join(", ")}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <div
        className="mx-[18px] mb-[16px] mt-[14px] rounded-[10px] border px-[13px] py-[11px] text-[11.5px] leading-[1.6]"
        style={{ background: "#f5f9f6", borderColor: "#e2eee8", color: "#5f7d6f" }}
      >
        Only meetings with <b style={{ color: "#14563c" }}>2 or more people</b> are ever stored. Anything you mark{" "}
        <b style={{ color: "#14563c" }}>Private</b> in Google Calendar is skipped entirely. Descriptions and locations are never saved.
      </div>
    </div>
  );
}

function Centered({ icon, title, body }: { icon: string; title: string; body: string }) {
  return (
    <div className="px-[22px] pb-2 pt-[30px] text-center">
      <div
        className="mx-auto mb-3 flex h-[42px] w-[42px] items-center justify-center rounded-[12px] text-[19px]"
        style={{ background: "#e0f2e7", color: "#1a7a52" }}
      >
        {icon}
      </div>
      <h4 className="mb-[7px] text-[14px] font-bold text-[#12241d]">{title}</h4>
      {body && <p className="mx-auto max-w-[38ch] text-[12.5px] leading-[1.6] text-[#6d7b74]">{body}</p>}
    </div>
  );
}
