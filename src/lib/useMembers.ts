"use client";

// Lightweight member-only hook. Pulls just the columns isActiveMember
// (and its predicate isPaidExternalMember) need from mdapi_subscriptions
// — no joined match-player pull, no fin_revenue / fin_expenses /
// fin_schedule / fin_venues round trips.
//
// Why a sibling of useFinanceData instead of reusing it:
// CitiesExecHero needs only the activeMembers count for one stat tile.
// Pulling all 13 finance tables (~5–8s of round trips on top of the
// match-data fetch) for one filter().length is wildly over-budget on
// the /cities critical path. useFinanceData stays full-fat for the
// Finance pages that actually consume the rest of its payload.

import { useEffect, useState } from "react";
import { supabase } from "./supabase";
import { selectAll } from "./supabasePagination";
import { cityFromAbbr } from "./cityMap";
import type { MemberLike } from "./membershipStats";

type State = {
  members: MemberLike[];
  loading: boolean;
  error: string | null;
};

const INITIAL: State = { members: [], loading: true, error: null };

let cached: State | null = null;
let pending: Promise<void> | null = null;
const subscribers = new Set<(s: State) => void>();

function publish(s: State) {
  cached = s;
  subscribers.forEach((fn) => fn(s));
}

type MdapiSubRow = {
  status: string | null;
  price: number | null;
  member_email: string | null;
  activation_date: string | null;
  canceled_at: string | null;
  city_identifier: string | null;
};

async function load(): Promise<void> {
  publish({ members: [], loading: true, error: null });

  let rows: MdapiSubRow[];
  try {
    // Same column set + ordering as the mdapi_subscriptions slice in
    // useFinanceData.ts:323. selectAll for forward-compat with the
    // table growing past 1000 rows (currently ~2k).
    rows = await selectAll<MdapiSubRow>(() =>
      supabase
        .from("mdapi_subscriptions")
        .select(
          "status, price, member_email, activation_date, canceled_at, city_identifier",
        )
        .order("membership_id"),
    );
  } catch (e) {
    publish({
      members: [],
      loading: false,
      error: e instanceof Error ? e.message : "Failed to load members.",
    });
    return;
  }

  // Same mapper as useFinanceData.ts:506-520: drop unmapped cities,
  // dollars→cents shim, lowercased email comes from the API already.
  const members: MemberLike[] = [];
  for (const r of rows) {
    const city = cityFromAbbr(r.city_identifier);
    if (!city) continue;
    members.push({
      status: r.status ?? "",
      price_cents: Math.round((r.price ?? 0) * 100),
      email: r.member_email,
      activation_date: r.activation_date,
      canceled_at: r.canceled_at,
      city,
    });
  }

  publish({ members, loading: false, error: null });
}

export function useMembers(): State {
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
