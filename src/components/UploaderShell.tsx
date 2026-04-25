"use client";

import { useRef, useState } from "react";

type Stage = "idle" | "parsing" | "uploading" | "success" | "error";

export type UploaderCurrent = {
  filename: string;
  created_at: string;
  row_count: number;
  earliest: string | null;
  latest: string | null;
};

export default function UploaderShell({
  hint,
  rangeLabel,
  current,
  loadingCurrent,
  stage,
  progress,
  stageNote,
  error,
  onFileChosen,
  onReset,
}: {
  hint: string;
  rangeLabel: string;
  current: UploaderCurrent | null;
  loadingCurrent: boolean;
  stage: Stage;
  progress: { current: number; total: number };
  stageNote: string;
  error: string | null;
  onFileChosen: (file: File) => void;
  onReset: () => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const busy = stage === "parsing" || stage === "uploading";

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (busy) return;
    const file = e.dataTransfer.files[0];
    if (file) onFileChosen(file);
  }

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) onFileChosen(file);
    if (inputRef.current) inputRef.current.value = "";
  }

  return (
    <>
      <div className="mb-6 rounded-2xl border-[1.5px] border-cream-line bg-white p-5 shadow-md shadow-deep-green/10">
        <div className="text-xs font-bold uppercase tracking-wider text-deep-green/60">
          Current data
        </div>
        {loadingCurrent ? (
          <div className="mt-2 text-sm text-deep-green/50">Loading…</div>
        ) : current ? (
          <div className="mt-3 grid gap-4 sm:grid-cols-4">
            <Stat label="File" value={current.filename} truncate />
            <Stat label="Uploaded" value={relativeFrom(current.created_at)} />
            <Stat
              label="Rows"
              value={current.row_count.toLocaleString()}
              tabular
            />
            <Stat
              label={rangeLabel}
              value={formatDateRange(current.earliest, current.latest)}
            />
          </div>
        ) : (
          <div className="mt-2 text-sm text-deep-green/60">
            No data uploaded yet.
          </div>
        )}
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!busy) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => {
          if (stage === "idle" || stage === "success" || stage === "error") {
            inputRef.current?.click();
          }
        }}
        className={`flex flex-col items-center justify-center rounded-2xl border-2 border-dashed p-12 text-center transition-all ${
          dragOver
            ? "border-mint bg-mint-soft/40"
            : "border-cream-line bg-cream-soft/40 hover:bg-cream-soft"
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

        {stage === "idle" && (
          <>
            <div className="text-base font-bold text-deep-green">
              Drop CSV here
            </div>
            <div className="mt-1 text-sm text-deep-green/60">
              or click to choose a file
            </div>
            <div className="mt-2 text-xs text-deep-green/50">{hint}</div>
          </>
        )}

        {stage === "parsing" && (
          <>
            <div className="text-base font-bold text-deep-green">Parsing…</div>
            <div className="mt-1 text-sm tabular-nums text-deep-green/60">
              {stageNote || "reading file…"}
            </div>
          </>
        )}

        {stage === "uploading" && (
          <>
            <div className="text-base font-bold text-deep-green">Uploading…</div>
            <div className="mt-1 text-sm tabular-nums text-deep-green/60">
              {progress.current.toLocaleString()} /{" "}
              {progress.total.toLocaleString()} rows
            </div>
            <div className="mt-3 h-2 w-64 overflow-hidden rounded-full bg-mint-soft">
              <div
                className="h-full rounded-full bg-mint transition-all"
                style={{
                  width:
                    progress.total > 0
                      ? `${Math.round((progress.current / progress.total) * 100)}%`
                      : "0%",
                }}
              />
            </div>
          </>
        )}

        {stage === "success" && (
          <>
            <div className="text-base font-bold text-mint-hover">
              ✓ Upload complete
            </div>
            <div className="mt-1 text-sm text-deep-green/70">{stageNote}</div>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onReset();
              }}
              className="mt-4 rounded-full bg-mint px-4 py-1.5 text-xs font-bold text-deep-green transition hover:bg-mint-hover"
            >
              Upload another
            </button>
          </>
        )}

        {stage === "error" && (
          <>
            <div className="text-base font-bold text-coral">Upload failed</div>
            {error && (
              <div className="mt-1 max-w-md text-sm text-coral/80">{error}</div>
            )}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onReset();
              }}
              className="mt-4 rounded-full bg-mint px-4 py-1.5 text-xs font-bold text-deep-green transition hover:bg-mint-hover"
            >
              Try again
            </button>
          </>
        )}
      </div>
    </>
  );
}

function Stat({
  label,
  value,
  truncate,
  tabular,
}: {
  label: string;
  value: string;
  truncate?: boolean;
  tabular?: boolean;
}) {
  return (
    <div className="min-w-0">
      <div className="text-xs font-bold uppercase tracking-wider text-deep-green/60">
        {label}
      </div>
      <div
        className={`mt-1 text-sm font-bold text-deep-green ${truncate ? "truncate" : ""} ${tabular ? "tabular-nums" : ""}`}
        title={truncate ? value : undefined}
      >
        {value}
      </div>
    </div>
  );
}

function relativeFrom(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.max(0, Math.round(ms / 60000));
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.round(hr / 24);
  return `${days}d ago`;
}

function formatDateRange(
  earliest: string | null,
  latest: string | null,
): string {
  if (!earliest || !latest) return "—";
  const fmt = (s: string) => {
    const parts = s.slice(0, 10).split("-");
    if (parts.length < 3) return s;
    return `${parts[1]}/${parts[2]}/${parts[0].slice(2)}`;
  };
  return `${fmt(earliest)} → ${fmt(latest)}`;
}
