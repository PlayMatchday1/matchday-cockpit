// MATCH OPS › OFFERS, PACED READS (CLAUDE.md "Reading the production API"). The same three rules as
// getPacedClient in src/lib/matchdayApi.ts, at the 2 seconds that section sets for live reads: one at a
// time, each starting paceMs after the last ENDED; no retries; a failure stops the next ones without a request. Its own small version because that client
// reads through the read client (GET only, refused in local mode) and these include POSTs the backend
// treats as reads, and because it runs for one job and then ends, while this lives as long as the server.
// So a stop lasts STOP_MS instead of until the next run. A 4xx is an answer about the request, not a
// strained server, and does not stop anything. Per server process, not across instances.

export const OFFERS_READ_PACE_MS = 2000;
export const STOP_MS = 30_000;
export const READS_STOPPED = "OffersReadsStopped";

export function makePacer(opts: {
  paceMs: number; stopMs?: number; stopsOn?: (e: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>; now?: () => number;
}) {
  const wait = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const stopMs = opts.stopMs ?? STOP_MS;
  let tail: Promise<unknown> = Promise.resolve();
  let lastEnd: number | null = null;
  let stoppedAt: number | null = null;
  return function paced<T>(read: () => Promise<T>): Promise<T> {
    const go = async () => {
      if (stoppedAt !== null && now() - stoppedAt < stopMs) {
        const e = new Error("stopped after an earlier read failed"); e.name = READS_STOPPED; throw e;
      }
      stoppedAt = null;
      if (lastEnd !== null) { const gap = lastEnd + opts.paceMs - now(); if (gap > 0) await wait(gap); }
      try { return await read(); }
      catch (e) { if (!opts.stopsOn || opts.stopsOn(e)) stoppedAt = now(); throw e; }
      finally { lastEnd = now(); }
    };
    const p = tail.then(go, go);
    tail = p.catch(() => undefined);
    return p;
  };
}
