"use client";

/* THE ONE-OFF "APPLY FIXED LADDER" (Ryan, 2026-10-24). Writes the fixed default ladder
 * (fakeLadder.ts FIXED_LADDER: 12 / 8 / 8 / 6 / 6, each capped at capacity) onto upcoming matches
 * from FIXED_LADDER_FROM (Nov 2). Oct 24 – Nov 1 were set by hand.
 *
 * NOTHING IS READ OR WRITTEN UNTIL ASKED. "Count matches" reads the live preview (about three
 * MatchDay requests); the count on the apply button is the count of rows marked "will change" —
 * the same planFixedLadder the write route runs again on a fresh read before each write.
 *
 * THE RUN. One match at a time, no two MatchDay requests closer than two seconds, every write
 * through recordWrite (change_log source "Apply fixed ladder", save_id fixed-ladder-<run>-<match>).
 * It STOPS at the first write that does not land. Nothing is retried. Running it again is safe:
 * matches already on the fixed ladder come back "already on the fixed ladder" and are not written.
 * Closing the tab stops the run; change_log is the record of what landed.
 *
 * PRODUCTION ONLY — an environment switch would let someone preview one environment and write
 * the other.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { FIXED_LADDER, FIXED_LADDER_SKIP_LABEL, RUNG_MARKS, RUNG_KEYS, type FixedLadderStatus } from "@/lib/fakeLadder";

const WRITE_ENV = "production";

type Row = {
  id: number; name: string; city: string | null; field: string | null; startDate: string;
  hoursToKickoff: number | null; capacity: number | null;
  current: Record<string, number | null>; target: Record<string, number> | null; status: FixedLadderStatus;
  handEdit: { source: string; at: string } | null;
};
type Preview = { from: string; rows: Row[]; counts: Record<FixedLadderStatus, number>; checkedAt: string; canWrite: boolean; fetched: number };
type Result = { id: number; label: string; verdict: "landed" | "unchanged" | "skipped" | "failed" | "notapplied" | "unknown"; note: string };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/* WALL CLOCK, READ OFF THE STRING. startDate carries a Z it does not mean; a Date would shift it. */
function wallLabel(s: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s);
  if (!m) return "date unknown";
  const h = Number(m[4]);
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])} · ${h % 12 === 0 ? 12 : h % 12}:${m[5]} ${h >= 12 ? "PM" : "AM"}`;
}
const fromLabel = (ymd: string) => { const [, mo, d] = ymd.split("-"); return `${MONTHS[Number(mo) - 1]} ${Number(d)}`; };
/* A TRUE-UTC TIMESTAMP, shown in Central. */
const ct = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " CT";
const ladderText = (l: Record<string, number | null> | null) =>
  l ? RUNG_KEYS.map((k) => (l[k] == null ? "–" : String(l[k]))).join(" / ") : "–";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function authed(path: string, init?: RequestInit) {
  const { data: s } = await supabase.auth.getSession();
  const t = s.session?.access_token;
  if (!t) throw new Error("Not signed in.");
  return fetch(path, { ...init, cache: "no-store", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" } });
}

export default function ApplyFixedLadderCard() {
  const [data, setData] = useState<Preview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<Result[]>([]);
  const [halt, setHalt] = useState<string | null>(null);
  const [runTotal, setRunTotal] = useState(0);
  const stopRef = useRef(false);

  const load = useCallback(async () => {
    setLoading(true); setErr(null); setConfirming(false);
    try {
      const r = await authed(`/api/matchday/${WRITE_ENV}/fixed-ladder`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setData(j);
    } catch (e) {
      // AN ERROR IS AN ERROR — never an empty list that reads as "nothing to change".
      setErr(e instanceof Error ? e.message : String(e)); setData(null);
    } finally { setLoading(false); }
  }, []);

  const changing = useMemo(() => (data?.rows ?? []).filter((r) => r.status === "change"), [data]);
  const handEdited = useMemo(() => (data?.rows ?? []).filter((r) => r.status === "handEdited"), [data]);

  /* WHY THE BUTTON IS GREY, said beside it — a disabled control with no reason reads as broken. */
  const blocked = !data ? "Count matches first."
    : !data.canWrite ? "Needs EDIT MATCHES."
    : changing.length === 0 ? "Nothing needs changing."
    : null;

  const run = useCallback(async () => {
    if (!data || running) return;
    setConfirming(false); setRunning(true); setHalt(null); setResults([]); stopRef.current = false;
    const targets = changing;
    setRunTotal(targets.length);
    const runId = `${new Date().toISOString().slice(0, 16).replace(/[^0-9]/g, "")}-${Math.random().toString(36).slice(2, 6)}`;
    const out: Result[] = [];
    let stopped: string | null = null;
    for (const r of targets) {
      if (stopRef.current) { stopped = "Stopped by the operator."; break; }
      const label = `${wallLabel(r.startDate)} · ${r.field ?? r.name}`;
      let res: Response | null = null; let j: Record<string, unknown> = {};
      try {
        res = await authed(`/api/matchday/${WRITE_ENV}/fixed-ladder/${r.id}`, { method: "POST", body: JSON.stringify({ runId }) });
        j = await res.json().catch(() => ({}));
      } catch (e) {
        // NO ANSWER IS UNKNOWN, not failed — the request may have reached MatchDay.
        out.push({ id: r.id, label, verdict: "unknown", note: e instanceof Error ? e.message : String(e) });
        stopped = `No answer for match ${r.id} — it may or may not have been written. Check it before running again.`;
        break;
      }
      const status = j.status as FixedLadderStatus | undefined;
      if (res.ok && status && status !== "change") {
        out.push({ id: r.id, label, verdict: status === "unchanged" ? "unchanged" : "skipped",
          note: FIXED_LADDER_SKIP_LABEL[status as Exclude<FixedLadderStatus, "change">] ?? status });
      } else if (res.ok && j.outcome === "landed") {
        out.push({ id: r.id, label, verdict: "landed", note: ladderText(r.target) });
      } else {
        const verdict = (j.outcome === "notapplied" || j.outcome === "unknown") ? j.outcome : "failed";
        out.push({ id: r.id, label, verdict, note: String(j.error ?? `HTTP ${res.status}`) });
        stopped = `Match ${r.id} came back ${String(verdict).toUpperCase()}: ${String(j.error ?? "the read-back did not show the fixed ladder")}. Stopped — nothing after it was sent.`;
        break;
      }
      setResults([...out]);
      // THE PAUSE BETWEEN CALLS — the route spaces its own requests; this spaces the calls.
      await sleep(2000);
    }
    setResults([...out]);
    setHalt(stopped);
    setRunning(false);
  }, [data, running, changing]);

  const tally = (v: Result["verdict"]) => results.filter((o) => o.verdict === v).length;
  // Three requests two seconds apart, then a two-second pause: about 6 seconds a match.
  const minutes = Math.max(1, Math.ceil((changing.length * 6) / 60));
  const btn = "rounded-md px-4 py-2 text-sm font-bold text-deep-green transition disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <section data-testid="fixed-ladder-card" className="rounded-2xl border-[1.5px] border-cream-line bg-white p-5 shadow-md shadow-deep-green/10">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-bold text-deep-green">Apply fixed ladder (one-off)</h3>
          <p className="mt-1 text-xs text-deep-green/65">
            Most spots shown as left: {RUNG_MARKS.map((m) => `${m}h ${FIXED_LADDER[m]}`).join(" · ")}, each capped at the match&apos;s capacity.
            Production, {`upcoming matches from ${fromLabel(data?.from ?? "2026-11-02")} onward.`} Skips matches 36 hours or less from kickoff, cancelled ones,
            and any whose ladder or spots left was changed by hand in the Clubhouse (Retool edits can&apos;t be seen). One match at a time,
            two seconds between MatchDay requests, every write logged; it stops at the first write that doesn&apos;t land and never retries.
          </p>
          {data && (
            <p className="mt-1 text-[11px] text-deep-green/50" data-testid="fixed-ladder-counts">
              Checked {ct(data.checkedAt)} · {data.rows.length} upcoming · <b className="text-deep-green">{data.counts.change} would change</b>
              {" · "}{data.counts.unchanged} already on it · {data.counts.handEdited} hand-edited · {data.counts.inside36h} inside 36h
              {" · "}{data.counts.cancelled} cancelled · {data.counts.nocap} no capacity
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" data-testid="fixed-ladder-count" onClick={() => void load()} disabled={loading || running}
            className={`${btn} border-[1.5px] border-deep-green/25 bg-white hover:bg-cream-soft`}>
            {loading ? "Counting…" : data ? "Count again" : "Count matches"}
          </button>
          {running ? (
            <button type="button" data-testid="fixed-ladder-stop" onClick={() => { stopRef.current = true; }}
              className={`${btn} border-[1.5px] border-coral/50 bg-white text-coral`}>Stop after this match</button>
          ) : confirming ? (
            <>
              <button type="button" data-testid="fixed-ladder-confirm" onClick={() => void run()} className={`${btn} bg-coral text-white`}>
                Yes, write {changing.length} matches
              </button>
              <button type="button" onClick={() => setConfirming(false)} className={`${btn} border-[1.5px] border-deep-green/25 bg-white`}>Cancel</button>
            </>
          ) : (
            <button type="button" data-testid="fixed-ladder-apply" onClick={() => setConfirming(true)} disabled={!!blocked || loading} title={blocked ?? undefined}
              className={`${btn} bg-mint hover:bg-mint-hover`}>
              Apply to {changing.length} matches
            </button>
          )}
        </div>
      </div>
      {blocked && data && <p className="mt-2 text-[11px] text-deep-green/55">{blocked}</p>}
      {confirming && <p className="mt-2 text-[11px] text-deep-green/70">About {minutes} min. Keep this tab open; closing it stops the run.</p>}
      {err && <div className="mt-3 rounded-md border border-coral/40 bg-coral-soft px-3 py-2 text-xs text-coral">Couldn&apos;t count: {err}</div>}

      {(running || results.length > 0) && (
        <div className="mt-3 rounded-md border border-cream-line bg-cream-soft/40 p-3 text-xs text-deep-green" data-testid="fixed-ladder-progress">
          {running ? `Writing ${results.length + 1} of ${runTotal}…` : "Run finished."}
          {" "}{tally("landed")} landed · {tally("unchanged")} unchanged · {tally("skipped")} skipped
          {tally("failed") + tally("notapplied") + tally("unknown") > 0 && <> · <b className="text-coral">{tally("failed")} failed · {tally("notapplied")} not applied · {tally("unknown")} unknown</b></>}
          {halt && <div className="mt-1 font-bold text-coral" data-testid="fixed-ladder-halt">{halt}</div>}
        </div>
      )}

      {data && (changing.length > 0 || handEdited.length > 0) && !running && results.length === 0 && (
        <div className="mt-4 max-h-96 overflow-auto">
          <table className="w-full text-left text-xs" data-testid="fixed-ladder-rows">
            <thead><tr className="text-[10px] uppercase tracking-wider text-deep-green/50">
              <th className="py-1.5 pr-3 font-bold">Match</th><th className="py-1.5 pr-3 font-bold">City</th><th className="py-1.5 pr-3 font-bold">Cap</th>
              <th className="py-1.5 pr-3 font-bold">Now (36/24/12/6/3h)</th><th className="py-1.5 pr-3 font-bold">Becomes</th><th className="py-1.5 font-bold">Status</th>
            </tr></thead>
            <tbody>
              {[...changing, ...handEdited].map((r) => (
                <tr key={r.id} className="border-t border-cream-line align-top">
                  <td className="py-1.5 pr-3 text-deep-green"><a className="underline" href={`/match-ops/matches/${r.id}`}>{wallLabel(r.startDate)} · {r.field ?? r.name}</a></td>
                  <td className="py-1.5 pr-3 text-deep-green/70">{r.city ?? "–"}</td>
                  <td className="py-1.5 pr-3 text-deep-green/70">{r.capacity ?? "–"}</td>
                  <td className="whitespace-nowrap py-1.5 pr-3 text-deep-green/70">{ladderText(r.current)}</td>
                  <td className="whitespace-nowrap py-1.5 pr-3 text-deep-green">{r.status === "change" ? ladderText(r.target) : "–"}</td>
                  <td className="py-1.5 text-deep-green/70">{r.status === "change" ? "will change"
                    : `${FIXED_LADDER_SKIP_LABEL.handEdited}${r.handEdit ? ` (${r.handEdit.source}, ${ct(r.handEdit.at)})` : ""}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {results.length > 0 && !running && (
        <div className="mt-4 max-h-96 overflow-auto">
          <table className="w-full text-left text-xs" data-testid="fixed-ladder-results">
            <tbody>
              {results.map((o) => (
                <tr key={o.id} className="border-t border-cream-line align-top">
                  <td className="py-1.5 pr-3 text-deep-green">{o.label}</td>
                  <td className={"py-1.5 pr-3 font-bold " + (["failed", "notapplied", "unknown"].includes(o.verdict) ? "text-coral" : "text-deep-green")}>{o.verdict.toUpperCase()}</td>
                  <td className="py-1.5 text-deep-green/70">{o.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
