"use client";

/* CANCELLING A MATCH — ONE IMPLEMENTATION, SHARED.
 *
 * This write texts every signed-up player and credits every account. There must not be two copies
 * of it: Gameday Ops' drawer had the working one and the Master Schedule panel rendered a red
 * button that did nothing, with a footnote admitting it ("Would call PATCH …, not wired in this
 * phase"). Rather than write a second one, both now call this.
 *
 * WHAT THE ENDPOINT ACTUALLY DOES, and the copy depends on it: POST /api/matchday/{env}/matches/
 * {id}/cancel fires the single PATCH /admin/matches/{id}/cancel that Retool fires. A read-only
 * audit of the Retool production export proved there is no separate credit or notify call — the
 * WALLET CREDIT and the SMS are server-side effects of that one PATCH. It is a CREDIT, not a card
 * refund, which is why the confirmation says "credits each account" and not "refunds".
 *
 * TWO STEPS, AND THE FIRST IS A LIVE READ.
 *   preview()  GET  — { name, count, totalCents, alreadyCancelled } read AT CONFIRM TIME, so the
 *                     number in the confirmation is the roster now, not the roster when the panel
 *                     was opened.
 *   run()      POST — fires ONCE. Writes never retry: there is no Idempotency-Key on this API and
 *                     a duplicate cancel could double-notify or double-credit a real person.
 *
 * THE VERDICT IS A RE-READ. The route re-reads match.isCancelled and returns `landed`; a 2xx is
 * not proof and is never treated as one. LANDED / NOT APPLIED / UNKNOWN come back as a verdict
 * string the caller renders verbatim.
 *
 * BUSY IS THE GUARD AGAINST A DOUBLE CLICK. `busy` goes true before the request and false only
 * when it resolves, and both entry points refuse while it is true. A control that stays clickable
 * during a write that texts people is a control that texts them twice.
 *
 * CONFINEMENT IS THE ROUTE'S JOB, NOT THIS FILE'S. /api/matchday/ is on CONFINED_ROUTE_PREFIXES so
 * a confined operator reaches it, and the route then calls assertMatchInScope on the ID — filtering
 * a list is not authorisation. A confined operator can cancel in their own city and is refused,
 * by id, outside it.
 */

import { useCallback, useState } from "react";

export type CancelPreview = {
  name: string;
  count: number;
  perPlayerCents: number;
  totalCents: number;
  alreadyCancelled: boolean;
};

/** The word the operator types. Lowercase, exact, trimmed — a decision, not a transcription
 *  exercise. The friction belongs in the CONSEQUENCE stated above the box, not in copying a name. */
export const CANCEL_WORD = "cancel";

/** THE ONE LINE, and it is data. N is the live roster count read at confirm time. */
export function cancelStakes(count: number): string {
  return count === 0
    ? "No players are signed up."
    : `Cancelling notifies all ${count} player${count === 1 ? "" : "s"} and credits each account.`;
}

const dollars = (cents: number) => (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export type CancelState = {
  busy: boolean;
  preview: CancelPreview | null;
  typed: string;
  result: string | null;
  setTyped: (s: string) => void;
  open: () => Promise<void>;
  abort: () => void;
  run: () => Promise<void>;
  ready: boolean;
};

export function useCancelMatch(opts: {
  env: string;
  matchId: string | number;
  source: string;                                   // the change_log source, per surface
  authHeaders: () => Promise<Record<string, string> | null>;
  onCancelled?: () => void | Promise<void>;
}): CancelState {
  const { env, matchId, source, authHeaders, onCancelled } = opts;
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<CancelPreview | null>(null);
  const [typed, setTyped] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const path = `/api/matchday/${env}/matches/${matchId}/cancel`;

  const open = useCallback(async () => {
    if (busy) return;
    const headers = await authHeaders();
    if (!headers) { setResult("No active session — sign in again."); return; }
    setBusy(true); setResult(null);
    try {
      // LIVE, at confirm time. A count rendered when the panel opened is a count that may have
      // moved, and this sentence is a promise to real people.
      const res = await fetch(path, { headers, cache: "no-store" });
      const j = await res.json();
      setBusy(false);
      if (!res.ok) { setResult(`Couldn't read the cancellation preview: ${j.error || res.status}`); return; }
      setPreview(j as CancelPreview); setTyped("");
    } catch (e) {
      setBusy(false);
      setResult(`UNKNOWN — ${e instanceof Error ? e.message : String(e)}.`);
    }
  }, [busy, authHeaders, path]);

  const abort = useCallback(() => { setPreview(null); setTyped(""); }, []);

  const run = useCallback(async () => {
    // NO RETRIES, and no second firing while the first is in flight.
    if (!preview || busy || typed.trim() !== CANCEL_WORD) return;
    const headers = await authHeaders();
    if (!headers) { setResult("No active session — sign in again."); return; }
    setBusy(true); setResult(null);
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ confirmName: preview.name, source }),
      });
      const j = await res.json();
      setBusy(false);
      if (!res.ok) { setResult(`Cancel failed: ${j.error || res.status}. Nothing was credited.`); return; }
      setPreview(null);
      // FROM THE RE-READ, never the status code.
      setResult(j.landed
        ? `LANDED — “${j.name}” is cancelled. ${j.count} player(s) credited $${dollars(j.totalCents)} and texted (re-read confirmed).`
        : `NOT APPLIED — the re-read shows the match is NOT cancelled; nothing was credited. Reload and check before retrying.`);
      await onCancelled?.();
    } catch (e) {
      setBusy(false);
      setResult(`UNKNOWN — ${e instanceof Error ? e.message : String(e)}. Reload before acting.`);
    }
  }, [preview, busy, typed, authHeaders, path, source, onCancelled]);

  return { busy, preview, typed, result, setTyped, open, abort, run, ready: typed.trim() === CANCEL_WORD };
}
