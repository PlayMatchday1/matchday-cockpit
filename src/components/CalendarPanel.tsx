"use client";

// "This week" meetings card — structure/wording/rules ported verbatim from
// mockups/week-v1.html. Real data from /api/calendar/week (server route, service
// role, filtered to the caller). One 30s clock; every phase + countdown derives
// from it. The next meeting is promoted IN PLACE inside the list (mint wash + mint
// left rule + larger title) exactly once — no separate pinned block. Times render
// from start_utc in America/Chicago; start_tz never drives display.

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
const key = (m: Meeting) => `${m.ical_uid} ${m.start_utc}`;
const fmtTime = (ms: number) => new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }).format(new Date(ms));
const dayKey = (ms: number) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
const dayName = (ms: number) => new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "long", month: "short", day: "numeric" }).format(new Date(ms));
const weekdayLong = (ms: number) => new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "long" }).format(new Date(ms));

type Phase = "live" | "ended" | "upcoming" | "allday";
function phaseOf(m: Meeting, now: number): Phase {
  const start = Date.parse(m.start_utc);
  if (m.all_day) return dayKey(start) < dayKey(now) ? "ended" : "allday";
  const end = m.end_utc ? Date.parse(m.end_utc) : start + 3600_000;
  if (now >= start && now < end) return "live";
  if (end <= now) return "ended";
  return "upcoming";
}
function countdown(m: Meeting, now: number): string {
  const start = Date.parse(m.start_utc);
  const end = m.end_utc ? Date.parse(m.end_utc) : start + 3600_000;
  if (phaseOf(m, now) === "live") return `ends in ${Math.max(0, Math.round((end - now) / 60000))} min`;
  const mins = Math.round((start - now) / 60000);
  if (mins < 60) return `in ${Math.max(0, mins)} min`;
  if (dayKey(start) === dayKey(now)) return `in ${Math.round(mins / 60)} hours`;
  if (dayKey(start) === dayKey(now + 86400_000)) return `tomorrow ${fmtTime(start)}`;
  return `${weekdayLong(start)} ${fmtTime(start)}`;
}

export default function CalendarPanel() {
  const [data, setData] = useState<WeekResponse | null>(null);
  const [ui, setUi] = useState<"loading" | "error" | "ready">("loading");
  const [now, setNow] = useState(() => Date.now());
  const [view, setView] = useState<"today" | "week">("today");
  const [open, setOpen] = useState<Set<string>>(new Set()); // expanded fold day-keys
  const [expandWho, setExpandWho] = useState<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { data: sess } = await supabase.auth.getSession();
        const token = sess.session?.access_token;
        if (!token) throw new Error("no session");
        const res = await fetch("/api/calendar/week", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (alive) {
          setData((await res.json()) as WeekResponse);
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
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const meetings = (data?.meetings ?? []).slice().sort((a, b) => Date.parse(a.start_utc) - Date.parse(b.start_utc));
  const live = meetings.find((m) => phaseOf(m, now) === "live");
  const next = meetings.find((m) => phaseOf(m, now) === "upcoming"); // non-all-day upcoming
  const hero = live ?? next ?? null; // exactly one promoted row, or none
  const heroKey = hero ? key(hero) : null;
  const allEnded = meetings.length > 0 && meetings.every((m) => phaseOf(m, now) === "ended");

  const toggleWho = (k: string) => setExpandWho((s) => new Set(s).add(k));
  // Round-trips: Show adds, Hide removes — the day collapses back to the fold bar
  // with its count intact (nothing about the underlying list changed).
  const toggleDay = (dk: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(dk)) n.delete(dk);
      else n.add(dk);
      return n;
    });

  // Group visible meetings by Chicago day.
  const days = new Map<string, Meeting[]>();
  for (const m of meetings) {
    const dk = dayKey(Date.parse(m.start_utc));
    if (view === "today" && dk !== dayKey(now)) continue;
    (days.get(dk) ?? days.set(dk, []).get(dk)!).push(m);
  }
  const todayK = dayKey(now);
  const dayKeys = [...days.keys()].sort();

  return (
    <div className="twc">
      <style>{CSS}</style>
      <div className="card">
        <div className="chead">
          <div className="ctitle">This week</div>
          {ui === "ready" && data?.grantConfigured && data?.syncHasRun && (
            <div className="seg">
              <button type="button" className={view === "today" ? "on" : ""} onClick={() => setView("today")}>Today</button>
              <button type="button" className={view === "week" ? "on" : ""} onClick={() => setView("week")}>This week</button>
            </div>
          )}
        </div>

        <div>
          {ui === "loading" && <div className="empty"><b>Loading your week…</b></div>}
          {ui === "error" && <div className="empty"><b>Couldn’t load your calendar</b>Refresh to try again.</div>}
          {ui === "ready" && data && (
            !data.grantConfigured ? (
              <div className="empty"><b>Calendar not connected</b>A Workspace admin needs to authorize Calendar access.</div>
            ) : !data.syncHasRun ? (
              <div className="empty"><b>Connected · sync hasn’t run yet</b>Meetings appear after the first sync.</div>
            ) : days.size === 0 ? (
              <div className="empty">
                <b>Nothing on the calendar today</b>
                {next ? `Next up is ${next.summary || "(no title)"}, ${countdown(next, now)}.` : "Nothing left this week either."}
              </div>
            ) : (
              <>
                {dayKeys.map((dk) => {
                  const list = days.get(dk)!;
                  const foldable = view === "week" && dk < todayK;
                  const folded = foldable && !open.has(dk);
                  if (folded) {
                    return (
                      <button key={dk} type="button" className="folded" onClick={() => toggleDay(dk)}>
                        <span className="fv">▶</span>
                        <span className="fl">{dayName(Date.parse(list[0].start_utc))}</span>
                        <span className="fc">{list.length} {list.length === 1 ? "meeting" : "meetings"} hidden</span>
                        <span className="fx">Show</span>
                      </button>
                    );
                  }
                  return (
                    <div key={dk}>
                      <div className="day">
                        <span className="dlabel">{dayName(Date.parse(list[0].start_utc))}</span>
                        {dk === todayK && <span className="dchip">Today</span>}
                        <hr />
                        {/* Only an expanded ELAPSED day is foldable → gets a Hide. Today/future never do. */}
                        {foldable && <button type="button" className="dhide" onClick={() => toggleDay(dk)}>Hide</button>}
                      </div>
                      <div className="rows">
                        {list.map((m) => (
                          <Row key={key(m)} m={m} now={now} isHero={key(m) === heroKey} expandWho={expandWho.has(key(m))} onWho={() => toggleWho(key(m))} />
                        ))}
                      </div>
                    </div>
                  );
                })}
                {allEnded && <div className="empty"><b>All done for the week</b>Nothing left on the calendar.</div>}
              </>
            )
          )}
        </div>

        <div className="note">
          Only meetings with <b>2 or more people</b> are ever stored. Anything you mark <b>Private</b> in Google Calendar is skipped
          entirely. Descriptions and locations are never saved.
        </div>
      </div>
    </div>
  );
}

