"use client";

import { useRef, useState } from "react";
import Papa from "papaparse";

type Stage<P> =
  | { name: "idle" }
  | { name: "parsing" }
  | { name: "ready"; preview: P }
  | { name: "committing" }
  | { name: "success"; count: number; note?: string }
  | { name: "error"; message: string };

export type FinanceUploadCardProps<P> = {
  index: number;
  title: string;
  subtitle: string;
  expectedColumns: string;
  preview: (raw: string[][], filename: string) => Promise<P> | P;
  commit: (preview: P) => Promise<{ count: number; note?: string }>;
  renderPreview: (preview: P) => React.ReactNode;
  confirmLabel?: string;
};

export default function FinanceUploadCard<P>({
  index,
  title,
  subtitle,
  expectedColumns,
  preview,
  commit,
  renderPreview,
  confirmLabel = "Confirm Replace",
}: FinanceUploadCardProps<P>) {
  const [stage, setStage] = useState<Stage<P>>({ name: "idle" });
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
          const p = await preview(raw, file.name);
          setStage({ name: "ready", preview: p });
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
    setStage({ name: "committing" });
    try {
      const result = await commit(previewData);
      setStage({ name: "success", count: result.count, note: result.note });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setStage({ name: "error", message });
    }
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
    <section className="rounded-2xl border-[1.5px] border-cream-line bg-white p-6 shadow-md shadow-deep-green/10">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-deep-green/45">
            Step {index}
          </div>
          <h2 className="mt-1 font-display text-3xl uppercase leading-none tracking-tight text-deep-green md:text-4xl">
            {title}
          </h2>
          <p className="mt-1 text-sm text-deep-green/60">{subtitle}</p>
        </div>
      </div>
      <div className="mt-3 rounded-md bg-cream-soft px-3 py-1.5 text-[11px] text-deep-green/55">
        <span className="font-bold uppercase tracking-wider">Columns:</span>{" "}
        {expectedColumns}
      </div>

      {stage.name === "ready" ? (
        <div className="mt-5 rounded-xl border border-cream-line bg-cream-soft/30 p-5">
          <div className="text-sm font-bold text-deep-green">{filename}</div>
          <div className="mt-3 text-sm text-deep-green">
            {renderPreview(stage.preview)}
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={runCommit}
              className="rounded-full bg-mint px-5 py-2 text-xs font-bold text-deep-green transition hover:bg-mint-hover"
            >
              {confirmLabel}
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
          className={`mt-5 flex flex-col items-center justify-center rounded-xl border-2 border-dashed p-8 text-center transition-all ${
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
            <div className="text-sm font-bold text-deep-green">Saving…</div>
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
                className="mt-4 rounded-full bg-mint px-4 py-1.5 text-xs font-bold text-deep-green hover:bg-mint-hover"
              >
                Upload another
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
                className="mt-4 rounded-full bg-mint px-4 py-1.5 text-xs font-bold text-deep-green hover:bg-mint-hover"
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
