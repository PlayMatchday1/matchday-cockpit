"use client";

import { useEffect, useState } from "react";
import { supabase } from "./supabase";
import { selectAll } from "./supabasePagination";

export type MatchRow = {
  city: string;
  field: string;
  matchStart: Date;
  matchCanceled: boolean;
  playerCanceledAt: Date | null;
  // Type Of Payment column from user_analysis: 'MEMBER' | 'DAILY PAID' |
  // promo / other / null. Used by the Member-Heavy Fields insight to
  // measure each venue's actual member mix.
  paymentType: string | null;
  // Promocode column from user_analysis — non-empty when the player
  // redeemed a promo code on this registration. Used by the High Promo
  // Usage insight.
  promocode: string | null;
  // Player email, lowercased on ingest. Used to join attendance to
  // fin_members for avg-matches-per-member.
  email: string | null;
};

export type DataMeta = {
  filename: string;
  uploadedAt: Date;
  rowCount: number;
  earliestMatch: Date;
  latestMatch: Date;
} | null;

type State = {
  rows: MatchRow[];
  meta: DataMeta;
  loading: boolean;
  error: string | null;
};

const INITIAL: State = { rows: [], meta: null, loading: true, error: null };

let cached: State | null = null;
let pending: Promise<void> | null = null;
const subscribers = new Set<(s: State) => void>();

// Parse a Postgres timestamptz / CSV timestamp string as wall-clock local time.
// Avoids the UTC shift that `new Date(str)` applies to ISO strings.
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
    .from("data_uploads")
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

  type MatchSelect = {
    city: string;
    field: string | null;
    match_start: string;
    match_canceled: boolean;
    player_canceled_at: string | null;
    payment_type: string | null;
    promocode: string | null;
    email: string | null;
  };
  let raw: MatchSelect[];
  try {
    raw = await selectAll<MatchSelect>(() =>
      supabase
        .from("match_registrations")
        .select(
          "city, field, match_start, match_canceled, player_canceled_at, payment_type, promocode, email",
        )
        .eq("upload_id", uploadId)
        .order("match_start"),
    );
  } catch (e) {
    publish({
      rows: [],
      meta: null,
      loading: false,
      error: e instanceof Error ? e.message : "Failed to load match data.",
    });
    return;
  }

  const all: MatchRow[] = [];
  for (const r of raw) {
    const matchStart = parseLocal(r.match_start);
    if (!matchStart) continue;
    all.push({
      city: r.city,
      field: r.field ?? "",
      matchStart,
      matchCanceled: !!r.match_canceled,
      playerCanceledAt: parseLocal(r.player_canceled_at),
      paymentType: r.payment_type,
      promocode: r.promocode,
      email: r.email,
    });
  }

  const u = uploadRow as {
    filename: string;
    created_at: string;
    row_count: number;
    earliest_match: string | null;
    latest_match: string | null;
  };
  const earliestMatch =
    parseLocal(u.earliest_match) ?? all[0]?.matchStart ?? new Date();
  const latestMatch =
    parseLocal(u.latest_match) ?? all[all.length - 1]?.matchStart ?? new Date();

  publish({
    rows: all,
    meta: {
      filename: u.filename,
      uploadedAt: new Date(u.created_at),
      rowCount: u.row_count,
      earliestMatch,
      latestMatch,
    },
    loading: false,
    error: null,
  });
}

export function useMatchData(): State {
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

export async function refetchMatchData(): Promise<void> {
  await load();
}
