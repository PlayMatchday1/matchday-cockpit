"use client";

// "This week" calendar panel. Reads the signed-in user's own meetings ONCE from
// /api/calendar/week (server route, service role, filtered to the caller) — never
// the REVOKE'd tables with the user's JWT.
//
// Structure: a pinned block (Now / Next up / All done) above a Today | This week
// toggle. ALL of it reads from ONE 30-second clock (`now`) — the pinned block, the
// list phases, and the relative-time strings recompute on that single tick, so
// nothing can disagree at a boundary (trap a), the countdown is never frozen
// (trap b), the day rolls over at midnight on the tick (trap d), and the toggle is
// a pure client-side FILTER over already-loaded data — never a refetch (trap c).
// Times render from start_utc in a fixed zone (America/Chicago); start_tz is
// provenance and never drives display.

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

const TZ = "America/Chicago";
const shell = {
  background: "#f2f4f3",
  borderColor: "#e2e9e6",
  boxShadow: "0 1px 2px rgba(7,42,32,.05), 0 12px 30px -20px rgba(7,42,32,.45)",
} as const;

// ── Chicago-fixed formatting/keys (single day definition, shared with the week
//    bounds the server uses) ──────────────────────────────────────────────────
const dayKey = (ms: number) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms)); // YYYY-MM-DD
const wdShort = (ms: number) => new Date(ms).toLocaleDateString("en-US", { weekday: "short", timeZone: TZ });
const wdLong = (ms: number) => new Date(ms).toLocaleDateString("en-US", { weekday: "long", timeZone: TZ });
const clock = (ms: number) => new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: TZ });
const dayLabel = (ms: number) => new Date(ms).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: TZ });
const fmtStart = (m: Meeting) => (m.all_day ? dayLabel(Date.parse(m.start_utc)) : `${wdShort(Date.parse(m.start_utc))} ${clock(Date.parse(m.start_utc))}`);

// Relative time, recomputed on the tick.
function relTime(startMs: number, now: number): string {
  const min = Math.round((startMs - now) / 60000);
  if (min < 60) return `in ${Math.max(min, 0)} min`;
  if (dayKey(startMs) === dayKey(now)) return `in ${Math.round(min / 60)} hours`;
  const t = clock(startMs);
  if (dayKey(startMs) === dayKey(now + 86400_000)) return `Tomorrow ${t}`;
  return `${wdLong(startMs)} ${t}`;
}
function endsIn(endMs: number, now: number): string {
  const min = Math.max(0, Math.round((endMs - now) / 60000));
  return min < 60 ? `ends in ${min} min` : `ends in ${Math.round(min / 60)} h`;
}

type Phase = "ended" | "inprogress" | "upcoming" | "allday";
function phaseOf(m: Meeting, now: number): Phase {
  if (m.all_day) return "allday";
  const start = Date.parse(m.start_utc);
  const end = m.end_utc ? Date.parse(m.end_utc) : start + 3600_000;
  if (end <= now) return "ended";
  if (start <= now) return "inprogress";
  return "upcoming";
}