function Row({ m, now, isHero, expandWho, onWho }: { m: Meeting; now: number; isHero: boolean; expandWho: boolean; onWho: () => void }) {
  const p = phaseOf(m, now);
  const ended = p === "ended";
  return (
    <div className={`row${ended ? " ended" : ""}${isHero ? " live" : ""}`} data-id={key(m)}>
      <div className="time">{m.all_day ? "All day" : fmtTime(Date.parse(m.start_utc))}</div>
      <div>
        <div className="title">
          {m.summary || "(no title)"}
          {isHero && <span className="badge">{p === "live" ? "Now" : "Next up"} · {countdown(m, now)}</span>}
          {p === "allday" && <span className="allday">All day</span>}
        </div>
        <div className="who"><Who attendees={m.attendees} expanded={expandWho} onExpand={onWho} /></div>
      </div>
      {m.meet_url && !ended ? (
        <a className="join" href={m.meet_url} target="_blank" rel="noopener noreferrer">Join</a>
      ) : (
        <span className="joinpad" />
      )}
    </div>
  );
}

function Who({ attendees, expanded, onExpand }: { attendees: Attendee[]; expanded: boolean; onExpand: () => void }) {
  const CAP = 4;
  const ordered = attendees.slice().sort((a, b) => {
    if (a.organizer !== b.organizer) return a.organizer ? -1 : 1;
    if (a.self !== b.self) return a.self ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const hidden = ordered.length - CAP;
  const showAll = expanded || hidden <= 1; // never hide exactly one
  const shown = showAll ? ordered : ordered.slice(0, CAP);
  return (
    <>
      {shown.map((a, i) => (
        <span key={a.email}>
          {i > 0 && ", "}
          {a.name}
          {a.organizer && <> <b>(organizer)</b></>}
        </span>
      ))}
      {!showAll && (
        <>
          {" "}
          <button type="button" className="more" onClick={onExpand}>+{hidden} more</button>
        </>
      )}
    </>
  );
}

const CSS = `
.twc{--forest:#003326;--ink:#0d1f18;--muted:#5C6B62;--faint:#67746C;--paper:#fff;
  --line:#E3E8E0;--slot:#F7F9F6;--mint:#2CDB87;--mintSoft:#E9FAF1;--mintEdge:#B6E9CE;--mintInk:#046B45;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Helvetica,Arial,sans-serif;color:var(--ink)}
.twc *{box-sizing:border-box}
.twc .card{background:var(--paper);border:1px solid var(--line);border-radius:16px;box-shadow:0 9px 26px rgba(0,51,38,.075);overflow:hidden}
.twc .chead{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:16px 20px;border-bottom:1px solid var(--line)}
.twc .ctitle{font-size:15.5px;font-weight:900;letter-spacing:-.2px;color:var(--forest)}
.twc .seg{display:inline-flex;background:var(--slot);border:1px solid var(--line);border-radius:99px;padding:3px}
.twc .seg button{border:0;background:transparent;color:var(--muted);font-family:inherit;font-size:11.5px;font-weight:850;padding:6px 15px;border-radius:99px;cursor:pointer;white-space:nowrap}
.twc .seg button.on{background:var(--forest);color:#fff}
.twc .day{display:flex;align-items:center;gap:10px;padding:13px 20px 9px;background:var(--paper)}
.twc .dlabel{font-size:10px;font-weight:900;letter-spacing:1px;text-transform:uppercase;color:var(--muted)}
.twc .dchip{font-size:9px;font-weight:900;letter-spacing:.7px;text-transform:uppercase;color:var(--mintInk);background:var(--mintSoft);border:1px solid var(--mintEdge);border-radius:99px;padding:2px 8px}
.twc .day hr{flex:1;border:0;border-top:1px solid var(--line);margin:0}
.twc .dhide{flex:none;background:none;border:0;padding:0;font-family:inherit;font-size:10px;font-weight:900;letter-spacing:.5px;text-transform:uppercase;color:var(--mintInk);cursor:pointer;text-decoration:underline;text-underline-offset:2px}
.twc .folded{display:flex;align-items:center;gap:9px;width:100%;text-align:left;cursor:pointer;font-family:inherit;background:var(--slot);border:0;border-top:1px solid var(--line);padding:12px 20px}
.twc .folded:hover{background:#EFF3EE}
.twc .folded .fv{color:var(--mintInk);font-size:10px;font-weight:900;flex:none}
.twc .folded .fl{font-size:10px;font-weight:900;letter-spacing:1px;text-transform:uppercase;color:var(--muted)}
.twc .folded .fc{font-size:11.5px;font-weight:850;color:var(--mintInk);margin-left:1px}
.twc .folded .fx{margin-left:auto;font-size:11px;font-weight:900;color:var(--mintInk);border:1px solid var(--mintEdge);background:#fff;border-radius:99px;padding:4px 12px}
.twc .row{display:grid;grid-template-columns:78px 1fr auto;gap:14px;align-items:start;padding:11px 20px;border-top:1px solid var(--line)}
.twc .row:first-child{border-top:0}
.twc .time{font-size:12px;font-weight:850;color:var(--ink);text-align:right;padding-top:2px;font-variant-numeric:tabular-nums;white-space:nowrap}
.twc .title{font-size:13.5px;font-weight:850;color:var(--forest);line-height:1.3}
.twc .who{font-size:11.5px;color:var(--muted);line-height:1.45;margin-top:3px}
.twc .who b{font-weight:800;color:var(--muted)}
.twc .more{background:none;border:0;padding:0;font:inherit;font-size:11.5px;font-weight:850;color:var(--mintInk);cursor:pointer;text-decoration:underline;text-underline-offset:2px}
.twc .join{display:inline-flex;align-items:center;justify-content:center;background:var(--mint);border:1px solid #16C275;color:#00291E;font-family:inherit;font-size:11.5px;font-weight:900;border-radius:99px;padding:6px 15px;cursor:pointer;text-decoration:none;white-space:nowrap}
.twc .join:hover{background:#25CE7E}
.twc .joinpad{width:63px}
.twc .row.ended .time,.twc .row.ended .title,.twc .row.ended .who{color:var(--faint)}
.twc .row.ended .title{font-weight:800}
.twc .row.live{background:var(--mintSoft);box-shadow:inset 3px 0 0 var(--mint)}
.twc .row.live .title{font-size:14.5px}
.twc .badge{display:inline-block;margin-left:8px;font-size:9px;font-weight:900;letter-spacing:.8px;text-transform:uppercase;color:#fff;background:var(--mintInk);border-radius:99px;padding:3px 9px;vertical-align:2px;white-space:nowrap}
.twc .allday{display:inline-block;margin-left:7px;font-size:9px;font-weight:900;letter-spacing:.6px;text-transform:uppercase;color:#7A5200;background:#FFF6D6;border-radius:99px;padding:2px 7px;vertical-align:1.5px}
.twc .empty{padding:26px 20px;text-align:center;font-size:12.5px;color:var(--muted);line-height:1.6}
.twc .empty b{display:block;font-size:13.5px;font-weight:900;color:var(--forest);margin-bottom:4px}
.twc .note{margin:14px 20px 18px;padding:11px 14px;background:var(--slot);border:1px solid var(--line);border-radius:11px;font-size:11px;color:var(--muted);line-height:1.55}
.twc .note b{color:var(--forest);font-weight:850}
`;
