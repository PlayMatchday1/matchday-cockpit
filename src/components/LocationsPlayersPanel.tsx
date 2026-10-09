"use client";

// PLAYERS IN THIS AREA — under the Map tab, ADMIN ONLY (the route refuses anyone else, and the tab
// does not render this for them). Follows the map's selection: nothing selected = the city (or all
// cities), a bubble = its players, a field = the players within the current reach of it. The tab
// works out WHICH players; this filters, lists and exports them.

import { useMemo, useState } from "react";
import { downloadCsv } from "@/components/growth/format";
import { klaviyoRows, type AreaPlayer } from "@/lib/areaPlayers";
import { ACTIVITIES, ACTIVITY_FILL, ACTIVITY_LABEL, ACTIVITY_SHORT, type Activity } from "@/lib/wherePlayed";

// A match day is its LOCAL calendar day, formatted at UTC noon so no time zone can move it.
const fmtDay = (ymd: string | null) => (ymd ? new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).format(new Date(`${ymd}T12:00:00Z`)) : "—");
const players = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "player" : "players"}`;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "area";

export default function LocationsPlayersPanel({ title, rows, loading, error }: {
  /** The area's name: "Zip 78738", "Within 10 mi of PARMER Stadium", "Austin", "All cities". */
  title: string;
  /** Everyone in the area, before this panel's own filters. */
  rows: AreaPlayer[];
  loading: boolean;
  error: string | null;
}) {
  const [act, setAct] = useState<Activity | "all">("all");
  const [member, setMember] = useState<"all" | "yes" | "no">("all");
  const shown = useMemo(() => rows
    .filter((r) => (act === "all" || r.activity === act) && (member === "all" || r.member === (member === "yes")))
    .sort((a, b) => (b.lastPlayed ?? "").localeCompare(a.lastPlayed ?? "") || b.matches - a.matches
      || `${a.lastName ?? ""} ${a.firstName ?? ""}`.localeCompare(`${b.lastName ?? ""} ${b.firstName ?? ""}`)), [rows, act, member]);
  const filtered = act !== "all" || member !== "all";

  return (
    <div className="lp" data-testid="area-players">
      <style>{CSS}</style>
      <div className="lp-head">
        <div>
          <div className="lp-kicker">Players in this area</div>
          <div className="lp-title" data-testid="area-players-title">{title}, {loading ? "loading…" : players(rows.length)}</div>
          {filtered && !loading && <div className="lp-sub" data-testid="area-players-shown">{players(shown.length)} match the filters</div>}
        </div>
        <button type="button" className="loc-btn lp-export" data-testid="area-players-export" disabled={loading || shown.length === 0}
          title={shown.length === 0 ? "No players to export" : "CSV for a Klaviyo list import: first_name, last_name, email, phone_number (E.164), zip, city, state, last_played, activity_bucket, matches_played, favourite_field, member"}
          onClick={() => downloadCsv(`players-${slug(title)}-${new Date().toISOString().slice(0, 10)}.csv`, klaviyoRows(shown))}>
          Export CSV for Klaviyo ({shown.length.toLocaleString("en-US")})
        </button>
      </div>

      <div className="lp-filters">
        <div className="lm-seg lm-seg-wrap" role="group" aria-label="Activity">
          {(["all", ...ACTIVITIES] as const).map((k) => (
            <button type="button" key={k} aria-pressed={act === k} data-testid={`ap-act-${k}`} title={k === "all" ? "Any activity" : ACTIVITY_LABEL[k]}
              className={"lm-seg-btn" + (act === k ? " lm-seg-on" : "")} onClick={() => setAct(k)}>
              {k !== "all" && <i className="lm-swatch" style={{ background: ACTIVITY_FILL[k] }} />}{k === "all" ? "All" : ACTIVITY_SHORT[k]}
            </button>
          ))}
        </div>
        <div className="lm-seg" role="group" aria-label="Member">
          {([["all", "Everyone"], ["yes", "Members"], ["no", "Not members"]] as const).map(([k, l]) => (
            <button type="button" key={k} aria-pressed={member === k} data-testid={`ap-mem-${k}`}
              className={"lm-seg-btn" + (member === k ? " lm-seg-on" : "")} onClick={() => setMember(k)}>{l}</button>
          ))}
        </div>
      </div>

      {error ? (
        <div className="lp-empty">Couldn&apos;t load players: {error}</div>
      ) : loading ? (
        <div className="lp-empty">Loading players…</div>
      ) : shown.length === 0 ? (
        <div className="lp-empty" data-testid="area-players-none">{rows.length === 0 ? "No players with a location here." : "No players match these filters."}</div>
      ) : (
        <div className="lp-scroll">
          <table className="lp-table" data-testid="area-players-table">
            <thead>
              <tr>
                <th>Name</th><th>Email</th><th>Phone</th><th>Area</th><th>Zip</th><th>City</th>
                <th>Last played</th><th>Activity</th><th className="loc-num">Matches</th><th>Favourite field</th><th>Member</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} data-testid="area-player-row">
                  <td className="lp-name">{[r.firstName, r.lastName].filter(Boolean).join(" ") || "—"}</td>
                  <td>{r.email ?? "—"}</td>
                  <td className="lp-nowrap">{r.phoneE164 ?? r.phone ?? "—"}</td>
                  <td>{r.area || "—"}{r.fromZip && <span className="lp-fromzip" title="MatchDay sent no coordinates; placed at the zip's Census centre">located from zip</span>}</td>
                  <td>{r.zip ?? "—"}</td>
                  <td>{r.city ? `${r.city}${r.state ? `, ${r.state}` : ""}` : "—"}</td>
                  <td className="lp-nowrap">{fmtDay(r.lastPlayed)}</td>
                  <td className="lp-nowrap"><i className="lm-swatch" style={{ background: ACTIVITY_FILL[r.activity] }} />{ACTIVITY_SHORT[r.activity]}</td>
                  <td className="loc-num">{r.matches}</td>
                  <td>{r.favouriteField ?? "—"}</td>
                  <td>{r.member ? "Member" : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const CSS = `
