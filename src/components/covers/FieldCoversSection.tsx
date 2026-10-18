"use client";

/* COVER PHOTOS — the Field panel section (Figma 19442-44, minus its match-type logic: covers are NOT tied to
 * category or type, Ryan 2026-10-17).
 *
 *   Default    fields.cover_s3_key: every match on Default, and the Field Partners card. Replace only (the API has
 *              no delete for a field's cover).
 *   Extra      any number, each with a free-text name. Card: name, upcoming matches using it, Replace, Rename,
 *              Remove. Remove asks first, with a FRESH count of the upcoming matches that go back to Default.
 *
 * Writes need EDIT MATCHES; without it the controls are greyed with the reason (courtesy only: the route and the
 * write client both refuse). Renders nothing while the backend half is unavailable. */

import { useCallback, useEffect, useState } from "react";
import { coverNameProblem, plural, COVER_NAME_MAX, type CoverView, type FieldCovers } from "@/lib/fieldCovers";
import CoverUpload, { type UploadMode } from "./CoverUpload";
import { coversGetJson, coversWrite, useCoversStatus } from "./coversClient";
import { COVER_CSS } from "./coverCss";

const NO_EDIT = "Changing cover photos needs EDIT MATCHES.";

/* REMOVING A COVER (Ryan, 2026-10-18): upcoming matches go back to Default; matches that have already been played keep
 * it, so their history and old share links look as they did. Both sentences say so, with the two counts. */
function removeQuestion(upcoming: number, past: number): string {
  const up = upcoming === 0 ? "No upcoming match uses it." : `${plural(upcoming, "upcoming match goes", "upcoming matches go")} back to Default.`;
  const pastLine = past === 0 ? "" : ` ${plural(past, "past match keeps", "past matches keep")} it, so its history and old share links look the same.`;
  return up + pastLine;
}
function removedSummary(upcoming: number, past: number): string {
  return `${plural(upcoming, "upcoming match", "upcoming matches")} went back to Default${past ? `; ${plural(past, "past match keeps", "past matches keep")} it` : ""}.`;
}

