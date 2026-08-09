"use client";

// Change Log (Phase 16) — every production write Clubhouse has made, what it changed,
// who made it, and whether it actually landed. A byproduct of the shared write hook:
// this screen only READS the recorded rows and groups them into one entry per save.
// It never writes to MatchDay. Resolving records a human's finding — it does not change
// the recorded outcome and there is NO retry, anywhere: the whole point of an open row
// is that we don't know, and guessing again is how you double up.

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { centsToDollars } from "@/lib/matchMoney";
import { groupBySave, entryUnresolved, passesLogFilters, STATE_LABEL, type LogRow, type LogEntry, type LogState, type LogFilters } from "@/lib/changeLogModel";
import LogHealthBanner from "@/components/LogHealthBanner";

const SOURCES = ["Gameday Ops", "Master Schedule", "Match editor", "Roster"];
const LABELS: Record<string, string> = {
  name: "Name", fieldId: "Field", managerId: "Manager", secondManagerId: "Second manager",
  registrationPrice: "Price", additionalSpotPrice: "Spot price", guestCount: "Guest count",
  category: "Category", type: "Type", minPlayerCount: "Min players", maxPlayerCount: "Capacity",
  maxTeamSize2Team: "Total as 2 teams", maxTeamSize4Team: "Total as 4 teams",
  fakeSpotLeft36h: "36h fake spots", fakeSpotLeft24h: "24h fake spots", fakeSpotLeft12h: "12h fake spots",
  fakeSpotLeft6h: "6h fake spots", fakeSpotLeft3h: "3h fake spots", isAutoBump: "Auto-bump",
  autoCanceled: "Auto-cancel", autoCanceledMinutes: "Auto-cancel minutes", isFreeMember: "Free member",
  description: "Description", managerIntro: "Manager intro", startDate: "Start", endDate: "End", locked: "Locked",
};
const MONEY = new Set(["registrationPrice", "additionalSpotPrice"]);
const labelOf = (k: string) => LABELS[k] ?? k;
const fmtVal = (k: string, v: unknown) => (v === null || v === undefined || v === "" ? "—" : MONEY.has(k) ? "$" + centsToDollars(v) : typeof v === "boolean" ? (v ? "on" : "off") : String(v));

