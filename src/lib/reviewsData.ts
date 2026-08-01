"use client";

// THE single fake-player choke point for the Reviews page. Every displayed
// number derives from the array useCleanReviews() returns, so the fake filter
// can never be forgotten per-query — that is the whole point of putting it here
// once instead of on each aggregate.
//
// WHY it matters even though reviews look clean: there are 208 fake users and
// ~12k fake participation rows (~15% of mdapi_match_players). Fakes are
// synthetic match FILLS, so in practice 0 of ~22k reviews are theirs — but a
// single unfiltered aggregate on a table where fakes DID leak would silently
// skew every rating on the page, so the guard is defensive and non-optional.
//
// A review is a fake's iff the author is a fake player — by
// mdapi_users.is_fake_player OR the anchored @matchday.com email tail
// (defense-in-depth, mirroring mdapiFakePlayer; @playmatchday.com staff are
// safe). The fake user-id set is loaded once, module-cached.

import { useEffect, useMemo, useState } from "react";
import { supabase } from "./supabase";
import { isFakePlayerEmail } from "./mdapiFakePlayer";
import { useReviewData, type ReviewRow } from "./useReviewData";

let fakeIdsCache: Set<string> | null = null;
let fakePending: Promise<Set<string>> | null = null;

async function loadFakeIds(): Promise<Set<string>> {
  if (fakeIdsCache) return fakeIdsCache;
  if (fakePending) return fakePending;
  fakePending = (async () => {
    const ids = new Set<string>();
    let from = 0;
    for (;;) {
      const { data, error } = await supabase
        .from("mdapi_users")
        .select("id")
        .eq("is_fake_player", true)
        .range(from, from + 999);
      if (error || !data) break; // fail toward the email signal below, never throw
      for (const r of data) ids.add(String(r.id));
      if (data.length < 1000) break;
      from += 1000;
    }
    fakeIdsCache = ids;
    fakePending = null;
    return ids;
  })();
  return fakePending;
}

export function isRealReview(r: ReviewRow, fakeIds: Set<string>): boolean {
  if (r.userId && fakeIds.has(r.userId)) return false;
  if (isFakePlayerEmail(r.userEmail)) return false;
  return true;
}

export type CleanReviews = {
  rows: ReviewRow[]; // fake-filtered — the one array the page derives from
  rawCount: number; // before the fake filter (for the 6c disclosure)
  fakeExcluded: number;
  meta: ReturnType<typeof useReviewData>["meta"];
  loading: boolean;
  error: string | null;
};

export function useCleanReviews(): CleanReviews {
  const { rows, meta, loading, error } = useReviewData();
  const [fakeIds, setFakeIds] = useState<Set<string>>(fakeIdsCache ?? new Set());
  useEffect(() => {
    let live = true;
    void loadFakeIds().then((s) => {
      if (live) setFakeIds(s);
    });
    return () => {
      live = false;
    };
  }, []);
  const clean = useMemo(
    () => rows.filter((r) => isRealReview(r, fakeIds)),
    [rows, fakeIds],
  );
  return {
    rows: clean,
    rawCount: rows.length,
    fakeExcluded: rows.length - clean.length,
    meta,
    loading,
    error,
  };
}