.lp{border-top:1px solid var(--line);padding:14px 20px 18px}
.lp-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap}
.lp-kicker{font-size:10px;font-weight:900;letter-spacing:.7px;text-transform:uppercase;color:var(--muted)}
.lp-title{font-size:15px;font-weight:900;color:var(--forest);margin-top:3px}
.lp-sub{font-size:12px;color:var(--muted);margin-top:2px}
.lp-export{white-space:nowrap}
.lp-filters{display:flex;gap:10px;flex-wrap:wrap;margin:12px 0 10px}
.lp-empty{font-size:12.5px;color:var(--muted);padding:6px 0}
.lp-scroll{overflow-x:auto;max-height:460px;overflow-y:auto;border:1px solid var(--line);border-radius:10px}
.lp-table{width:100%;border-collapse:collapse;font-size:12.5px}
.lp-table th{position:sticky;top:0;background:#FAFCFA;text-align:left;font-size:9.5px;font-weight:900;letter-spacing:.6px;text-transform:uppercase;color:var(--muted);padding:7px 8px;border-bottom:1px solid var(--line);white-space:nowrap}
.lp-table td{padding:7px 8px;border-bottom:1px solid #EEF2EC;vertical-align:top}
.lp-name{font-weight:700;color:var(--forest);white-space:nowrap}
.lp-nowrap{white-space:nowrap}
.lp-fromzip{display:inline-block;margin-left:6px;padding:0 6px;border-radius:99px;font-size:10.5px;font-weight:800;color:#6a4d00;background:#FFF4D6;border:1px solid #EBD9A0;white-space:nowrap}
@media (max-width:900px){ .lp{padding:12px 14px 16px} }
`;
