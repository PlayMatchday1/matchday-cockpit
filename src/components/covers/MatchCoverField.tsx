"use client";

/* COVER PHOTO — the match panel field (Figma 19442-44, without "Auto": a match uses Default or one of its own
 * field's covers, nothing else).
 *
 * ITS OWN COMMIT, NOT PART OF THE PANEL'S SAVE. The panel stages match fields and sends the diff; a cover is a
 * separate endpoint, so this field has its own Save, and the panel's Save/Revert never touch it.
 *
 * AFTER A COVER LANDS it offers the upcoming matches at the same field, weekday and start time (the backend's
 * sameSlotUpcoming), all ticked, to apply the same cover in one all-or-nothing batch. Each is read back.
 *
 * A FIELD CHANGE CLEARS THE COVER (backend rule: covers belong to a field). While the panel's field is changed but
 * not saved, Change is greyed with that reason. Renders nothing while the backend half is unavailable. */

import { useCallback, useEffect, useState } from "react";
import { plural, wallClockLabel, type MatchCover } from "@/lib/fieldCovers";
import { coversGetJson, coversWrite, useCoversStatus } from "./coversClient";
import { COVER_CSS } from "./coverCss";

const NO_EDIT = "Changing a match's cover photo needs EDIT MATCHES.";
const FIELD_DIRTY = "Save the field change first: a cover belongs to one field, and moving the match puts it back on Default.";

