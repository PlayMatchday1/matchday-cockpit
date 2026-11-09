"use client";

/* COVER PHOTO ON CREATE AND COPY (Ryan, 2026-11-09). Duplicate fields existed only because a field had one
 * photo; a match can now use any of its field's covers, so the editor offers that choice before the match
 * exists. Master Schedule's "New match on a field…" and Copy both open the editor in create mode.
 *
 * THE COVER IS ITS OWN WRITE, AFTER THE CREATE. A cover belongs to one field and is set on a match id
 * (PUT /api/covers/matches/{id}), so it can only be sent once the create has LANDED. The editor sends it
 * then, and the result rides to the new match's page (sessionStorage, per match id), where the match's
 * cover field shows what actually stuck.
 *
 * A COPY STARTS ON THE SOURCE'S COVER when the source is on the same field; changing the field puts the
 * choice back on Default, because the other field's covers are not this field's. */

import { useEffect, useState } from "react";
import type { FieldCovers, MatchCover } from "@/lib/fieldCovers";
import { coversGetJson, useCoversStatus } from "./coversClient";

type Opt = { id: number | null; name: string; url: string | null };

export default function NewMatchCoverPicker({ fieldId, sourceId, value, onChange }: {
  fieldId: number | null;
  /** Copy: the source match, whose cover is the starting choice when it is on the same field. */
  sourceId?: string | null;
  value: number | null;
  onChange: (coverId: number | null) => void;
}) {
  const status = useCoversStatus();
  const [opts, setOpts] = useState<Opt[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [source, setSource] = useState<MatchCover | null>(null);

  useEffect(() => {
    if (!status?.available || !sourceId) return;
    let alive = true;
    void coversGetJson<MatchCover>(`/api/covers/matches/${encodeURIComponent(sourceId)}`).then((r) => { if (alive && r.ok) setSource(r.data); });
    return () => { alive = false; };
  }, [status?.available, sourceId]);

  useEffect(() => {
    setOpts(null); setErr(null);
    if (!status?.available || !fieldId) return;
    let alive = true;
    void coversGetJson<FieldCovers>(`/api/covers/fields/${fieldId}`).then((r) => {
      if (!alive) return;
      if (!r.ok) { setErr(r.error); return; }
      setOpts([{ id: null, name: "Default", url: r.data.default.url }, ...r.data.covers.map((c) => ({ id: c.id, name: c.name, url: c.url }))]);
    });
    return () => { alive = false; };
  }, [status?.available, fieldId]);

  // The copy's starting choice, once both reads are in; Default when the source is on another field.
  useEffect(() => {
    if (!source || !opts || !fieldId) return;
    const sourceCover = source.fieldId === fieldId ? (source.cover?.id ?? null) : null;
    if (sourceCover != null && opts.some((o) => o.id === sourceCover)) onChange(sourceCover);
    // run once per (source, field) pair
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, opts, fieldId]);

  if (!status?.available) return null;
  const chosen = opts?.find((o) => o.id === value) ?? opts?.[0] ?? null;
  return (
    <div className="ncp" data-testid="new-match-cover">
      <label className="ncpLabel" htmlFor="ncp-select">Cover photo</label>
      {!fieldId ? (
        <div className="ncpNote">Pick a field first: a cover belongs to one field.</div>
      ) : err ? (
        <div className="ncpNote">Couldn&apos;t read this field&apos;s covers ({err}). The match will use the field&apos;s Default.</div>
      ) : !opts ? (
        <div className="ncpNote">Loading covers…</div>
      ) : (
        <div className="ncpRow">
          {chosen?.url ? <img className="ncpThumb" src={chosen.url} alt="" /> : <span className="ncpThumb ncpNone">No photo</span>}
          <div className="ncpCtl">
            <select id="ncp-select" value={value ?? ""} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
              {opts.map((o) => <option key={o.id ?? "default"} value={o.id ?? ""}>{o.name}</option>)}
            </select>
            <div className="ncpNote">
              Set right after the match is created.{" "}
              <a href={`/match-ops/fields?field=${fieldId}`} target="_blank" rel="noreferrer">Add a cover on this field</a>
              {" "}(opens in a new tab; come back and pick it here).
            </div>
          </div>
        </div>
      )}
      <style>{`
        .ncp { margin-top: 12px; }
        .ncpLabel { display: block; font-size: 12px; font-weight: 700; margin-bottom: 6px; }
        .ncpRow { display: flex; gap: 12px; align-items: flex-start; }
        .ncpThumb { width: 96px; height: 54px; object-fit: cover; border-radius: 6px; border: 1px solid rgba(7,42,32,.12); flex: none; }
        .ncpNone { display: inline-flex; align-items: center; justify-content: center; font-size: 11px; color: #5b6b63; }
        .ncpCtl { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
        .ncpNote { font-size: 12px; color: #5b6b63; }
      `}</style>
    </div>
  );
}

/* THE HAND-OFF to the new match's page. Per match id, read once, then cleared. Storage can be missing or
 * throw (private windows); the cover field on the page still shows what the match has. */
const KEY = (id: number | string) => `clubhouse:new-match-cover:${id}`;
export function rememberNewMatchCover(id: number, line: string, ok: boolean): void {
  try { sessionStorage.setItem(KEY(id), JSON.stringify({ line, ok })); } catch { /* the page still shows the cover */ }
}
export function takeNewMatchCover(id: number | string): { line: string; ok: boolean } | null {
  try {
    const raw = sessionStorage.getItem(KEY(id));
    if (!raw) return null;
    sessionStorage.removeItem(KEY(id));
    return JSON.parse(raw) as { line: string; ok: boolean };
  } catch { return null; }
}
