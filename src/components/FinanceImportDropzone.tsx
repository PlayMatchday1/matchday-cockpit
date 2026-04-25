"use client";

import { useRef, useState } from "react";
import Papa from "papaparse";
import type { CsvRow, ImporterConfig } from "@/lib/financeImport";

type Stage =
  | "idle"
  | "parsing"
  | "ready"
  | "importing"
  | "success"
  | "error";

export default function FinanceImportDropzone({
  config,
}: {
  config: ImporterConfig;
}) {
  const [stage, setStage] = useState<Stage>("idle");
  const [filename, setFilename] = useState<string>("");
  const [rows, setRows] = useState<CsvRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [resultCount, setResultCount] = useState<number>(0);
  const [resultNote, setResultNote] = useState<string>("");
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function reset() {
    setStage("idle");
    setError(null);
    setFilename("");
    setRows([]);
    setResultCount(0);
    setResultNote("");
  }

  function processFile(file: File) {
    if (!file.name.toLowerCase().endsWith(".csv")) {
      setError("File must be .csv");
      setStage("error");
      return;
    }
    setFilename(file.name);
    setError(null);
    setStage("parsing");

    Papa.parse<CsvRow>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        const parsed = results.data;
        if (parsed.length === 0) {
          setError("CSV is empty.");
          setStage("error");
          return;
        }
        setRows(parsed);
        setStage("ready");
      },
      error: (err) => {
        setError(`Parse failed: ${err.message}`);
        setStage("error");
      },
    });
  }

  async function runImport() {
    setStage("importing");
    setError(null);
    try {
      const result = await config.importer(rows);
      setResultCount(result.count);
      setResultNote(result.note ?? "");
      setStage("success");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setStage("error");
    }
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (stage === "parsing" || stage === "importing") return;
    const file = e.dataTransfer.files[0];
    if (file) processFile(file);
  }

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) processFile(file);
    if (inputRef.current) inputRef.current.value = "";
  }

  const busy = stage === "parsing" || stage === "importing";
  const idle = stage === "idle";

  return (
    <section className="rounded-2xl border-[1.5px] border-cream-line bg-white p-5 shadow-md shadow-deep-green/10">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-bold tracking-tight text-deep-green">
          {config.title}
        </h2>
        <span className="text-[10px] font-bold uppercase tracking-wider text-deep-green/45">
          {config.key}
        </span>
      </div>
      <p className="mt-1 text-sm text-deep-green/60">{config.description}</p>
      <div className="mt-2 rounded-md bg-cream-soft px-3 py-1.5 text-[11px] text-deep-green/55">
        <span className="font-bold uppercase tracking-wider">Columns:</span>{" "}
        {config.expectedColumns}
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!busy) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => {
          if (idle || stage === "error" || stage === "success") {
            inputRef.current?.click();
          }
        }}
        className={`mt-4 flex flex-col items-center justify-center rounded-xl border-2 border-dashed p-6 text-center transition-all ${
          dragOver
            ? "border-mint bg-mint-soft/40"
            : "border-cream-line bg-cream-soft/30 hover:bg-cream-soft"
        } ${busy ? "cursor-default" : "cursor-pointer"}`}
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

        {idle && (
          <>
            <div className="text-sm font-bold text-deep-green">
              Drop CSV here
            </div>
            <div className="mt-1 text-xs text-deep-green/55">
              or click to choose
            </div>
          </>
        )}

        {stage === "parsing" && (
          <div className="text-sm font-bold text-deep-green">Parsing…</div>
        )}

        {stage === "ready" && (
          <>
            <div className="text-sm font-bold text-deep-green">
              {filename}
            </div>
            <div className="mt-1 text-xs text-deep-green/65">
              {rows.length.toLocaleString()} rows ready to import
            </div>
            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  runImport();
                }}
                className="rounded-full bg-mint px-4 py-1.5 text-xs font-bold text-deep-green transition hover:bg-mint-hover"
              >
                Import
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  reset();
                }}
                className="rounded-full px-3 py-1.5 text-xs font-medium text-deep-green/60 hover:text-deep-green"
              >
                Cancel
              </button>
            </div>
          </>
        )}

        {stage === "importing" && (
          <div className="text-sm font-bold text-deep-green">Importing…</div>
        )}

        {stage === "success" && (
          <>
            <div className="text-sm font-bold text-mint-hover">
              ✓ Imported {resultCount.toLocaleString()} rows
            </div>
            {resultNote && (
              <div className="mt-1 max-w-md text-xs text-deep-green/60">
                {resultNote}
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

        {stage === "error" && (
          <>
            <div className="text-sm font-bold text-coral">Failed</div>
            {error && (
              <div className="mt-1 max-w-md text-xs text-coral/85">
                {error}
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
              Try again
            </button>
          </>
        )}
      </div>
    </section>
  );
}
