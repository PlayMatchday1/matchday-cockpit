"use client";

import { useRef, useState } from "react";
import Papa from "papaparse";
import {
  commitScheduleImport,
  parseSchedulePreview,
  type SchedulePreview,
} from "@/lib/financeImport";

type Stage =
  | { name: "idle" }
  | { name: "parsing" }
  | { name: "ready"; preview: SchedulePreview; mode: "preserve" | "replace" }
  | { name: "committing" }
  | { name: "success"; count: number; note?: string }
  | { name: "error"; message: string };

export default function FinanceScheduleImportCard() {
  const [stage, setStage] = useState<Stage>({ name: "idle" });
  const [filename, setFilename] = useState<string>("");
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function reset() {
    setStage({ name: "idle" });
    setFilename("");
  }

  function processFile(file: File) {
    if (!file.name.toLowerCase().endsWith(".csv")) {
      setStage({ name: "error", message: "File must be .csv" });
      return;
    }
    setFilename(file.name);
    setStage({ name: "parsing" });

    Papa.parse<string[]>(file, {
      header: false,
      skipEmptyLines: true,
      complete: async (results) => {
        try {
          const raw = (results.data as string[][]).filter((row) =>
            row.some((cell) => cell && String(cell).trim() !== ""),
          );
          if (raw.length === 0) {
            setStage({ name: "error", message: "CSV is empty." });
            return;
          }
          const preview = await parseSchedulePreview(raw, file.name);
          setStage({ name: "ready", preview, mode: "preserve" });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          setStage({ name: "error", message });
        }
      },
      error: (err) => {
        setStage({ name: "error", message: `Parse failed: ${err.message}` });
      },
    });
  }

  async function runCommit() {
    if (stage.name !== "ready") return;
    const previewData = stage.preview;
    const mode = stage.mode;
    setStage({ name: "committing" });
    try {
      const result = await commitScheduleImport(previewData, mode);
      setStage({ name: "success", count: result.count, note: result.note });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setStage({ name: "error", message });
    }
  }

  function setMode(mode: "preserve" | "replace") {
    if (stage.name !== "ready") return;
    setStage({ ...stage, mode });
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (stage.name === "parsing" || stage.name === "committing") return;
    const file = e.dataTransfer.files[0];
    if (file) processFile(file);
  }

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) processFile(file);
    if (inputRef.current) inputRef.current.value = "";
  }

  const dropzoneActive =
    stage.name === "idle" ||
    stage.name === "error" ||
    stage.name === "success";

  return (
    <section className="rounded-2xl border-l-4 border-mint border-y-[1.5px] border-r-[1.5px] border-y-cream-line border-r-cream-line bg-white p-5 shadow-md shadow-deep-green/10">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-bold tracking-tight text-deep-green">
          5. Schedule
        </h2>
        <span className="text-[10px] font-bold uppercase tracking-wider text-mint-hover">
          preview · keep or replace manual entries
        </span>
      </div>
      <p className="mt-1 text-sm text-deep-green/60">
        Schedule import preserves manual entries by default. Choose{" "}
        <strong>Replace</strong> to overwrite everything (including any
        clubhouse-added matches) for the months covered.
      </p>
      <div className="mt-2 rounded-md bg-cream-soft px-3 py-1.5 text-[11px] text-deep-green/55">
        <span className="font-bold uppercase tracking-wider">Columns:</span>{" "}
        Date, Month, City, Venue, Match Count, Total Hours, Venue Cost, Notes
      </div>

      {stage.name === "ready" ? (
        <div className="mt-4 rounded-xl border border-cream-line bg-cream-soft/30 p-5">
          <div className="text-sm font-bold text-deep-green">{filename}</div>
          <div className="mt-2 text-xs text-deep-green/65">
            {stage.preview.rows.length.toLocaleString()} schedule rows · months
            covered:{" "}
            <span className="font-mono">
              {stage.preview.monthsCovered.join(", ") || "—"}
            </span>
          </div>

          {stage.preview.manualConflicts.length > 0 ? (
            <div className="mt-4 rounded-md border border-gold/40 bg-gold-soft/40 p-3">
              <div className="text-sm font-bold text-deep-green">
                ⚠️ Found {stage.preview.manualConflicts.length} manual{" "}
                {stage.preview.manualConflicts.length === 1
                  ? "entry"
                  : "entries"}{" "}
                in this range:
              </div>
              <ul className="mt-2 max-h-40 space-y-0.5 overflow-auto pl-4 font-mono text-[11px] text-deep-green/85">
                {stage.preview.manualConflicts.map((c) => (
                  <li key={c.id}>
                    {c.date} · {c.venue} · {c.match_count}{" "}
                    {c.match_count === 1 ? "match" : "matches"}
                    {c.created_by ? (
                      <span className="text-deep-green/55">
                        {" "}
                        · added by {c.created_by}
                      </span>
                    ) : null}
                    {c.notes ? (
                      <span className="text-deep-green/55"> · {c.notes}</span>
                    ) : null}
                  </li>
                ))}
              </ul>

              <div className="mt-4 space-y-2 text-sm">
                <label className="flex cursor-pointer items-start gap-2">
                  <input
                    type="radio"
                    name="schedule-import-mode"
                    checked={stage.mode === "preserve"}
                    onChange={() => setMode("preserve")}
                    className="mt-1"
                  />
                  <span>
                    <strong>Keep manual entries</strong>{" "}
                    <span className="text-deep-green/55">(recommended)</span> —
                    Sheet import only updates non-manual rows. Your{" "}
                    {stage.preview.manualConflicts.length} manual{" "}
                    {stage.preview.manualConflicts.length === 1
                      ? "entry stays"
                      : "entries stay"}{" "}
                    untouched.
                  </span>
                </label>
                <label className="flex cursor-pointer items-start gap-2">
                  <input
                    type="radio"
                    name="schedule-import-mode"
                    checked={stage.mode === "replace"}
                    onChange={() => setMode("replace")}
                    className="mt-1"
                  />
                  <span>
                    <strong>Replace everything</strong> — manual entries will
                    be deleted, Sheet becomes truth.
                  </span>
                </label>
              </div>
            </div>
          ) : (
            <div className="mt-4 rounded-md border border-mint/40 bg-mint-soft/40 px-3 py-2 text-xs text-deep-green">
              ✓ No manual entries in the covered months — safe to import. A
              standard month-replace will run.
            </div>
          )}

          <div className="mt-5 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={runCommit}
              className="rounded-full bg-mint px-5 py-2 text-xs font-bold text-deep-green transition hover:bg-mint-hover"
            >
              {stage.preview.manualConflicts.length === 0
                ? "Import"
                : stage.mode === "preserve"
                  ? `Keep ${stage.preview.manualConflicts.length} & Import`
                  : `Replace All & Import`}
            </button>
            <button
              type="button"
              onClick={reset}
              className="rounded-full border border-cream-line bg-transparent px-4 py-2 text-xs font-bold text-deep-green hover:bg-cream-soft"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            if (dropzoneActive) setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          onClick={() => {
            if (dropzoneActive) inputRef.current?.click();
          }}
          className={`mt-4 flex flex-col items-center justify-center rounded-xl border-2 border-dashed p-6 text-center transition-all ${
            dragOver
              ? "border-mint bg-mint-soft/40"
              : "border-cream-line bg-cream-soft/30 hover:bg-cream-soft"
          } ${dropzoneActive ? "cursor-pointer" : "cursor-default"}`}
          role="button"
          tabIndex={0}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".csv,text/csv"
            onChange={onFileChange}
            className="hidden"
          />
          {stage.name === "idle" && (
            <>
              <div className="text-sm font-bold text-deep-green">
                Drop CSV here
              </div>
              <div className="mt-1 text-xs text-deep-green/55">
                or click to choose
              </div>
            </>
          )}
          {stage.name === "parsing" && (
            <div className="text-sm font-bold text-deep-green">Parsing…</div>
          )}
          {stage.name === "committing" && (
            <div className="text-sm font-bold text-deep-green">Importing…</div>
          )}
          {stage.name === "success" && (
            <>
              <div className="text-sm font-bold text-mint-hover">
                ✓ Imported {stage.count.toLocaleString()} rows
              </div>
              {stage.note && (
                <div className="mt-1 max-w-md text-xs text-deep-green/60">
                  {stage.note}
                </div>
              )}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  reset();
                }}
                className="mt-3 rounded-full bg-mint px-4 py-1.5 text-xs font-bold text-deep-green hover:bg-mint-hover"
              >
                Import another
              </button>
            </>
          )}
          {stage.name === "error" && (
            <>
              <div className="text-sm font-bold text-coral">Failed</div>
              <div className="mt-1 max-w-md text-xs text-coral/85">
                {stage.message}
              </div>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  reset();
                }}
                className="mt-3 rounded-full bg-mint px-4 py-1.5 text-xs font-bold text-deep-green hover:bg-mint-hover"
              >
                Try again
              </button>
            </>
          )}
        </div>
      )}
    </section>
  );
}
