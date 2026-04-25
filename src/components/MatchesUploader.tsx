"use client";

import { useCallback, useEffect, useState } from "react";
import Papa from "papaparse";
import { supabase } from "@/lib/supabase";
import { normalizeCity } from "@/lib/cityMap";
import { normField } from "@/lib/normField";
import { refetchMatchData } from "@/lib/useMatchData";
import UploaderShell from "./UploaderShell";

type Stage = "idle" | "parsing" | "uploading" | "success" | "error";

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

export default function MatchesUploader() {
  const [stage, setStage] = useState<Stage>("idle");
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [stageNote, setStageNote] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<CurrentUpload | null>(null);
  const [loadingCurrent, setLoadingCurrent] = useState(true);

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
      setError(
        "No valid rows found in CSV (no recognized cities or missing match dates).",
      );
      setStage("error");
      return;
    }

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
      setError(
        `Failed to create upload: ${uploadErr?.message ?? "unknown error"}`,
      );
      setStage("error");
      return;
    }

    const uploadId = (uploadRow as { id: string }).id;
    const rowsWithId = mapped.map((r) => ({ ...r, upload_id: uploadId }));

    setStage("uploading");
    setStageNote("");
    setProgress({ current: 0, total: rowsWithId.length });

    for (let i = 0; i < rowsWithId.length; i += BATCH_SIZE) {
      const chunk = rowsWithId.slice(i, i + BATCH_SIZE);
      const { error: insertErr } = await supabase
        .from("match_registrations")
        .insert(chunk);
      if (insertErr) {
        await supabase.from("data_uploads").delete().eq("id", uploadId);
        setError(
          `Insert failed at row ${i.toLocaleString()}: ${insertErr.message}`,
        );
        setStage("error");
        return;
      }
      setProgress({
        current: Math.min(i + BATCH_SIZE, rowsWithId.length),
        total: rowsWithId.length,
      });
    }

    const { error: flagErr } = await supabase
      .from("data_uploads")
      .update({ is_current: false })
      .neq("id", uploadId);
    if (flagErr) {
      console.warn(
        "Failed to clear is_current on prior uploads:",
        flagErr.message,
      );
    }

    const { error: cleanErr } = await supabase
      .from("match_registrations")
      .delete()
      .neq("upload_id", uploadId);
    if (cleanErr) {
      console.warn(
        "Failed to delete prior match_registrations:",
        cleanErr.message,
      );
    }

    setStage("success");
    setStageNote(`${mapped.length.toLocaleString()} rows imported`);
    loadCurrent();
    refetchMatchData();
  }

  function reset() {
    setStage("idle");
    setError(null);
    setStageNote("");
    setProgress({ current: 0, total: 0 });
  }

  return (
    <UploaderShell
      hint="user_analysis export from Retool"
      rangeLabel="Match dates"
      current={
        current
          ? {
              filename: current.filename,
              created_at: current.created_at,
              row_count: current.row_count,
              earliest: current.earliest_match,
              latest: current.latest_match,
            }
          : null
      }
      loadingCurrent={loadingCurrent}
      stage={stage}
      progress={progress}
      stageNote={stageNote}
      error={error}
      onFileChosen={processFile}
      onReset={reset}
    />
  );
}
