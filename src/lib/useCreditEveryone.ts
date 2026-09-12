"use client";

/* CREDIT EVERYONE WHO PAID — the client half, in the shape useCancelMatch already established.
 *
 * TWO STEPS, AND THE FIRST IS A LIVE READ.
 *   open()  GET  — a dry run: who would be paid, how much, what is skipped and why, read AT CONFIRM
 *                  TIME. The number on the button is the roster NOW, not the roster when the editor
 *                  was opened, because the confirm is a promise about real money.
 *   run()   POST — fires once. Every amount is recomputed server-side; this sends only `notify`.
 *
 * THIS IS NOT THE CANCEL. Cancelling credits everybody and texts them, from one PATCH, and it is a
 * different card with a different colour and a different verb. This one is for the match that
 * HAPPENED — the manager did not turn up — where the record stands and the money goes back. The
 * route refuses it outright on a cancelled match, so the two can never both run.
 *
 * BUSY IS THE DOUBLE-CLICK GUARD, as it is on the cancel: true before the request, false only when
 * it resolves, and both entry points refuse while it is true.
 *
 * THE VERDICT IS PER PLAYER and comes back read from the API, never inferred from the status code:
 * LANDED / ABORTED / FAILED / REFUSED, with counts. A run of twenty can end half done — that is the
 * expected shape when retries are forbidden — and pressing the button again credits only the ones
 * that did not land.
 */

import { useCallback, useState } from "react";
import { supabase } from "@/lib/supabase";
import { errorText } from "@/lib/errorText";
import { fmtUsd, type CreditPlan } from "@/lib/creditsModel";

export type CreditPreview = {
  matchId: number;
  name: string;
  cancelled: boolean;
  plan: CreditPlan;
  alreadyCreditedCount: number;
  refused: string | null;
  cancelCredited: { count: number; totalCents: number } | null;
  notifyAvailable: boolean;
  caps: { maxRunCents: number; maxRunPlayers: number };
};

export type CreditRunResult = {
  ran: number; landed: number; aborted: number; failed: number; refusedPlayers: number;
  totalCreditedCents: number;
  results: { userId: number; cents: number; verdict: string; detail?: string }[];
  skipped: { reason: string; count: number; cents: number }[];
};

async function authFetch(path: string, init?: RequestInit): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return fetch(path, { ...init, cache: "no-store",
    headers: { ...(init?.headers ?? {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
}

export function useCreditEveryone({ env, matchId }: { env: string; matchId: string | number }) {
  const [preview, setPreview] = useState<CreditPreview | null>(null);
  const [result, setResult] = useState<CreditRunResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notify, setNotify] = useState(false);   // OFF unless somebody turns it on

  const base = `/api/matchday/${env}/matches/${matchId}/credit-all`;

  /** The dry run. Writes nothing. */
  const load = useCallback(async (): Promise<CreditPreview | null> => {
    try {
      const res = await authFetch(base);
      const j = await res.json();
      if (!res.ok) { setError(j?.error ?? `Could not read the roster (${res.status})`); return null; }
      setError(null);
      return j as CreditPreview;
    } catch (e) { setError(errorText(e, "Could not read the roster.")); return null; }
  }, [base]);

  const open = useCallback(async () => {
    if (busy) return;
    setBusy(true); setResult(null);
    try { setPreview(await load()); } finally { setBusy(false); }
  }, [busy, load]);

  const abort = useCallback(() => { setPreview(null); setError(null); }, []);

  const run = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await authFetch(base, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notify }),
      });
      const j = await res.json();
      if (!res.ok) { setError(j?.error ?? `The run failed (${res.status})`); return; }
      setResult(j as CreditRunResult);
      setPreview(null);
      setError(null);
    } catch (e) { setError(errorText(e, "The run failed.")); }
    finally { setBusy(false); }
  }, [base, busy, notify]);

  return { preview, result, error, busy, notify, setNotify, open, abort, run, reload: load };
}

/** The confirm's headline: a count and a number, live. */
export const creditStakes = (plan: CreditPlan): string =>
  `Credit ${plan.pay.length} player${plan.pay.length === 1 ? "" : "s"} ${fmtUsd(plan.totalCents)}?`;