export default function FieldCoversSection({ fieldId }: { fieldId: number }) {
  const status = useCoversStatus();
  const [data, setData] = useState<FieldCovers | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [upload, setUpload] = useState<{ mode: UploadMode; coverId?: number } | null>(null);
  const [renaming, setRenaming] = useState<{ id: number; name: string } | null>(null);
  const [confirm, setConfirm] = useState<{ cover: CoverView; upcoming: number | null; past?: number; error?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  const load = useCallback(async () => {
    const r = await coversGetJson<FieldCovers>(`/api/covers/fields/${fieldId}`);
    if (r.ok) { setData(r.data); setErr(null); } else setErr(r.error);
  }, [fieldId]);
  useEffect(() => { if (status?.available) void load(); }, [status?.available, load]);

  if (!status?.available) return null;
  const canEdit = status.canEdit;
  const say = (line: string, ok: boolean) => setMsg({ text: line, ok });

  async function submitUpload(file: File, name: string) {
    const u = upload!;
    const form = new FormData();
    form.set("file", file);
    let res;
    if (u.mode.kind === "add") {
      form.set("name", name);
      res = await coversWrite(`/api/covers/fields/${fieldId}`, { method: "POST", form }, `cover "${name}" added`);
    } else if (u.mode.kind === "replace") {
      form.set("fieldId", String(fieldId));
      res = await coversWrite(`/api/covers/covers/${u.coverId}`, { method: "PUT", form }, `the image of "${u.mode.coverName}" replaced`);
    } else {
      res = await coversWrite(`/api/covers/fields/${fieldId}/default`, { method: "PUT", form }, "the Default cover replaced");
    }
    if (res.body.covers) setData(res.body.covers as FieldCovers);
    say(res.line, res.verdict === "LANDED");
    return res;
  }

  async function saveRename() {
    if (!renaming || busy) return;
    const name = renaming.name.replace(/\s+/g, " ").trim();
    setBusy(true);
    try {
      const res = await coversWrite(`/api/covers/covers/${renaming.id}`, { method: "PATCH", json: { name, fieldId } }, `renamed to "${name}"`);
      if (res.body.covers) setData(res.body.covers as FieldCovers);
      say(res.line, res.verdict === "LANDED");
      if (res.verdict === "LANDED") setRenaming(null);
    } finally { setBusy(false); }
  }

  /* THE COUNT IS READ WHEN THE CONFIRMATION OPENS, not taken from the card, which may be minutes old. */
  async function askRemove(c: CoverView) {
    setConfirm({ cover: c, upcoming: null });
    const r = await coversGetJson<{ upcomingMatches: number; pastMatches: number }>(`/api/covers/covers/${c.id}?fieldId=${fieldId}`);
    setConfirm(r.ok ? { cover: c, upcoming: r.data.upcomingMatches, past: r.data.pastMatches } : { cover: c, upcoming: null, error: r.error });
  }

  async function doRemove() {
    if (!confirm || busy) return;
    setBusy(true);
    try {
      const res = await coversWrite(`/api/covers/covers/${confirm.cover.id}?fieldId=${fieldId}`, { method: "DELETE" }, `"${confirm.cover.name}" removed`);
      const reset = res.body.removed as { upcomingMatchesReset?: number; pastMatchesKept?: number } | null;
      if (res.body.covers) setData(res.body.covers as FieldCovers);
      say(res.verdict === "LANDED" && reset ? `${res.line} ${removedSummary(reset.upcomingMatchesReset ?? 0, reset.pastMatchesKept ?? 0)}` : res.line, res.verdict === "LANDED");
      setConfirm(null);
    } finally { setBusy(false); }
  }

  return (
    <div className="fc fc-sec" data-testid="fc-field-covers" data-field-id={fieldId}>
      <style>{COVER_CSS}</style>
      <div className="fc-lb">COVER PHOTOS <span className="fc-new">NEW</span></div>
      <p className="fc-note">The Default shows on every match here. Add a cover and choose it on a match (Gameday Ops, Cover photo) to show that match with a different photo.</p>
      {err && <p className="fc-verdict bad" data-testid="fc-load-error">Couldn&rsquo;t load covers: {err}</p>}
      {!data ? (!err && <p className="fc-note">Loading covers…</p>) : (
        <>
          <div className="fc-default" data-testid="fc-default">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {data.default.url ? <img src={data.default.url} alt="" /> : <div className="fc-note">No Default cover on this field.</div>}
            <div>
              <h4>Default <span className="fc-pill">ALL MATCHES</span></h4>
              <p>Used unless a match has its own cover. Also the photo on the Field Partners card.</p>
              <p data-testid="fc-default-count">{plural(data.default.upcomingMatches, "upcoming match", "upcoming matches")} on Default.</p>
              <button type="button" className="fc-btn pri" disabled={!canEdit} title={canEdit ? undefined : NO_EDIT}
                onClick={() => { setMsg(null); setUpload({ mode: { kind: "default" } }); }} data-testid="fc-default-replace">Replace</button>
              <p className="fc-why">JPEG, PNG or WebP · up to 10 MB</p>
            </div>
          </div>

          <div className="fc-sub">OTHER COVERS</div>
          <div className="fc-grid">
            {data.covers.map((c) => (
              <div key={c.id} className="fc-card" data-testid="fc-cover" data-cover-id={c.id}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={c.url ?? ""} alt="" />
                {renaming?.id === c.id ? (
                  <div>
                    <input data-testid="fc-rename-input" value={renaming.name} maxLength={COVER_NAME_MAX + 20} autoFocus
                      onChange={(e) => setRenaming({ id: c.id, name: e.target.value })}
                      onKeyDown={(e) => { if (e.key === "Enter") void saveRename(); if (e.key === "Escape") setRenaming(null); }} />
                    {(() => { const p = coverNameProblem(renaming.name, data.covers.filter((x) => x.id !== c.id).map((x) => x.name)); return p ? <span className="fc-bad">{p}</span> : null; })()}
                    <div className="fc-acts">
                      <button type="button" className="fc-link" data-testid="fc-rename-save" onClick={() => void saveRename()}
                        disabled={busy || !!coverNameProblem(renaming.name, data.covers.filter((x) => x.id !== c.id).map((x) => x.name)) || renaming.name.trim() === c.name}>Save name</button>
                      <button type="button" className="fc-link" onClick={() => setRenaming(null)}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="fc-name" data-testid="fc-cover-name">{c.name}</div>
                    <div className="fc-count" data-testid="fc-cover-count">{plural(c.upcomingMatches, "upcoming match uses", "upcoming matches use")} this</div>
                    <div className="fc-acts">
                      <button type="button" className="fc-link" disabled={!canEdit} title={canEdit ? undefined : NO_EDIT} data-testid="fc-replace"
                        onClick={() => { setMsg(null); setUpload({ mode: { kind: "replace", coverName: c.name }, coverId: c.id }); }}>Replace</button>
                      <button type="button" className="fc-link" disabled={!canEdit} title={canEdit ? undefined : NO_EDIT} data-testid="fc-rename"
                        onClick={() => { setMsg(null); setRenaming({ id: c.id, name: c.name }); }}>Rename</button>
                      <button type="button" className="fc-link red" disabled={!canEdit} title={canEdit ? undefined : NO_EDIT} data-testid="fc-remove"
                        onClick={() => { setMsg(null); void askRemove(c); }}>Remove</button>
                    </div>
                  </>
                )}
                {confirm?.cover.id === c.id && (
                  <div className="fc-confirm" data-testid="fc-remove-confirm">
                    {confirm.error ? <>Couldn&rsquo;t count the matches using it: {confirm.error}</>
                      : confirm.upcoming === null ? <>Counting the matches that use it…</>
                      : <span data-testid="fc-remove-count" data-count={confirm.upcoming} data-past={confirm.past ?? 0}>
                          Remove &ldquo;{c.name}&rdquo;? {removeQuestion(confirm.upcoming, confirm.past ?? 0)}</span>}
                    <div className="fc-acts">
                      <button type="button" className="fc-link red" data-testid="fc-remove-go" disabled={busy || confirm.upcoming === null} onClick={() => void doRemove()}>Remove it</button>
                      <button type="button" className="fc-link" onClick={() => setConfirm(null)}>Keep it</button>
                    </div>
                  </div>
                )}
              </div>
            ))}
            <button type="button" className="fc-add" disabled={!canEdit} title={canEdit ? undefined : NO_EDIT} data-testid="fc-add"
              onClick={() => { setMsg(null); setUpload({ mode: { kind: "add", takenNames: data.covers.map((c) => c.name) } }); }}>
              <i>+</i>Add cover</button>
          </div>
          {!canEdit && <p className="fc-why" data-testid="fc-no-edit">{NO_EDIT}</p>}
        </>
      )}
      {msg && <p className={"fc-verdict" + (msg.ok ? " ok" : " bad")} data-testid="fc-msg">{msg.text}</p>}
      {upload && <CoverUpload mode={upload.mode} onSubmit={submitUpload} onClose={(changed) => { setUpload(null); if (changed) void load(); }} />}
    </div>
  );
}
