"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Papa from "papaparse";
import PageHeader from "@/components/PageHeader";
import { supabase } from "@/lib/supabase";
import { normalizeCity } from "@/lib/cityMap";
import { normField } from "@/lib/normField";
import { refetchMatchData } from "@/lib/useMatchData";

type UploadStage = "idle" | "parsing" | "uploading" | "success" | "error";

type CurrentUpload = {
  id: string;
  filename: string;
  row_count: number;
  earliest_match: string | null;
  latest_match: string | null;
  created_at: string;
};

type CsvRow = Record<string, string | undefined>;

type MappedRow = {
  user_id: string | null;
  registration_at: string | null;
  city: string;
  field: string;
  match_start: string;
  payment_type: string | null;
  promocode: string | null;
  preferable_city: string | null;
  player_canceled_at: string | null;
  match_canceled: boolean;
  match_price_paid: number;
};

const BATCH_SIZE = 500;

export default function DataPage() {
  const [stage, setStage] = useState<UploadStage>("idle");
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [stageNote, setStageNote] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<CurrentUpload | null>(null);
  const [loadingCurrent, setLoadingCurrent] = useState(true);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const loadCurrent = useCallback(async () => {
    setLoadingCurrent(true);
    const { data } = await supabase
      .from("data_uploads")
      .select("*")
      .eq("is_current", true)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    setCurrent((data as CurrentUpload | null) ?? null);
    setLoadingCurrent(false);
  }, []);

  useEffect(() => {
    loadCurrent();
  }, [loadCurrent]);

  function processFile(file: File) {
    if (!file.name.toLowerCase().endsWith(".csv")) {
      setError("File must be .csv");
      setStage("error");
      return;
    }
    setError(null);
    setStage("parsing");
    setStageNote("reading file…");
    setProgress({ current: 0, total: 0 });

    Papa.parse<CsvRow>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        const rows = results.data as CsvRow[];
        setStageNote(`parsed ${rows.length.toLocaleString()} rows`);
        upload(file.name, rows);
      },
      error: (err) => {
        setError(`Parse failed: ${err.message}`);
        setStage("error");
      },
    });
  }

  async function upload(filename: string, rawRows: CsvRow[]) {
    const mapped: MappedRow[] = [];
    let earliest: string | null = null;
    let latest: string | null = null;

    for (const row of rawRows) {
      const cityNorm = normalizeCity(row["City"]);
      if (!cityNorm) continue;
      const matchStart = (row["Match Start"] ?? "").trim();
      if (!matchStart) continue;

      const userId = (row["User ID"] ?? "").trim() || null;
      const reg = (row["Date Of Match Registration"] ?? "").trim() || null;
      const cancel = (row["Canceled At"] ?? "").trim() || null;
      const matchCanceledRaw = row["Match Canceled"];
      const matchCanceled =
        matchCanceledRaw === "true" || (matchCanceledRaw as unknown) === true;
      const promo = (row["Promocode"] ?? "").trim() || null;
      const prefCity = (row["Preferable City"] ?? "").trim() || null;
      const paymentType = (row["Type Of Payment"] ?? "").trim() || null;
      const pricePaid = parseFloat(row["Match price paid"] ?? "") || 0;

      mapped.push({
        user_id: userId,
        registration_at: reg,
        city: cityNorm,
        field: normField(row["Field"]),
        match_start: matchStart,
        payment_type: paymentType,
        promocode: promo,
        preferable_city: prefCity,
        player_canceled_at: cancel,
        match_canceled: matchCanceled,
        match_price_paid: pricePaid,
      });

      if (!earliest || matchStart < earliest) earliest = matchStart;
      if (!latest || matchStart > latest) latest = matchStart;
    }

    if (mapped.length === 0) {
      setError("No valid rows found in CSV (no recognized cities or missing match dates).");
      setStage("error");
      return;
    }

    // 1. Create the data_uploads row.
    const { data: uploadRow, error: uploadErr } = await supabase
      .from("data_uploads")
      .insert({
        filename,
        row_count: mapped.length,
        earliest_match: earliest,
        latest_match: latest,
      })
      .select()
      .single();

    if (uploadErr || !uploadRow) {
      setError(`Failed to create upload: ${uploadErr?.message ?? "unknown error"}`);
      setStage("error");
      return;
    }

    const uploadId = (uploadRow as { id: string }).id;
    const rowsWithId = mapped.map((r) => ({ ...r, upload_id: uploadId }));

    // 2. Batch-insert match_registrations.
    setStage("uploading");
    setStageNote("");
    setProgress({ current: 0, total: rowsWithId.length });

    for (let i = 0; i < rowsWithId.length; i += BATCH_SIZE) {
      const chunk = rowsWithId.slice(i, i + BATCH_SIZE);
      const { error: insertErr } = await supabase
        .from("match_registrations")
        .insert(chunk);
      if (insertErr) {
        // Roll back the data_uploads row to avoid orphans.
        await supabase.from("data_uploads").delete().eq("id", uploadId);
        setError(`Insert failed at row ${i.toLocaleString()}: ${insertErr.message}`);
        setStage("error");
        return;
      }
      setProgress({
        current: Math.min(i + BATCH_SIZE, rowsWithId.length),
        total: rowsWithId.length,
      });
    }

    // 3. Flip is_current on the previous uploads.
    const { error: flagErr } = await supabase
      .from("data_uploads")
      .update({ is_current: false })
      .neq("id", uploadId);
    if (flagErr) {
      console.warn("Failed to clear is_current on prior uploads:", flagErr.message);
    }

    // 4. Delete prior match_registrations. Non-fatal if it fails.
    const { error: cleanErr } = await supabase
      .from("match_registrations")
      .delete()
      .neq("upload_id", uploadId);
    if (cleanErr) {
      console.warn("Failed to delete prior match_registrations:", cleanErr.message);
    }

    setStage("success");
    setStageNote(`${mapped.length.toLocaleString()} rows imported`);
    loadCurrent();
    refetchMatchData();
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (stage === "parsing" || stage === "uploading") return;
    const file = e.dataTransfer.files[0];
    if (file) processFile(file);
  }

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) processFile(file);
    if (inputRef.current) inputRef.current.value = "";
  }

  const busy = stage === "parsing" || stage === "uploading";

  return (
    <>
      <PageHeader
        title="Data"
        subtitle="Upload the latest user_analysis CSV from Retool. Replaces all match data across the cockpit."
      />

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
              label="Match dates"
              value={formatDateRange(current.earliest_match, current.latest_match)}
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
            <div className="mt-2 text-xs text-deep-green/50">
              user_analysis export from Retool
            </div>
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
              {progress.current.toLocaleString()} / {progress.total.toLocaleString()} rows
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
                setStage("idle");
                setStageNote("");
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
                setStage("idle");
                setError(null);
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
