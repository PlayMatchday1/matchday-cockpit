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
import { normalizeCity } from "./cityMap";

// The SAME wall-clock parse useReviewData used — start_date is a local timestamp, so it is read
// component-by-component and rebuilt in local time. Never new Date(str), which re-reads it as UTC.
function parseLocal(s: string | null | undefined): Date | null {
  if (!s) return null;
  const parts = s.slice(0, 16).split(/[- T:]/);
  if (parts.length < 5) return null;
  const [yr, mo, dy, hr, mn] = parts.map(Number);
  if ([yr, mo, dy, hr, mn].some((n) => Number.isNaN(n))) return null;
  return new Date(yr, mo - 1, dy, hr, mn);
}

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

// ── THE SCOPED SOURCE (Phase 29 Part B) ────────────────────────────────────────────────────────
// Every review surface used to call useReviewData, which paginates the WHOLE of mdapi_reviews into
// the browser (~23k rows) and filters in JS. That is why the admin page is slow AND why a city
// manager could not have one: scoping in the browser would mean shipping every city's reviews —
// names, emails, comments — to their machine and hiding most of them.
//
// This hits /api/reviews instead, which returns rows ALREADY filtered to whatever the caller's
// session allows: one city for a city manager, everything (or one, on request) for an admin. The
// row mapping below is byte-for-byte the one useReviewData applied, so nothing downstream changes
// shape — only how many rows arrive, and whose.
type ApiReviewRow = {
  api_id: number; city_name: string | null; field_title: string | null;
  manager_first_name: string | null; manager_last_name: string | null;
  star_rating: number | null; start_date: string | null; user_id: number | null;
  updated_at_rating: string | null; comment: string | null;
  user_first_name: string | null; user_last_name: string | null; user_email: string | null;
  tags_rating: unknown;
};

export function useScopedReviews(city?: string | null): { rows: ReviewRow[]; scope: string | null; loading: boolean; error: string | null } {
  const [state, setState] = useState<{ rows: ReviewRow[]; scope: string | null; loading: boolean; error: string | null }>(
    { rows: [], scope: null, loading: true, error: null });
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const { data: sess } = await supabase.auth.getSession();
        const qs = city ? `?city=${encodeURIComponent(city)}` : "";
        const res = await fetch(`/api/reviews${qs}`, {
          headers: sess.session ? { Authorization: `Bearer ${sess.session.access_token}` } : {},
          cache: "no-store",
        });
        const j = await res.json().catch(() => ({}));
        if (!live) return;
        if (!res.ok) { setState({ rows: [], scope: null, loading: false, error: j?.error ?? `HTTP ${res.status}` }); return; }
        // Same row filters as the old client path: unparseable date, missing star, unknown city.
        const out: ReviewRow[] = [];
        for (const r of (j.rows ?? []) as ApiReviewRow[]) {
          const startDate = parseLocal(r.start_date);
          if (!startDate) continue;
          if (r.star_rating === null) continue;
          const cityName = normalizeCity(r.city_name);
          if (!cityName) continue;
          out.push({
            apiId: r.api_id, city: cityName, fieldTitle: r.field_title ?? "",
            managerFirstName: r.manager_first_name, managerLastName: r.manager_last_name,
            starRating: r.star_rating, startDate,
            userId: r.user_id == null ? null : String(r.user_id),
            ratingAt: parseLocal(r.updated_at_rating),
            comment: r.comment, userFirstName: r.user_first_name, userLastName: r.user_last_name,
            userEmail: r.user_email,
            tags: Array.isArray(r.tags_rating) ? (r.tags_rating as string[]) : [],
          });
        }
        setState({ rows: out, scope: j.scope ?? null, loading: false, error: null });
      } catch (e) {
        if (live) setState({ rows: [], scope: null, loading: false, error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => { live = false; };
  }, [city]);
  return state;
}

export function useCleanReviews(): CleanReviews {
  const { rows, scope, loading, error } = useScopedReviews();
  void scope;
  const meta = null as unknown as ReturnType<typeof useReviewData>["meta"];
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
