"use client";

/* COVER UPLOAD — the dialog behind "Add cover", "Replace" (an extra cover) and "Replace" (the Default).
 *
 * Before anything is sent it shows the image in every place it will appear, each a centre crop to that place's
 * frame (src/lib/fieldCovers.ts CROP_SHAPES, read from the app's code), and the "keep text in the center" guide:
 * the region every one of those crops keeps. The Field Partners card is shown for the Default only, because that
 * card reads GET /fields, which keeps the field's Default whatever a match uses.
 *
 * Nothing is uploaded until Save. One Save is one attempt; the verdict line is the route's read-back. */

import { useEffect, useMemo, useState } from "react";
import { coverFileProblem, coverNameProblem, safeArea, shapesFor, COVER_NAME_MAX, COVER_TYPES, type CoverVerdict } from "@/lib/fieldCovers";
import { COVER_CSS } from "./coverCss";

export type UploadMode =
  | { kind: "add"; takenNames: string[] }
  | { kind: "replace"; coverName: string }
  | { kind: "default" };

export function CropPreviews({ src, isDefault }: { src: string; isDefault: boolean }) {
  const [aspect, setAspect] = useState<number | null>(null);
  const [guide, setGuide] = useState(true);
  useEffect(() => {
    const img = new Image();
    img.onload = () => setAspect(img.naturalWidth / img.naturalHeight);
    img.src = src;
  }, [src]);
  const shapes = shapesFor(isDefault);
  const safe = aspect ? safeArea(aspect, shapes) : null;
  return (
    <div className="fc-prev" data-testid="fc-previews">
      <div className="fc-prev-full">
        <div className="fc-lb">YOUR IMAGE{aspect ? <em>{aspect >= 1 ? `${aspect.toFixed(2)} : 1` : `1 : ${(1 / aspect).toFixed(2)}`}</em> : null}</div>
        <div className="fc-full" style={aspect ? { aspectRatio: String(aspect) } : undefined}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt="" />
          {guide && safe && (
            <div className="fc-safe" data-testid="fc-safe-guide"
              style={{ left: `${safe.x * 100}%`, top: `${safe.y * 100}%`, width: `${safe.w * 100}%`, height: `${safe.h * 100}%` }}>
              <span>Keep text in the center</span>
            </div>
          )}
        </div>
        <label className="fc-check"><input type="checkbox" checked={guide} onChange={(e) => setGuide(e.target.checked)} data-testid="fc-guide-toggle" />
          Show the guide: anything outside the dashed box is cut off somewhere.</label>
      </div>
      <div className="fc-shapes">
        {shapes.map((s) => (
          <figure key={s.key} className="fc-shape" data-testid="fc-shape" data-shape={s.key}>
            <div className="fc-frame" style={{ aspectRatio: String(s.aspect), backgroundImage: `url("${src}")` }} />
            <figcaption><b>{s.label}</b><span>{s.note}</span></figcaption>
          </figure>
        ))}
      </div>
    </div>
  );
}

export default function CoverUpload({ mode, onSubmit, onClose }: {
  mode: UploadMode;
  /** Sends the file (and name, for add). Resolves with the route's verdict and sentence; never retried. */
  onSubmit: (file: File, name: string) => Promise<{ verdict: CoverVerdict | null; line: string }>;
  onClose: (changed: boolean) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ verdict: CoverVerdict | null; line: string } | null>(null);
  const src = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => { if (src) URL.revokeObjectURL(src); }, [src]);

  const fileProblem = file ? coverFileProblem(file) : null;
  const nameProblem = mode.kind === "add" && name !== "" ? coverNameProblem(name, mode.takenNames) : null;
  const ready = !!file && !fileProblem && (mode.kind !== "add" || (name.trim() !== "" && !nameProblem));
  const landed = result?.verdict === "LANDED";
  const title = mode.kind === "add" ? "Add cover" : mode.kind === "replace" ? `Replace "${mode.coverName}"` : "Replace the Default cover";

  async function save() {
    if (!file || !ready || busy) return;
    setBusy(true);
    try { setResult(await onSubmit(file, name.replace(/\s+/g, " ").trim())); }
    finally { setBusy(false); }
  }

  return (
    <div className="fc fc-modal-bg" role="dialog" aria-modal="true" aria-label={title} data-testid="fc-upload">
      <style>{COVER_CSS}</style>
      <div className="fc-modal">
        <div className="fc-modal-h"><b>{title}</b>
          <button type="button" className="fc-x" onClick={() => onClose(landed)} data-testid="fc-upload-close">✕</button></div>
        <div className="fc-modal-b">
          {mode.kind === "default" && <p className="fc-note">The Default shows on every match at this field that has no cover of its own, and on the Field Partners card in the app.</p>}
          {mode.kind === "add" && (
            <label className="fc-f"><span className="fc-lb">NAME<em>{name.trim().length}/{COVER_NAME_MAX}</em></span>
              <input data-testid="fc-name" value={name} maxLength={COVER_NAME_MAX + 20} placeholder="Night games" disabled={busy || landed}
                onChange={(e) => setName(e.target.value)} />
              {nameProblem && <span className="fc-bad" data-testid="fc-name-problem">{nameProblem}</span>}</label>
          )}
          <label className="fc-f"><span className="fc-lb">IMAGE<em>JPEG, PNG or WebP · up to 10 MB</em></span>
            <input type="file" accept={COVER_TYPES.join(",")} data-testid="fc-file" disabled={busy || landed}
              onChange={(e) => { setFile(e.target.files?.[0] ?? null); setResult(null); }} /></label>
          {fileProblem && <p className="fc-bad" data-testid="fc-file-problem">{fileProblem}</p>}
          {src && !fileProblem && <CropPreviews src={src} isDefault={mode.kind === "default"} />}
          {result && <p className={"fc-verdict" + (landed ? " ok" : " bad")} data-testid="fc-upload-verdict" data-verdict={result.verdict ?? ""}>{result.line}</p>}
        </div>
        <div className="fc-modal-f">
          {landed
            ? <button type="button" className="fc-btn pri" onClick={() => onClose(true)} data-testid="fc-upload-done">Done</button>
            : <>
                <button type="button" className="fc-btn" onClick={() => onClose(false)} disabled={busy}>Cancel</button>
                <button type="button" className="fc-btn pri" onClick={() => void save()} disabled={!ready || busy || !!result} data-testid="fc-upload-save">
                  {busy ? "Uploading…" : mode.kind === "add" ? "Add cover" : "Replace"}</button>
              </>}
        </div>
      </div>
    </div>
  );
}
