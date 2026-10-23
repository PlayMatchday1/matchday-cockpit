"use client";

/* THE NEW FAKE LADDER — preview, the bulk "Apply new ladder" action, and the switch record.
 *
 * NOTHING IS WRITTEN UNTIL THE CONFIRM. The page opens on a live preview: every upcoming match in
 * scope, what the new ladder would change on it, and why the rest are skipped. The count on the
 * button is the count of rows marked "will change" — the same planNewLadder the write route runs
 * again on a fresh read before each write.
 *
 * THE RUN. Recorded first (fake_ladder_switches — the switch date for the before/after comparison),
 * then one match at a time, one MatchDay request per second, and it STOPS at the first write that
 * does not land. Nothing is retried. Running it again is safe: matches already on the new ladder
 * come back "already on the new ladder" and are not written.
 *
 * PRODUCTION ONLY. Same reasoning as Lapsed Spots: an environment switch on a page like this would
 * let someone preview one environment and write the other.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { NEW_LADDER_OFFSET, NEW_LADDER_SKIP_LABEL, RUNG_MARKS, RUNG_KEYS, type NewLadderStatus } from "@/lib/fakeLadder";

const WRITE_ENV = "production";

type Row = {
  id: number; name: string; city: string | null; field: string | null; startDate: string;
  hoursToKickoff: number | null; capacity: number | null;
  current: Record<string, number | null>; target: Record<string, number> | null; status: NewLadderStatus;
};
type Switch = {
  id: number; kind: "defaults" | "bulk"; scope_city: string | null; actor_email: string | null;
  started_at: string; finished_at: string | null; previewed: number | null; landed: number | null;
  unchanged: number | null; skipped: number | null; not_landed: number | null; stopped_reason: string | null;
};
type Preview = {
  city: string | null; confined: boolean; cities: string[]; rows: Row[];
  counts: Record<NewLadderStatus, number>; checkedAt: string; canWrite: boolean;
  switches: Switch[]; switchesError: string | null;
};
type Result = { id: number; label: string; verdict: "landed" | "unchanged" | "skipped" | "failed" | "notapplied" | "unknown"; note: string };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/* WALL CLOCK, READ OFF THE STRING. startDate carries a Z it does not mean; a Date would shift it. */
function wallLabel(s: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s);
  if (!m) return "date unknown";
  const h = Number(m[4]);
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])} · ${h % 12 === 0 ? 12 : h % 12}:${m[5]} ${h >= 12 ? "PM" : "AM"}`;
}
/* A TRUE-UTC TIMESTAMP (started_at), shown in Central. */
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

export default function FakeLadderView() {
  const [city, setCity] = useState<string>("");
  const [data, setData] = useState<Preview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [onlyChange, setOnlyChange] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<Result[]>([]);
  const [halt, setHalt] = useState<string | null>(null);
  const [runTotal, setRunTotal] = useState(0);
  const stopRef = useRef(false);

  const load = useCallback(async (c: string) => {
    setLoading(true); setErr(null);
    try {
      const r = await authed(`/api/matchday/${WRITE_ENV}/fake-ladder${c ? `?city=${encodeURIComponent(c)}` : ""}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setData(j);
    } catch (e) {
      // AN ERROR IS AN ERROR — never an empty list that reads as "nothing to change".
      setErr(e instanceof Error ? e.message : String(e)); setData(null);
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(city); }, [load, city]);

  const changing = useMemo(() => (data?.rows ?? []).filter((r) => r.status === "change"), [data]);
  const shown = useMemo(() => (data?.rows ?? []).filter((r) => !onlyChange || r.status === "change"), [data, onlyChange]);
  const scopeLabel = data?.city ?? (city || "every city");

  /* WHY THE BUTTON IS GREY, said beside it — a disabled control with no reason reads as broken. */
  const blocked = !data ? "Loading the preview…"
    : !data.canWrite ? "Needs EDIT MATCHES."
    : data.switchesError ? `The switch can't be recorded (${data.switchesError}) — migration 0231 has to be applied first.`
    : changing.length === 0 ? "Nothing in scope needs changing."
    : null;

  const run = useCallback(async () => {
    if (!data || running) return;
    setConfirming(false); setRunning(true); setHalt(null); setResults([]); stopRef.current = false;
    const targets = changing;
    setRunTotal(targets.length);
    const out: Result[] = [];
    let switchId: number | null = null;
    let stopped: string | null = null;
    try {
      const s = await authed(`/api/matchday/${WRITE_ENV}/fake-ladder`, {
        method: "POST", body: JSON.stringify({ action: "start", city: data.city, previewed: targets.length }),
      });
      const sj = await s.json();
      if (!s.ok) throw new Error(sj.error ?? `HTTP ${s.status}`);
      switchId = Number(sj.id);

      for (const r of targets) {
        if (stopRef.current) { stopped = "Stopped by the operator."; break; }
        const label = `${wallLabel(r.startDate)} · ${r.field ?? r.name}`;
        let res: Response | null = null; let j: Record<string, unknown> = {};
        try {
          res = await authed(`/api/matchday/${WRITE_ENV}/fake-ladder/${r.id}`, { method: "POST", body: JSON.stringify({ switchId }) });
          j = await res.json().catch(() => ({}));
        } catch (e) {
          // NO ANSWER IS UNKNOWN, not failed — the request may have reached MatchDay.
          out.push({ id: r.id, label, verdict: "unknown", note: e instanceof Error ? e.message : String(e) });
          stopped = `No answer for match ${r.id} — it may or may not have been written. Check it before running again.`;
          break;
        }
        const status = j.status as NewLadderStatus | undefined;
        if (res.ok && status && status !== "change") {
          out.push({ id: r.id, label, verdict: status === "unchanged" ? "unchanged" : "skipped",
            note: NEW_LADDER_SKIP_LABEL[status as Exclude<NewLadderStatus, "change">] ?? status });
        } else if (res.ok && j.outcome === "landed") {
          out.push({ id: r.id, label, verdict: "landed", note: ladderText(r.target) });
        } else {
          const verdict = (j.outcome === "notapplied" || j.outcome === "unknown") ? j.outcome : "failed";
          out.push({ id: r.id, label, verdict, note: String(j.error ?? `HTTP ${res.status}`) });
          stopped = `Match ${r.id} came back ${String(verdict).toUpperCase()}: ${String(j.error ?? "the read-back did not show the new ladder")}. Stopped — nothing after it was sent.`;
          break;
        }
        setResults([...out]);
        // THE PAUSE BETWEEN CALLS — the route spaces its own requests; this spaces the calls.
        await sleep(1000);
      }
    } catch (e) {
      stopped = e instanceof Error ? e.message : String(e);
    }
    setResults([...out]);
    setHalt(stopped);
    if (switchId != null) {
      const tally = (v: Result["verdict"]) => out.filter((o) => o.verdict === v).length;
      await authed(`/api/matchday/${WRITE_ENV}/fake-ladder`, {
        method: "POST", body: JSON.stringify({
          action: "finish", id: switchId, landed: tally("landed"), unchanged: tally("unchanged"), skipped: tally("skipped"),
          notLanded: tally("failed") + tally("notapplied") + tally("unknown"), stoppedReason: stopped,
        }),
      }).catch(() => undefined);
    }
    setRunning(false);
    void load(city);
  }, [data, running, changing, load, city]);

  const done = results.length;
  const minutes = Math.max(1, Math.ceil((changing.length * 4) / 60));

  return (
    <div className="fl">
      <div className="fl-head">
        <div>
          <h1 className="fl-h1">Fake ladder</h1>
          <p className="fl-sub">The new default shows at most 2 or 3 fakes early and none from 3 hours out. Real players replace fakes one for one.</p>
        </div>
      </div>

      <section className="fl-card" data-testid="fl-rule">
        <div className="fl-cardh">The new ladder · most spots shown as left</div>
        <div className="fl-marks">
          {RUNG_MARKS.map((m) => (
            <div className="fl-mark" key={m}>
              <span className="fl-markh">{m} H</span>
              <span className="fl-markv">{NEW_LADDER_OFFSET[m] === 0 ? "capacity" : `capacity − ${NEW_LADDER_OFFSET[m]}`}</span>
              <span className="fl-markf">{NEW_LADDER_OFFSET[m] === 0 ? "no fakes" : `up to ${NEW_LADDER_OFFSET[m]} fakes`}</span>
            </div>
          ))}
        </div>
        <p className="fl-note">New matches created in the Clubhouse get this ladder. Staff can still change any match by hand in the match panel.</p>
      </section>

      <div className="fl-controls">
        {!data?.confined && (
          <label className="fl-sel">
            <span>City</span>
            <select data-testid="fl-city" value={city} disabled={running} onChange={(e) => setCity(e.target.value)}>
              <option value="">All cities</option>
              {(data?.cities ?? []).map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
        )}
        <button type="button" className="fl-btn" disabled={loading || running} onClick={() => void load(city)} data-testid="fl-refresh">
          {loading ? "Checking…" : "Refresh"}
        </button>
      </div>

      {err && <div className="fl-err" data-testid="fl-error">Couldn&apos;t read upcoming matches: {err}</div>}

      {data && (
        <section className="fl-card fl-sum" data-testid="fl-summary">
          <div className="fl-big"><span data-testid="fl-count">{data.counts.change}</span> {data.counts.change === 1 ? "match" : "matches"} will change</div>
          <div className="fl-scope">Upcoming matches in {scopeLabel} · checked {ct(data.checkedAt)}</div>
          <ul className="fl-skips" data-testid="fl-skips">
            {(Object.keys(NEW_LADDER_SKIP_LABEL) as Exclude<NewLadderStatus, "change">[]).map((s) => (
              <li key={s} data-status={s}><b>{data.counts[s]}</b> {NEW_LADDER_SKIP_LABEL[s]}</li>
            ))}
          </ul>
          <div className="fl-act">
            <button type="button" className="fl-go" data-testid="fl-apply" disabled={!!blocked || running || loading}
              onClick={() => setConfirming(true)}>
              Apply new ladder to {data.counts.change}
            </button>
            {blocked && <span className="fl-why">{blocked}</span>}
          </div>
        </section>
      )}

      {(running || results.length > 0 || halt) && (
        <section className="fl-card" data-testid="fl-run">
          <div className="fl-cardh">{running ? `Writing ${done} of ${runTotal}…` : `Run finished: ${done} of ${runTotal}`}</div>
          {running && <button type="button" className="fl-btn" onClick={() => { stopRef.current = true; }}>Stop after this match</button>}
          {halt && <div className="fl-err" data-testid="fl-halt">{halt}</div>}
          <ul className="fl-res">
            {results.map((r) => (
              <li key={r.id} data-verdict={r.verdict}>
                <span className={`fl-v fl-v-${r.verdict}`}>{r.verdict === "notapplied" ? "NOT APPLIED" : r.verdict.toUpperCase()}</span>
                <span className="fl-resl">{r.label}</span>
                {r.note && <span className="fl-resn">{r.note}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {data && (
        <section className="fl-card" data-testid="fl-switches">
          <div className="fl-cardh">Switch record</div>
          {data.switchesError ? (
            <div className="fl-err">Not readable: {data.switchesError}</div>
          ) : data.switches.length === 0 ? (
            <div className="fl-empty">No switch recorded yet.</div>
          ) : (
            <ul className="fl-swl">
              {data.switches.map((s) => (
                <li key={s.id}>
                  <b>{ct(s.started_at)}</b>
                  <span>{s.kind === "defaults" ? "New defaults for new matches" : `Applied to ${s.scope_city ?? "every city"}`}</span>
                  {s.kind === "bulk" && (
                    <span className="fl-swn">
                      {s.finished_at == null ? "not finished" : `${s.landed ?? 0} landed of ${s.previewed ?? 0}`}
                      {s.stopped_reason ? ` · stopped: ${s.stopped_reason}` : ""}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {data && (
        <section className="fl-card" data-testid="fl-list">
          <div className="fl-listh">
            <div className="fl-cardh">Matches</div>
            <label className="fl-chk"><input type="checkbox" checked={onlyChange} onChange={(e) => setOnlyChange(e.target.checked)} /> Will change only</label>
          </div>
          {shown.length === 0 ? <div className="fl-empty">No matches to show.</div> : (
            <ul className="fl-rows">
              {shown.map((r) => (
                <li key={r.id} className="fl-row" data-testid="fl-row" data-status={r.status}>
                  <div className="fl-rt">
                    <b>{wallLabel(r.startDate)}</b>
                    <span>{r.field ?? r.name}{r.city ? ` · ${r.city}` : ""}</span>
                  </div>
                  <div className="fl-rl">
                    <span className="fl-cap">cap {r.capacity ?? "–"}</span>
                    <span className="fl-lad">{ladderText(r.current)}</span>
                    {r.status === "change" && <><span className="fl-arrow">→</span><span className="fl-lad fl-new">{ladderText(r.target)}</span></>}
                    {r.status !== "change" && <span className="fl-skip">{NEW_LADDER_SKIP_LABEL[r.status]}</span>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {confirming && data && (
        <div className="fl-modalwrap" role="dialog" aria-modal="true">
          <div className="fl-modal" data-testid="fl-confirm">
            <h2>Apply the new ladder to {changing.length} {changing.length === 1 ? "match" : "matches"}?</h2>
            <p>Upcoming matches in {scopeLabel}. Each one gets capacity −2 / −2 / −3 / −2 / capacity at 36 / 24 / 12 / 6 / 3 hours.
              Matches already past their 3h mark are left alone. It writes one match at a time, about {minutes} min, and stops at the
              first write that does not land. This is recorded as the switch date for {scopeLabel}.</p>
            <div className="fl-modalf">
              <button type="button" className="fl-btn" onClick={() => setConfirming(false)}>Cancel</button>
              <button type="button" className="fl-go" data-testid="fl-confirm-go" onClick={() => void run()}>Apply to {changing.length}</button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        .fl{--line:#E2E9E4;--mut:#5F7268;--forest:#12432F;--red:#A5321B;--redBg:#FDF0EC;--redLine:#F2C9BC;
          max-width:1100px;margin:0 auto;padding:20px 16px 60px;color:#14261C;font-size:14px}
        .fl *{box-sizing:border-box}
        .fl-h1{font-size:22px;font-weight:800;margin:0}
        .fl-sub{margin:4px 0 16px;color:var(--mut);line-height:1.5}
        .fl-card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin-bottom:14px}
        .fl-cardh{font-size:11px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#6F8478;margin-bottom:10px}
        .fl-marks{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px}
        .fl-mark{border:1px solid var(--line);border-radius:10px;padding:8px;display:flex;flex-direction:column;gap:2px;min-width:0}
        .fl-markh{font-size:11px;font-weight:800;color:#6F8478}
        .fl-markv{font-weight:700;font-size:13px;overflow-wrap:anywhere}
        .fl-markf{font-size:11.5px;color:var(--mut)}
        .fl-note{margin:10px 0 0;color:var(--mut);font-size:12.5px;line-height:1.5}
        .fl-controls{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;margin-bottom:14px}
        .fl-sel{display:flex;flex-direction:column;gap:4px;font-size:11px;font-weight:700;color:#6F8478;text-transform:uppercase;letter-spacing:.06em}
        .fl-sel select{font:inherit;font-size:14px;text-transform:none;letter-spacing:0;color:#14261C;border:1px solid var(--line);border-radius:8px;padding:7px 10px;background:#fff;max-width:100%}
        .fl-btn{border:1px solid var(--line);background:#fff;border-radius:999px;padding:8px 16px;font:inherit;font-size:13px;font-weight:700;color:#3C4F44;cursor:pointer}
        .fl-btn:disabled{opacity:.5;cursor:default}
        .fl-go{border:1px solid var(--forest);background:var(--forest);color:#fff;border-radius:999px;padding:9px 18px;font:inherit;font-size:13.5px;font-weight:800;cursor:pointer}
        .fl-go:disabled{opacity:.45;cursor:default}
        .fl-err{background:var(--redBg);border:1px solid var(--redLine);color:#7C2412;border-radius:10px;padding:10px 12px;margin:8px 0;line-height:1.5;overflow-wrap:anywhere}
        .fl-big{font-size:20px;font-weight:800}
        .fl-big span{font-variant-numeric:tabular-nums}
        .fl-scope{color:var(--mut);font-size:12.5px;margin-top:2px}
        .fl-skips{list-style:none;padding:0;margin:10px 0 12px;display:flex;flex-wrap:wrap;gap:6px 14px;font-size:12.5px;color:var(--mut)}
        .fl-skips b{color:#14261C}
        .fl-act{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
        .fl-why{font-size:12.5px;color:var(--mut)}
        .fl-res,.fl-swl,.fl-rows{list-style:none;padding:0;margin:0}
        .fl-res li{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:baseline;padding:6px 0;border-top:1px solid var(--line);font-size:13px}
        .fl-resl{min-width:0;overflow-wrap:anywhere}
        .fl-resn{color:var(--mut);font-size:12px;overflow-wrap:anywhere}
        .fl-v{font-size:10.5px;font-weight:800;letter-spacing:.06em;border-radius:999px;padding:2px 8px;white-space:nowrap}
        .fl-v-landed{background:#E4FBEC;color:#0B7A3E}
        .fl-v-unchanged,.fl-v-skipped{background:#EEF2EF;color:#4C5F55}
        .fl-v-failed{background:var(--redBg);color:var(--red)}
        .fl-v-notapplied{background:#FFF4DE;color:#8A5A00}
        .fl-v-unknown{background:#3A2418;color:#FFE9B8}
        .fl-swl li{display:flex;flex-wrap:wrap;gap:4px 12px;padding:7px 0;border-top:1px solid var(--line);font-size:13px}
        .fl-swn{color:var(--mut);overflow-wrap:anywhere}
        .fl-empty{color:var(--mut);font-size:13px}
        .fl-listh{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}
        .fl-chk{font-size:12.5px;color:var(--mut);display:flex;gap:6px;align-items:center;margin-bottom:10px}
        .fl-row{display:flex;flex-wrap:wrap;gap:4px 16px;justify-content:space-between;padding:9px 0;border-top:1px solid var(--line)}
        .fl-rt{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 220px}
        .fl-rt span{color:var(--mut);font-size:12.5px;overflow-wrap:anywhere}
        .fl-rl{display:flex;flex-wrap:wrap;gap:4px 8px;align-items:center;font-size:12.5px;min-width:0}
        .fl-cap{color:var(--mut)}
        .fl-lad{font-variant-numeric:tabular-nums;white-space:nowrap}
        .fl-new{font-weight:800;color:var(--forest)}
        .fl-arrow{color:var(--mut)}
        .fl-skip{color:var(--mut);font-style:italic}
        .fl-modalwrap{position:fixed;inset:0;background:rgba(16,35,26,.42);display:flex;align-items:center;justify-content:center;padding:16px;z-index:60}
        .fl-modal{background:#fff;border-radius:12px;max-width:520px;width:100%;padding:18px 20px;box-shadow:0 18px 48px rgba(16,35,26,.28)}
        .fl-modal h2{font-size:17px;margin:0 0 8px}
        .fl-modal p{font-size:13.5px;line-height:1.6;margin:0 0 16px;color:#33463B}
        .fl-modalf{display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap}
        @media (max-width:560px){
          .fl-marks{grid-template-columns:repeat(3,minmax(0,1fr))}
        }
      `}</style>
    </div>
  );
}
