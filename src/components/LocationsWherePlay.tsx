"use client";

// WHERE THEY PLAY — one table, two homes: the Map tab's bubble card and the Overview's expanded player
// row. Every number arrives computed (src/lib/wherePlayed.ts on the server); this only lays it out.

import { useState } from "react";
import type { BubblePlays, PlayField } from "@/lib/wherePlayed";

const TOP = 6;
const mi = (n: number | null) => (n == null ? "—" : `${n < 10 ? n.toFixed(1) : Math.round(n)} mi`);
// A match day is its LOCAL calendar day, formatted at UTC noon so no time zone can move it.
const fmtDay = (ymd: string) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).format(new Date(`${ymd}T12:00:00Z`));

export default function LocationsWherePlay({ plays, fieldById, outsideView }: {
  plays: BubblePlays;
  fieldById: Map<number, PlayField>;
  /** True for a field that is not on the map as it stands (another city, or off screen). */
  outsideView?: (f: PlayField | undefined, fieldId: number) => boolean;
}) {
  const [all, setAll] = useState(false);
  const group = plays.players > 1;
  if (plays.matches === 0) {
    return (
      <div className="lw" data-testid="where-play">
        <style>{CSS}</style>
        <div className="lw-title">Where they play</div>
        <div className="lw-empty" data-testid="where-play-none">{group ? "None of these players has played a match yet." : "Has not played a match yet."}</div>
      </div>
    );
  }
  const max = Math.max(...plays.fields.map((f) => f.matches));
  const rows = all ? plays.fields : plays.fields.slice(0, TOP);
  return (
    <div className="lw" data-testid="where-play">
      <style>{CSS}</style>
      <div className="lw-title">Where they play</div>
      <table className="lw-table">
        <tbody>
          {rows.map((r) => {
            const f = fieldById.get(r.fieldId);
            const out = outsideView ? outsideView(f, r.fieldId) : false;
            return (
              <tr key={r.fieldId} data-testid="where-play-row">
                <td className="lw-name">
                  {f?.title ?? `Field ${r.fieldId}`}
                  {f?.closed && <span className="lw-tag">closed</span>}
                  {out && <span className="lw-tag lw-tag-out">outside this view</span>}
                </td>
                <td className="lw-barcell"><span className="lw-bar" style={{ width: `${Math.max(4, Math.round((r.matches / max) * 100))}%` }} /></td>
                <td className="lw-n">
                  {r.matches}
                  {group && <span className="lw-sub">{r.players} of {plays.players} players</span>}
                </td>
                <td className="lw-mi">{mi(r.mi)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {plays.fields.length > TOP && (
        <button type="button" className="lw-more" onClick={() => setAll((a) => !a)} data-testid="where-play-more">
          {all ? "Show fewer" : `Show all ${plays.fields.length}`}
        </button>
      )}
      <div className="lw-summary" data-testid="where-play-summary">
        {plays.matches} {plays.matches === 1 ? "match" : "matches"}
        {group ? `, ${plays.playersPlayed} of ${plays.players} players` : ""}
        {plays.medianMi != null ? ` · typical travel ${mi(plays.medianMi)}` : ""}
        {plays.lastDay ? ` · last match ${fmtDay(plays.lastDay)}` : ""}
      </div>
    </div>
  );
}

const CSS = `
.lw{margin-top:10px}
.lw-title{font-size:10px;font-weight:900;letter-spacing:.7px;text-transform:uppercase;color:var(--muted);margin-bottom:6px}
.lw-empty{font-size:12.5px;color:var(--muted)}
.lw-table{width:100%;border-collapse:collapse;font-size:12.5px;table-layout:fixed}
.lw-table td{padding:5px 4px;border-bottom:1px solid #EEF2EC;vertical-align:middle}
.lw-name{width:46%;word-break:break-word;color:var(--ink)}
.lw-barcell{width:24%}
.lw-bar{display:block;height:8px;border-radius:3px;background:#0b7d55}
.lw-n{width:16%;text-align:right;font-weight:800;font-variant-numeric:tabular-nums;color:var(--forest)}
.lw-mi{width:14%;text-align:right;color:var(--muted);white-space:nowrap;font-variant-numeric:tabular-nums}
.lw-sub{display:block;font-size:10.5px;font-weight:600;color:var(--muted);white-space:nowrap}
.lw-tag{display:inline-block;margin-left:6px;font-size:10px;font-weight:800;color:#6b5600;background:#FFF3C4;border-radius:4px;padding:0 5px;vertical-align:1px}
.lw-tag-out{color:#33403a;background:#E8ECE9}
.lw-more{margin-top:6px;border:0;background:none;padding:0;font:inherit;font-size:12px;font-weight:700;color:var(--forest);text-decoration:underline;cursor:pointer}
.lw-summary{margin-top:6px;font-size:12px;color:var(--ink)}
`;
