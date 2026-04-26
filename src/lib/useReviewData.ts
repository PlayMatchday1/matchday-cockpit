"use client";

import { useEffect, useState } from "react";
import { supabase } from "./supabase";
import { parseTags } from "./reviewTags";

export type ReviewRow = {
  city: string;
  fieldTitle: string;
  managerFirstName: string | null;
  managerLastName: string | null;
  starRating: number;
  startDate: Date;
  userId: string | null;
  ratingAt: Date | null;
  comment: string | null;
  userFirstName: string | null;
  userLastName: string | null;
  userEmail: string | null;
  tags: string[];
};

export type ReviewMeta = {
  filename: string;
  uploadedAt: Date;
  rowCount: number;
  earliestReview: Date;
  latestReview: Date;
} | null;

type State = {
  rows: ReviewRow[];
  meta: ReviewMeta;
  loading: boolean;
  error: string | null;
};

const INITIAL: State = { rows: [], meta: null, loading: true, error: null };

let cached: State | null = null;
let pending: Promise<void> | null = null;
const subscribers = new Set<(s: State) => void>();

function parseLocal(s: string | null | undefined): Date | null {
  if (!s) return null;
  const parts = s.slice(0, 16).split(/[- T:]/);
  if (parts.length < 5) return null;
  const [yr, mo, dy, hr, mn] = parts.map(Number);
  if ([yr, mo, dy, hr, mn].some((n) => Number.isNaN(n))) return null;
  return new Date(yr, mo - 1, dy, hr, mn);
}

function publish(s: State) {
  cached = s;
  subscribers.forEach((fn) => fn(s));
}

async function load(): Promise<void> {
  publish({ rows: [], meta: null, loading: true, error: null });

  const { data: uploadRow, error: uploadErr } = await supabase
    .from("review_uploads")
    .select("*")
    .eq("is_current", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (uploadErr) {
    publish({ rows: [], meta: null, loading: false, error: uploadErr.message });
    return;
  }
  if (!uploadRow) {
    publish({ rows: [], meta: null, loading: false, error: null });
    return;
  }

  const uploadId = (uploadRow as { id: string }).id;

  const PAGE = 1000;
  const all: ReviewRow[] = [];
  let start = 0;
  while (true) {
    const { data, error } = await supabase
      .from("reviews")
      .select(
        "city, field_title, manager_first_name, manager_last_name, star_rating, start_date, user_id, rating_at, comment, user_first_name, user_last_name, user_email, tags_rating",
      )
      .eq("upload_id", uploadId)
      .order("start_date")
      .range(start, start + PAGE - 1);
    if (error) {
      publish({ rows: [], meta: null, loading: false, error: error.message });
      return;
    }
    if (!data || data.length === 0) break;
    for (const r of data as Array<{
      city: string;
      field_title: string | null;
      manager_first_name: string | null;
      manager_last_name: string | null;
      star_rating: number | null;
      start_date: string | null;
      user_id: string | null;
      rating_at: string | null;
      comment: string | null;
      user_first_name: string | null;
      user_last_name: string | null;
      user_email: string | null;
      tags_rating: string | null;
    }>) {
      const startDate = parseLocal(r.start_date);
      if (!startDate) continue;
      if (r.star_rating === null) continue;
      all.push({
        city: r.city,
        fieldTitle: r.field_title ?? "",
        managerFirstName: r.manager_first_name,
        managerLastName: r.manager_last_name,
        starRating: Number(r.star_rating),
        startDate,
        userId: r.user_id,
        ratingAt: parseLocal(r.rating_at),
        comment: r.comment,
        userFirstName: r.user_first_name,
        userLastName: r.user_last_name,
        userEmail: r.user_email,
        tags: parseTags(r.tags_rating),
      });
    }
    if (data.length < PAGE) break;
    start += PAGE;
  }

  const u = uploadRow as {
    filename: string;
    created_at: string;
    row_count: number;
    earliest_review: string | null;
    latest_review: string | null;
  };
  const earliestReview =
    parseLocal(u.earliest_review) ?? all[0]?.startDate ?? new Date();
  const latestReview =
    parseLocal(u.latest_review) ?? all[all.length - 1]?.startDate ?? new Date();

  publish({
    rows: all,
    meta: {
      filename: u.filename,
      uploadedAt: new Date(u.created_at),
      rowCount: u.row_count,
      earliestReview,
      latestReview,
    },
    loading: false,
    error: null,
  });
}

export function useReviewData(): State {
  const [s, setS] = useState<State>(cached ?? INITIAL);

  useEffect(() => {
    subscribers.add(setS);
    if (cached) {
      setS(cached);
    } else if (!pending) {
      pending = load().finally(() => {
        pending = null;
      });
    }
    return () => {
      subscribers.delete(setS);
    };
  }, []);

  return s;
}

export async function refetchReviewData(): Promise<void> {
  await load();
}
