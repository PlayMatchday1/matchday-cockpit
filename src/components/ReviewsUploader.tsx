"use client";

import { useCallback, useEffect, useState } from "react";
import Papa from "papaparse";
import { supabase } from "@/lib/supabase";
import { normalizeCity } from "@/lib/cityMap";
import { refetchReviewData } from "@/lib/useReviewData";
import UploaderShell from "./UploaderShell";

type Stage = "idle" | "parsing" | "uploading" | "success" | "error";

type CurrentUpload = {
  id: string;
  filename: string;
  row_count: number;
  earliest_review: string | null;
  latest_review: string | null;
  created_at: string;
};

type CsvRow = Record<string, string | undefined>;

type MappedReview = {
  rating_at: string | null;
  star_rating: number;
  comment: string | null;
  user_id: string | null;
  user_first_name: string | null;
  user_last_name: string | null;
  manager_first_name: string | null;
  manager_last_name: string | null;
  start_date: string | null;
  field_title: string | null;
  city: string;
};

const BATCH_SIZE = 500;

export default function ReviewsUploader() {
  const [stage, setStage] = useState<Stage>("idle");
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [stageNote, setStageNote] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<CurrentUpload | null>(null);
  const [loadingCurrent, setLoadingCurrent] = useState(true);

  const loadCurrent = useCallback(async () => {
    setLoadingCurrent(true);
    const { data } = await supabase
      .from("review_uploads")
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
    const mapped: MappedReview[] = [];
    let earliest: string | null = null;
    let latest: string | null = null;

    for (const row of rawRows) {
      const cityNorm = normalizeCity(row["city_name"]);
      if (!cityNorm) continue;

      const star = parseFloat((row["star_rating"] ?? "").trim());
      if (Number.isNaN(star)) continue;

      const startDate = (row["start_date"] ?? "").trim();
      const ratingAt = (row["updated_at_rating"] ?? "").trim() || null;

      mapped.push({
        rating_at: ratingAt,
        star_rating: star,
        comment: (row["comment"] ?? "").trim() || null,
        user_id: (row["user_id"] ?? "").trim() || null,
        user_first_name: (row["user_first_name"] ?? "").trim() || null,
        user_last_name: (row["user_last_name"] ?? "").trim() || null,
        manager_first_name: (row["manager_first_name"] ?? "").trim() || null,
        manager_last_name: (row["manager_last_name"] ?? "").trim() || null,
        start_date: startDate || null,
        field_title: (row["field_title"] ?? "").trim() || null,
        city: cityNorm,
      });

      if (startDate) {
        if (!earliest || startDate < earliest) earliest = startDate;
        if (!latest || startDate > latest) latest = startDate;
      }
    }

    if (mapped.length === 0) {
      setError(
        "No valid review rows found (need a known city and a numeric star_rating).",
      );
      setStage("error");
      return;
    }

    const { data: uploadRow, error: uploadErr } = await supabase
      .from("review_uploads")
      .insert({
        filename,
        row_count: mapped.length,
        earliest_review: earliest,
        latest_review: latest,
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
        .from("reviews")
        .insert(chunk);
      if (insertErr) {
        await supabase.from("review_uploads").delete().eq("id", uploadId);
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
      .from("review_uploads")
      .update({ is_current: false })
      .neq("id", uploadId);
    if (flagErr) {
      console.warn(
        "Failed to clear is_current on prior review uploads:",
        flagErr.message,
      );
    }

    const { error: cleanErr } = await supabase
      .from("reviews")
      .delete()
      .neq("upload_id", uploadId);
    if (cleanErr) {
      console.warn("Failed to delete prior reviews:", cleanErr.message);
    }

    setStage("success");
    setStageNote(`${mapped.length.toLocaleString()} rows imported`);
    loadCurrent();
    refetchReviewData();
  }

  function reset() {
    setStage("idle");
    setError(null);
    setStageNote("");
    setProgress({ current: 0, total: 0 });
  }

  return (
    <UploaderShell
      hint="reviews export from Retool"
      rangeLabel="Review dates"
      current={
        current
          ? {
              filename: current.filename,
              created_at: current.created_at,
              row_count: current.row_count,
              earliest: current.earliest_review,
              latest: current.latest_review,
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