export default function MatchCoverField({ matchId, fieldDirty = false, manageHref }: {
  matchId: number;
  /** The host panel's field select is changed and unsaved. */
  fieldDirty?: boolean;
  /** Where "Manage covers on the field" goes. Absent: no link. */
  manageHref?: (fieldId: number) => string;
}) {
  const status = useCoversStatus();
  const [data, setData] = useState<MatchCover | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState<number | null | undefined>(undefined); // undefined = no change staged
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [apply, setApply] = useState<{ coverId: number | null; coverName: string; ids: Set<number> } | null>(null);

  const load = useCallback(async () => {
    const r = await coversGetJson<MatchCover>(`/api/covers/matches/${matchId}`);
    if (r.ok) { setData(r.data); setErr(null); } else setErr(r.error);
    return r.ok ? r.data : null;
  }, [matchId]);
  useEffect(() => { if (status?.available) void load(); }, [status?.available, load]);

  if (!status?.available) return null;
  const canEdit = status.canEdit;
  const blocked = !canEdit ? NO_EDIT : fieldDirty ? FIELD_DIRTY : null;
  const currentId = data?.cover?.id ?? null;
  const chosen = pick === undefined ? currentId : pick;
  const opt = data?.options.find((o) => o.id === chosen) ?? null;

  async function save() {
    if (!data || pick === undefined || busy) return;
    const name = data.options.find((o) => o.id === pick)?.name ?? "Default";
    setBusy(true);
    try {
      const res = await coversWrite(`/api/covers/matches/${matchId}`, { method: "PUT", json: { coverId: pick } }, `the cover is ${name}`);
      if (res.body.match) setData(res.body.match as MatchCover);
      setMsg({ text: res.line, ok: res.verdict === "LANDED" });
      if (res.verdict === "LANDED") {
        setPick(undefined); setOpen(false);
        const fresh = (res.body.match as MatchCover | undefined) ?? data;
        // Offer only the matches that are not already on this cover.
        const offer = fresh.sameSlotUpcoming.filter((m) => (m.cover?.id ?? null) !== pick);
        setApply(offer.length ? { coverId: pick, coverName: name, ids: new Set(offer.map((m) => m.id)) } : null);
      }
    } finally { setBusy(false); }
  }

  async function applyToOthers() {
    if (!apply || !apply.ids.size || busy) return;
    setBusy(true);
    try {
      const ids = [...apply.ids];
      const res = await coversWrite("/api/covers/matches", { method: "PUT", json: { matchIds: ids, coverId: apply.coverId } },
        `${plural(ids.length, "more match", "more matches")} on ${apply.coverName}`);
      setMsg({ text: res.line, ok: res.verdict === "LANDED" });
      if (res.verdict === "LANDED") setApply(null);
      await load();
    } finally { setBusy(false); }
  }

  const offerRows = apply && data ? data.sameSlotUpcoming.filter((m) => (m.cover?.id ?? null) !== apply.coverId || apply.ids.has(m.id)) : [];

  return (
    <div className="fc" data-testid="fc-match-cover" data-match-id={matchId}>
      <style>{COVER_CSS}</style>
      <div className="fc-lb">COVER PHOTO <span className="fc-new">NEW</span></div>
      {err && <p className="fc-verdict bad" data-testid="fc-match-load-error">Couldn&rsquo;t load the cover: {err}</p>}
      {data && (
        <>
          <div className="fc-pick" data-testid="fc-match-current" data-cover-id={currentId ?? "default"}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={opt?.url ?? data.coverUrl ?? ""} alt="" />
            <div className="fc-t">
              <b data-testid="fc-match-cover-name">{opt?.name ?? data.cover?.name ?? "Default"}{pick !== undefined && pick !== currentId ? " (not saved)" : ""}</b>
              <span data-testid="fc-match-cover-sub">{chosen === null ? "The field's main cover"
                : data.cover?.removed && pick === undefined ? "Removed from the field. This match has been played, so it keeps the photo."
                : `A cover of ${data.fieldTitle}`}</span>
            </div>
            <button type="button" className="fc-link" disabled={!!blocked || busy} title={blocked ?? undefined}
              onClick={() => { setMsg(null); setApply(null); setOpen(!open); }} data-testid="fc-match-change">Change ▾</button>
          </div>
          {blocked && <p className="fc-why" data-testid="fc-match-blocked">{blocked}</p>}
          {open && !blocked && (
            <div className="fc-opts" data-testid="fc-match-options">
              {data.options.map((o) => (
                <button type="button" key={o.id ?? "default"} className={"fc-opt" + (o.id === chosen ? " on" : "")}
                  data-testid="fc-match-option" data-cover-id={o.id ?? "default"} onClick={() => setPick(o.id === currentId ? undefined : o.id)}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={o.url ?? ""} alt="" />
                  <div><b>{o.name}</b><span>{o.id === null ? "The field's main cover" : `Cover for ${data.fieldTitle}`}</span></div>
                  {o.id === chosen && <span className="fc-tick">✓</span>}
                </button>
              ))}
              <div className="fc-opts-f">
                <button type="button" className="fc-btn pri" disabled={pick === undefined || busy} onClick={() => void save()} data-testid="fc-match-save">
                  {busy ? "Saving…" : "Save cover"}</button>
                <button type="button" className="fc-btn" disabled={busy} onClick={() => { setPick(undefined); setOpen(false); }}>Cancel</button>
                {manageHref && <a href={manageHref(data.fieldId)} data-testid="fc-match-manage">Manage covers on the field ›</a>}
              </div>
            </div>
          )}
          {!open && manageHref && <p className="fc-why"><a className="fc-link" href={manageHref(data.fieldId)} data-testid="fc-match-manage">Manage covers on the field ›</a></p>}
          {apply && offerRows.length > 0 && (
            <div className="fc-apply" data-testid="fc-apply">
              <b>Apply to other upcoming matches?</b>
              <div className="fc-why">Same field, same weekday and start time. Uncheck any to leave as they are.</div>
              <ul>
                {offerRows.map((m) => (
                  <li key={m.id}><label>
                    <input type="checkbox" data-testid="fc-apply-row" data-match-id={m.id} checked={apply.ids.has(m.id)}
                      onChange={(e) => { const ids = new Set(apply.ids); if (e.target.checked) ids.add(m.id); else ids.delete(m.id); setApply({ ...apply, ids }); }} />
                    <span>{wallClockLabel(m.startDate)} · {m.name}</span> <em>now {m.cover?.name ?? "Default"} · ID {m.id}</em>
                  </label></li>
                ))}
              </ul>
              <div className="fc-acts" style={{ display: "flex", gap: 8 }}>
                <button type="button" className="fc-btn pri" disabled={!apply.ids.size || busy} onClick={() => void applyToOthers()} data-testid="fc-apply-go">
                  {busy ? "Applying…" : `Apply to ${plural(apply.ids.size, "match", "matches")}`}</button>
                <button type="button" className="fc-btn" disabled={busy} onClick={() => setApply(null)} data-testid="fc-apply-skip">Not now</button>
              </div>
            </div>
          )}
        </>
      )}
      {msg && <p className={"fc-verdict" + (msg.ok ? " ok" : " bad")} data-testid="fc-match-msg">{msg.text}</p>}
    </div>
  );
}