export default function CalendarPanel() {
  const [data, setData] = useState<WeekResponse | null>(null);
  const [ui, setUi] = useState<"loading" | "error" | "ready">("loading");
  const [now, setNow] = useState(() => Date.now());
  const [view, setView] = useState<"today" | "week">("today"); // DEFAULT: Today

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

  // THE one clock. Everything below derives from `now`.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const all = (data?.meetings ?? []).slice().sort((a, b) => Date.parse(a.start_utc) - Date.parse(b.start_utc));
  // Pinned block target: the in-progress meeting if any, else the next non-all-day.
  const inProgress = all.find((m) => phaseOf(m, now) === "inprogress");
  const nextUp = all.find((m) => !m.all_day && Date.parse(m.start_utc) > now);
  const pinned = inProgress ?? nextUp ?? null;
  const pinnedKey = pinned ? `${pinned.ical_uid} ${pinned.start_utc}` : null;
  // A list row shows the "Next up" chip only when it's the next-up meeting AND the
  // pinned block is showing something else (an in-progress meeting) — never a second
  // highlight of the same meeting.
  const listNextUpKey = nextUp && pinnedKey !== `${nextUp.ical_uid} ${nextUp.start_utc}` ? `${nextUp.ical_uid} ${nextUp.start_utc}` : null;

  const header = (
    <div className="flex items-center justify-between gap-2 border-b px-[18px] py-[13px]" style={{ borderColor: "#e2e9e6" }}>
      <h3 className="text-[14.5px] font-bold tracking-[-0.008em] text-[#12241d]">This week</h3>
      {ui === "ready" && data?.grantConfigured && data?.syncHasRun && (
        <div className="flex rounded-[9px] p-[2px]" style={{ background: "#e7ece9" }}>
          {(["today", "week"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={"rounded-[7px] px-[11px] py-[3px] text-[11px] font-bold transition " + (view === v ? "bg-white text-[#12241d] shadow-sm" : "text-[#6d7b74]")}
            >
              {v === "today" ? "Today" : "This week"}
            </button>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div className="overflow-hidden rounded-[14px] border" style={shell}>
      {header}

      {ui === "loading" && <Centered icon="◷" title="Loading your week…" body="" />}
      {ui === "error" && <Centered icon="◷" title="Couldn’t load your calendar" body="Refresh to try again." />}

      {ui === "ready" && data && (
        !data.grantConfigured ? (
          <Centered icon="◷" title="Calendar not connected" body="A Workspace admin needs to authorize Calendar access before meetings can appear here." />
        ) : !data.syncHasRun ? (
          <Centered icon="◷" title="Connected · sync hasn’t run yet" body="Your meetings will appear here after the first sync runs." />
        ) : (
          <>
            <PinnedBlock pinned={pinned} inProgress={!!inProgress} now={now} />
            {view === "today" ? (
              <TodayView all={all} now={now} listNextUpKey={listNextUpKey} />
            ) : (
              <WeekView all={all} now={now} listNextUpKey={listNextUpKey} />
            )}
          </>
        )
      )}

      <div className="mx-[18px] mb-[16px] mt-[14px] rounded-[10px] border px-[13px] py-[11px] text-[11.5px] leading-[1.6]" style={{ background: "#f5f9f6", borderColor: "#e2eee8", color: "#5f7d6f" }}>
        Only meetings with <b style={{ color: "#14563c" }}>2 or more people</b> are ever stored. Anything you mark{" "}
        <b style={{ color: "#14563c" }}>Private</b> in Google Calendar is skipped entirely. Descriptions and locations are never saved.
      </div>
    </div>
  );
}

function PinnedBlock({ pinned, inProgress, now }: { pinned: Meeting | null; inProgress: boolean; now: number }) {
  if (!pinned) {
    return (
      <div className="border-b px-[18px] py-[16px] text-center" style={{ borderColor: "#e9efeb", background: "#f6faf7" }}>
        <span className="text-[13px] font-bold text-[#14563c]">✓ All done for the week</span>
      </div>
    );
  }
  const startMs = Date.parse(pinned.start_utc);
  const endMs = pinned.end_utc ? Date.parse(pinned.end_utc) : startMs + 3600_000;
  const rel = inProgress ? endsIn(endMs, now) : relTime(startMs, now);
  return (
    <div className="border-b px-[18px] py-[14px]" style={{ borderColor: "#e9efeb", background: inProgress ? "#eafaf1" : "#f3f8ff" }}>
      <div className="mb-[6px] flex items-center gap-2">
        {inProgress && <span className="inline-block h-[7px] w-[7px] animate-pulse rounded-full" style={{ background: "#12b06b" }} aria-hidden />}
        <span className="text-[9.5px] font-black uppercase tracking-wide" style={{ color: inProgress ? "#0d6b41" : "#1b4fcb" }}>
          {inProgress ? "Now" : "Next up"}
        </span>
        <span className="text-[10.5px] font-semibold text-[#6d7b74]">· {rel}</span>
      </div>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-[14px] font-bold text-[#12241d]">{pinned.summary || "(no title)"}</div>
          <div className="mt-[2px] text-[11.5px] text-[#6d7b74]">
            {inProgress ? `ends ${clock(endMs)}` : fmtStart(pinned)}
          </div>
          <div className="mt-1"><AttendeeLine attendees={pinned.attendees} /></div>
        </div>
        {pinned.meet_url && (
          <a href={pinned.meet_url} target="_blank" rel="noopener noreferrer" className="shrink-0 rounded-[8px] px-[13px] py-[6px] text-[12px] font-bold text-white" style={{ background: inProgress ? "#12b06b" : "#14563c" }}>
            Join
          </a>
        )}
      </div>
    </div>
  );
}

function TodayView({ all, now, listNextUpKey }: { all: Meeting[]; now: number; listNextUpKey: string | null }) {
  const todays = all.filter((m) => dayKey(Date.parse(m.start_utc)) === dayKey(now));
  const remaining = todays.filter((m) => phaseOf(m, now) !== "ended");
  if (todays.length === 0) {
    return <Line text="Nothing on your calendar today." />;
  }
  return (
    <>
      <MeetingList meetings={todays} now={now} listNextUpKey={listNextUpKey} />
      {remaining.length === 0 && <Line text="That’s everything for today." />}
    </>
  );
}

function WeekView({ all, now, listNextUpKey }: { all: Meeting[]; now: number; listNextUpKey: string | null }) {
  const todayK = dayKey(now);
  const elapsed = all.filter((m) => dayKey(Date.parse(m.start_utc)) < todayK);
  const rest = all.filter((m) => dayKey(Date.parse(m.start_utc)) >= todayK);
  return (
    <>
      {elapsed.length > 0 && <ElapsedRow meetings={elapsed} now={now} listNextUpKey={listNextUpKey} />}
      {rest.length > 0 ? <MeetingList meetings={rest} now={now} listNextUpKey={listNextUpKey} /> : elapsed.length > 0 ? <Line text="Nothing left this week." /> : null}
    </>
  );
}

// Elapsed days (before today) collapse into ONE expandable row — history reachable
// without pushing today down. Today + future always render expanded.
function ElapsedRow({ meetings, now, listNextUpKey }: { meetings: Meeting[]; now: number; listNextUpKey: string | null }) {
  const [open, setOpen] = useState(false);
  const first = Date.parse(meetings[0].start_utc);
  const last = Date.parse(meetings[meetings.length - 1].start_utc);
  const range = wdShort(first) === wdShort(last) ? wdShort(first) : `${wdShort(first)}–${wdShort(last)}`;
  return (
    <>
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center justify-between px-[18px] py-[11px] text-left" style={{ background: "#f1f4f2", borderBottom: "1px solid #e9efeb" }}>
        <span className="text-[11.5px] font-bold text-[#5f7d6f]">
          {range} · {meetings.length} {meetings.length === 1 ? "meeting" : "meetings"}
        </span>
        <span className="text-[11px] font-semibold text-[#6d7b74]">{open ? "Hide" : "Show"}</span>
      </button>
      {open && <MeetingList meetings={meetings} now={now} listNextUpKey={listNextUpKey} />}
    </>
  );
}

function MeetingList({ meetings, now, listNextUpKey }: { meetings: Meeting[]; now: number; listNextUpKey: string | null }) {
  return (
    <ul className="divide-y" style={{ borderColor: "#e9efeb" }}>
      {meetings.map((m) => {
        const phase = phaseOf(m, now);
        const ended = phase === "ended";
        const live = phase === "inprogress";
        const key = `${m.ical_uid} ${m.start_utc}`;
        return (
          <li key={key} className={"px-[18px] py-[12px]" + (ended ? " opacity-45" : "")} style={live ? { background: "#eafaf1" } : undefined}>
            <div className="flex items-baseline justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                {live && <span className="inline-block h-[7px] w-[7px] shrink-0 animate-pulse rounded-full" style={{ background: "#12b06b" }} aria-label="in progress" />}
                <span className="truncate text-[13.5px] font-bold text-[#12241d]">{m.summary || "(no title)"}</span>
                {key === listNextUpKey && <Badge text="Next up" bg="#dcefff" fg="#1b4fcb" />}
                {phase === "allday" && <Badge text="All day" bg="#eef1ef" fg="#5f7d6f" />}
              </div>
              <span className="shrink-0 text-[11.5px] font-semibold text-[#6d7b74]">{live ? "Now" : fmtStart(m)}</span>
            </div>
            <div className="mt-1 flex items-start justify-between gap-3">
              <AttendeeLine attendees={m.attendees} />
              {m.meet_url && !ended && (
                <a href={m.meet_url} target="_blank" rel="noopener noreferrer" className={"shrink-0 rounded-[8px] px-[11px] py-[5px] text-[11px] font-bold transition " + (live ? "text-white" : "border")} style={live ? { background: "#12b06b" } : { color: "#14563c", borderColor: "#bfe3cf", background: "#f5f9f6" }}>
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

function AttendeeLine({ attendees }: { attendees: Attendee[] }) {
  const [expanded, setExpanded] = useState(false);
  const CUTOFF = 4;
  const ordered = attendees.slice().sort((a, b) => {
    if (a.organizer !== b.organizer) return a.organizer ? -1 : 1;
    if (a.self !== b.self) return a.self ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const label = (a: Attendee) => a.name + (a.organizer ? " (organizer)" : "");
  const hidden = ordered.length - CUTOFF;
  const collapse = !expanded && hidden >= 2; // only truncate when 2+ hidden

  if (!collapse) {
    return (
      <span className="min-w-0 text-[11.5px] leading-[1.5] text-[#6d7b74]">
        {ordered.map(label).join(", ")}
        {expanded && hidden >= 2 && (
          <button type="button" onClick={() => setExpanded(false)} className="ml-1 font-semibold text-[#14563c] underline">show less</button>
        )}
      </span>
    );
  }
  return (
    <span className="min-w-0 truncate text-[11.5px] leading-[1.5] text-[#6d7b74]">
      {ordered.slice(0, CUTOFF).map(label).join(", ")}
      <button type="button" onClick={() => setExpanded(true)} className="ml-1 font-semibold text-[#14563c] underline">+{hidden} more</button>
    </span>
  );
}

function Badge({ text, bg, fg }: { text: string; bg: string; fg: string }) {
  return (
    <span className="shrink-0 rounded-full px-[7px] py-[1px] text-[9.5px] font-black uppercase tracking-wide" style={{ background: bg, color: fg }}>
      {text}
    </span>
  );
}

function Line({ text }: { text: string }) {
  return <div className="px-[18px] py-[13px] text-[12px] font-semibold text-[#6d7b74]">{text}</div>;
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
