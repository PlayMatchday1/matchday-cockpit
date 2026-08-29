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
 *                     was opened. The two buttons — keep / cancel — are the whole confirmation.
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

/* THERE IS NO TYPE-TO-CONFIRM, and there never was a requirement for one. It rendered as grey
 * placeholder text that reads DISABLED, so the commonest reading of the confirmation was that the
 * whole thing was switched off. The friction that matters is the CONSEQUENCE sentence above the
 * buttons — "Cancelling notifies all 18 players and credits each account", with the count read
 * live at confirm time — plus two clearly-labelled choices. A word to copy is not a decision.
 *
 * THE SERVER CHECK IS UNCHANGED AND IS NOT THE SAME THING. The POST still sends confirmName from
 * the PREVIEW, and the route re-reads the match LIVE and refuses if the names differ. That guard
 * catches a stale client — a match renamed between the preview and the press — which is a thing
 * typing could never have caught anyway. */

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
  result: string | null;
  open: () => Promise<void>;
  abort: () => void;
  run: () => Promise<void>;
};

export function useCancelMatch(opts: {
  env: string;
  matchId: string | number;
  source: string;                                   // the change_log source, per surface
  authHeaders: () => Promise<Record<string, string> | null>;
  /* CALLED WITH THE VERDICT, not merely called. It fires on both LANDED and NOT APPLIED — the
   * caller decides what each one means. A surface that repaints itself after NOT APPLIED is how
   * an operator concludes a cancel worked when the re-read says it did not. */
  onCancelled?: (landed: boolean) => void | Promise<void>;
}): CancelState {
  const { env, matchId, source, authHeaders, onCancelled } = opts;
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<CancelPreview | null>(null);
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
      setPreview(j as CancelPreview);
    } catch (e) {
      setBusy(false);
      setResult(`UNKNOWN — ${e instanceof Error ? e.message : String(e)}.`);
    }
  }, [busy, authHeaders, path]);

  const abort = useCallback(() => setPreview(null), []);

  const run = useCallback(async () => {
    // NO RETRIES, and no second firing while the first is in flight.
    if (!preview || busy) return;
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
      await onCancelled?.(!!j.landed);
    } catch (e) {
      setBusy(false);
      setResult(`UNKNOWN — ${e instanceof Error ? e.message : String(e)}. Reload before acting.`);
    }
  }, [preview, busy, authHeaders, path, source, onCancelled]);

  return { busy, preview, result, open, abort, run };
}