async function authFetch(path: string, init?: RequestInit): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return fetch(path, { ...init, headers: { ...(init?.headers ?? {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" }, cache: "no-store" });
}

const dayKey = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

export default function ChangeLogScreen() {
  const [rows, setRows] = useState<LogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [fOut, setFOut] = useState<LogFilters["outcome"]>("all");
  const [fWho, setFWho] = useState("all");
  const [fSrc, setFSrc] = useState("all");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const res = await authFetch("/api/changelog");
      const j = await res.json().catch(() => ({}));
      if (!res.ok) setErr(j?.error ?? `HTTP ${res.status}`);
      setRows((j.rows ?? []) as LogRow[]);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setLoading(false);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const entries = useMemo(() => groupBySave(rows), [rows]);
  const people = useMemo(() => [...new Set(entries.map((e) => e.actorName))].filter(Boolean), [entries]);
  const needs = useMemo(() => entries.filter(entryUnresolved).length, [entries]);
  const visible = useMemo(() => entries.filter((e) => passesLogFilters(e, { outcome: fOut, who: fWho, source: fSrc })), [entries, fOut, fWho, fSrc]);
  const days = useMemo(() => { const seen: string[] = []; for (const e of visible) { const k = dayKey(e.at); if (!seen.includes(k)) seen.push(k); } return seen; }, [visible]);

  const count = (k: LogFilters["outcome"]) => entries.filter((e) => k === "all" ? true : k === "needs" ? entryUnresolved(e) : e.outcome === k).length;

  const resolve = async (saveId: string, verdict: "yes" | "no") => {
    setBusy(saveId);
    try { const res = await authFetch("/api/changelog", { method: "POST", body: JSON.stringify({ saveId, verdict }) }); if (res.ok) await load(); } finally { setBusy(null); }
  };
  const toggle = (id: string) => setOpen((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });

  return (
    <div className="cl" data-testid="changelog">
      <style>{CSS}</style>
      <div className="panel head">
        <h1>Change Log</h1>
        <p>Every write Clubhouse has made to production — what it changed, who made it, and whether it actually landed. One entry per save. <b>Reads are not logged; only changes.</b></p>
        <div className="frow"><span className="lb">OUTCOME</span><span className="fset" data-testid="f-out">
          {([["all", "Everything"], ["needs", "Needs checking"], ["landed", "Landed"], ["notapplied", "Not applied"], ["unknown", "No answer"], ["failed", "Failed"]] as [LogFilters["outcome"], string][]).map(([k, t]) => (
            <button key={k} className={"chip" + (k === "needs" ? " warnc" : "") + (fOut === k ? " on" : "")} data-testid={`out-${k}`} onClick={() => setFOut(k)}>{t}<span className="b">{count(k)}</span></button>))}
        </span></div>
        <div className="frow"><span className="lb">PERSON</span><span className="fset" data-testid="f-who">
          <button className={"chip" + (fWho === "all" ? " on" : "")} data-testid="who-all" onClick={() => setFWho("all")}>Everyone</button>
          {people.map((p) => <button key={p} className={"chip" + (fWho === p ? " on" : "")} data-testid={`who-${p}`} onClick={() => setFWho(p)}>{p}<span className="b">{entries.filter((e) => e.actorName === p).length}</span></button>)}
        </span></div>
        <div className="frow"><span className="lb">FROM</span><span className="fset" data-testid="f-src">
          <button className={"chip" + (fSrc === "all" ? " on" : "")} data-testid="src-all" onClick={() => setFSrc("all")}>Anywhere</button>
          {SOURCES.map((s) => <button key={s} className={"chip" + (fSrc === s ? " on" : "")} data-testid={`src-${s}`} onClick={() => setFSrc(s)}>{s}<span className="b">{entries.filter((e) => e.source === s).length}</span></button>)}
        </span></div>
      </div>

      <LogHealthBanner />

      {needs > 0 && (
        <div className="needs" data-testid="needs">
          <span className="ic2">!</span>
          <span><b data-testid="needs-count">{needs} write{needs === 1 ? "" : "s"} still need{needs === 1 ? "s" : ""} checking</b>
            <span> Each was accepted or unanswered but never confirmed. Open the match, see what's there, then say which way it went.</span></span>
          <button className="go" data-testid="needs-go" onClick={() => setFOut("needs")}>Show only these</button>
        </div>
      )}

      {loading ? <div className="empty" data-testid="loading">Loading the log…</div>
        : err ? <div className="empty err" data-testid="log-err">Couldn’t load the log: {err}</div>
        : visible.length === 0 ? <div className="empty" data-testid="empty">Nothing matches those filters.</div>
        : <div data-testid="days">{days.map((d) => (
          <section className="day" key={d}><h2>{d}<span className="n">{visible.filter((e) => dayKey(e.at) === d).length}</span></h2>
            <div className="ents">{visible.filter((e) => dayKey(e.at) === d).map((e) => <Entry key={e.saveId} e={e} open={open.has(e.saveId)} busy={busy === e.saveId} onToggle={toggle} onResolve={resolve} />)}</div>
          </section>))}</div>}

      <p className="foot" data-testid="foot">Showing {visible.length} of {entries.length} writes. Reads are not logged — only changes. Entries are stored in Supabase (change_log); retention is currently indefinite (no auto-prune yet).</p>
    </div>
  );
}

function Entry({ e, open, busy, onToggle, onResolve }: { e: LogEntry; open: boolean; busy: boolean; onToggle: (id: string) => void; onResolve: (id: string, v: "yes" | "no") => void }) {
  const unresolved = entryUnresolved(e);
  const cls = e.outcome === "landed" ? "" : e.resolved ? " resolved" : " " + e.outcome;
  const stateClass: Record<LogState, string> = { landed: "landed", failed: "fail", notapplied: "na", unknown: "unk" };
  return (
    <article className={"ent" + cls} data-testid="entry" data-save={e.saveId} data-outcome={e.outcome} data-unresolved={unresolved ? 1 : 0}>
      <div className="eh">
        <span className="tm"><b>{clock(e.at)}</b>{e.actorName.split(" ")[0]}</span>
        <span className="what">
          <span className="m">{e.matchName ?? `Match ${e.matchId ?? ""}`}</span>
          <span className="sub">{e.requests > 1 ? <><b>{e.landedN} of {e.requests}</b> requests landed · </> : null}{e.changes.length} change{e.changes.length === 1 ? "" : "s"} from <b>{e.source}</b> · {e.actorName}</span>
        </span>
        <span className={"state " + stateClass[e.outcome]} data-testid="entry-state">{STATE_LABEL[e.outcome]}</span>
        <button className="exp" data-testid="exp" onClick={() => onToggle(e.saveId)}>{open ? "Hide" : "Details"}</button>
      </div>
      <div className="chg">{e.changes.map((c, i) => (
        <span key={i} className={"cg" + (MONEY.has(c.key) ? " money" : "")}><b>{labelOf(c.key)}</b> <s>{fmtVal(c.key, c.before)}</s> → <em>{fmtVal(c.key, c.after)}</em></span>))}</div>
      {open && <div className="det" data-testid="details">
        <div className="row"><span>Endpoint</span><code>{e.method} {e.endpoint}</code></div>
        <div className="row"><span>Match</span><code>{e.matchId ?? "—"}</code></div>
        {e.serverSaid && <div className="row"><span>Server said</span><code>{e.serverSaid}</code></div>}
        <div className="row"><span>Request body</span></div>
        <pre>{JSON.stringify(e.body, null, 2)}</pre>
      </div>}
      {unresolved && <div className="resolve" data-testid="resolve">
        <span className="q">{e.outcome === "unknown"
          ? <>This request got <b>no answer</b>, so it may or may not have happened. Open match {e.matchId} and look — did the change stick?</>
          : <>The server <b>accepted this and did nothing</b>. Open match {e.matchId} and confirm what’s actually there.</>}</span>
        <button className="rb yes" data-testid="resolve-yes" disabled={busy} onClick={() => onResolve(e.saveId, "yes")}>It landed</button>
        <button className="rb no" data-testid="resolve-no" disabled={busy} onClick={() => onResolve(e.saveId, "no")}>It did not</button>
      </div>}
      {e.resolved && <div className={"rnote" + (e.resolved === "no" ? " no" : "")} data-testid="resolved-note">
        {e.resolved === "yes" ? "Checked and confirmed landed" : "Checked — it did not happen"} by {e.resolvedBy} at {e.resolvedAt ? clock(e.resolvedAt) : ""}. The recorded outcome above is unchanged.</div>}
    </article>
  );
}

const CSS = `
.cl{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Helvetica,Arial,sans-serif;color:#0B1F17;background:#EDF2EF;min-height:100vh;padding:20px 24px 60px}
.cl .panel{background:#fff;border:1px solid #DCE5E0;border-radius:14px}
.cl .head{padding:18px 20px 16px;margin-bottom:14px}
.cl h1{margin:0 0 5px;font-size:23px;letter-spacing:-.2px}
.cl .head p{margin:0 0 14px;color:#5C6B62;font-size:14px;max-width:76ch}.cl .head p b{color:#2A473B}
.cl .frow{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.cl .frow + .frow{margin-top:10px;padding-top:10px;border-top:1px solid #E9EFEB}
.cl .lb{font-size:10.5px;letter-spacing:.12em;color:#5C6B62;font-weight:700;margin-right:2px}
.cl .fset{display:flex;gap:7px;flex-wrap:wrap}
.cl .chip{border:1px solid #DCE5E0;background:#fff;border-radius:20px;padding:7px 13px;color:#1B3227;font-size:13.5px;min-height:34px}
.cl .chip:hover{background:#F2F7F4}.cl .chip.on{background:#003326;border-color:#003326;color:#fff;font-weight:600}
.cl .chip .b{margin-left:6px;font-weight:700;font-size:12px}
.cl .chip.warnc{border-color:#E3C88A;color:#7A5200}.cl .chip.warnc.on{background:#7A5200;border-color:#7A5200;color:#fff}
.cl .needs{background:#FEF6E7;border:1px solid #E3C88A;border-radius:14px;padding:14px 18px;margin-bottom:14px;display:flex;align-items:center;gap:14px}
.cl .needs .ic2{width:26px;height:26px;border-radius:50%;background:#7A5200;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;flex:0 0 26px}
.cl .needs b{display:block;font-size:15px}.cl .needs span span{font-size:13px;color:#6A5320}
.cl .needs .go{margin-left:auto;border:1px solid #E3C88A;background:#fff;border-radius:9px;padding:9px 15px;color:#7A5200;font-weight:600;white-space:nowrap;min-height:34px}
.cl .needs .go:hover{background:#FDF1DD}
.cl .day{margin-bottom:16px}
.cl .day h2{margin:0 0 8px 3px;font-size:11.5px;letter-spacing:.11em;color:#55635B;font-weight:700;display:flex;align-items:center;gap:8px}
.cl .day h2 .n{color:#4E5A54;letter-spacing:0;font-weight:600}
.cl .ents{display:flex;flex-direction:column;gap:8px}
.cl .ent{background:#fff;border:1px solid #DCE5E0;border-radius:12px;padding:12px 14px}
.cl .ent.unk{border-color:#E3C88A;background:#FEFAF2;box-shadow:inset 3px 0 0 #7A5200}
.cl .ent.na{border-color:#C9DBF3;background:#F7FAFE;box-shadow:inset 3px 0 0 #1B4F9C}
.cl .ent.fail{border-color:#E9B6AC;background:#FDF4F2}
.cl .eh{display:grid;grid-template-columns:88px minmax(0,1fr) auto auto;gap:12px;align-items:center}
.cl .eh > *{min-width:0}
.cl .tm{font-size:13px;font-variant-numeric:tabular-nums;color:#5C6B62}.cl .tm b{display:block;color:#0B1F17;font-size:13.5px}
.cl .what .m{font-weight:700;font-size:14.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cl .what .sub{font-size:12.5px;color:#5C6B62;margin-top:1px}.cl .what .sub b{color:#2A473B;font-weight:600}
.cl .state{font-size:10.5px;font-weight:800;letter-spacing:.05em;border-radius:20px;padding:4px 11px;white-space:nowrap}
.cl .state.landed{background:#E4F8EE;color:#046B45;border:1px solid #A9E3C6}
.cl .state.fail{background:#FDEEEB;color:#A83120;border:1px solid #E9B6AC}
.cl .state.na{background:#F2F7FE;color:#1B4F9C;border:1px solid #C9DBF3}
.cl .state.unk{background:#FBF0DC;color:#7A5200;border:1px solid #E3C88A}
.cl .exp{border:1px solid #DCE5E0;background:#fff;border-radius:8px;padding:6px 11px;color:#5C6B62;font-size:12px;min-height:32px}
.cl .exp:hover{background:#F2F7F4}
.cl .chg{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}
.cl .cg{background:#F5F8F6;border:1px solid #DCE5E0;border-radius:7px;padding:4px 9px;font-size:12.5px}
.cl .cg b{font-weight:700}.cl .cg s{color:#5C6B62}.cl .cg em{font-style:normal;color:#1B4F9C;font-weight:700}.cl .cg.money em{color:#046B45}
.cl .det{margin-top:10px;border-top:1px solid #E9EFEB;padding-top:10px;font-size:12.5px}
.cl .det .row{display:flex;gap:10px;padding:2px 0}.cl .det .row span{color:#5C6B62;flex:0 0 108px}
.cl .det code{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;background:#F5F8F6;border:1px solid #DCE5E0;border-radius:5px;padding:1px 6px;word-break:break-all}
.cl .det pre{margin:6px 0 0;background:#0E2A20;color:#CFE9DC;border-radius:8px;padding:10px 12px;font-size:11.5px;overflow-x:auto;font-family:ui-monospace,Menlo,monospace}
.cl .resolve{margin-top:11px;border-top:1px solid #E3C88A;padding-top:11px;display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.cl .resolve .q{font-size:13px;color:#6A5320;flex:1 1 auto;min-width:220px}.cl .resolve .q b{color:#7A5200}
.cl .rb{border:1px solid #DCE5E0;background:#fff;border-radius:9px;padding:8px 14px;font-size:13.5px;min-height:34px}
.cl .rb.yes{border-color:#A9E3C6;color:#046B45;font-weight:600}.cl .rb.yes:hover{background:#EAF9F1}
.cl .rb.no{border-color:#E9B6AC;color:#A83120;font-weight:600}.cl .rb.no:hover{background:#FDEEEB}
.cl .rb:disabled{opacity:.5}
.cl .rnote{margin-top:9px;font-size:12.5px;color:#046B45;background:#EAF9F1;border:1px solid #A9E3C6;border-radius:8px;padding:7px 11px}
.cl .rnote.no{color:#A83120;background:#FDEEEB;border-color:#E9B6AC}
.cl .empty{padding:26px;text-align:center;color:#5C6B62;font-size:14px;border:1px dashed #DCE5E0;border-radius:12px;background:#fff}
.cl .empty.err{color:#A83120;border-color:#E9B6AC;background:#FDEEEB}
.cl .foot{margin-top:16px;font-size:12.5px;color:#5C6B62;padding:0 3px}
@media (max-width:820px){
  .cl{padding:12px 12px 60px}
  .cl .head{padding:14px 14px 13px}.cl h1{font-size:20px}
  .cl .chip{padding:9px 13px}
  .cl .needs{flex-wrap:wrap;padding:12px 14px}.cl .needs .go{margin-left:0;width:100%;text-align:center}
  .cl .eh{grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"tm state" "what what" "exp exp";gap:7px}
  .cl .tm{grid-area:tm;display:flex;gap:7px;align-items:baseline}.cl .tm b{display:inline}
  .cl .what{grid-area:what}.cl .state{grid-area:state;justify-self:end}.cl .exp{grid-area:exp;justify-self:start;padding:8px 12px;font-size:13px}
  .cl .rb{flex:1 1 auto;padding:10px 14px}
  .cl .det .row{flex-direction:column;gap:1px}.cl .det .row span{flex:none}
}
`;
