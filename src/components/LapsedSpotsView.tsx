"use client";

/* LAPSED-MEMBER SPOTS, AND THE REMOVAL CONTROL.
 *
 * ── THIS PAGE NOW WRITES, AND THE WRITE CANNOT BE UNDONE ─────────────────────────────────────
 * It shipped read-only on 2026-08-29 and gained the removal control on 2026-08-31. A freed spot
 * can be taken by a new registration within seconds and re-adding needs an open slot, so there is
 * no rollback — only change_log's record of what happened.
 *
 * THE WRITE GOES THROUGH THE ROSTER ROUTE, NOT A SECOND PATH. /api/matchday/{env}/roster/{matchId}
 * already carries the EDIT MATCHES capability check, the city-scope check, recordWrite and the
 * per-op read-back. A removal endpoint of this page's own would have none of that.
 *
 * AN EMPTY LIST MUST NOT LOOK LIKE A BROKEN ONE. That is the whole risk of this page: on
 * 1 September it shows either "nobody lapsed" or "the query failed", and without the denominator
 * those render identically. So the funnel — future matches, live spots, fakes excluded, free —
 * prints whether or not a single row is found. A bare "nothing to show" is not acceptable, and a
 * load error renders as an ERROR, never as an empty list.
 *
 * IT WILL BE NEAR-EMPTY. Today it is 4 lapsed of 90 free. That is correct and the filter is not to
 * be tuned until it returns more. lapsed-spots-test proves the grouping on a fixture that HAS
 * lapsed holders, with a control proving that fixture would fail a filter returning everyone.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import {
  STATE_LABEL, defaultChecked, confirmSentence, confirmCounts,
  removalCsv, HALTS_RUN,
  type LapsedSpotsView as View, type LapsedSpot, type RemovalResult, type RemovalVerdict,
} from "@/lib/lapsedSpots";

/* THE ENVIRONMENT IS A CONSTANT, NOT A CONTROL.
 * This page reads the PRODUCTION mirror tables, so the only roster it can honestly act on is the
 * production one. An env switcher here would let an operator read production rows and delete
 * staging ones by ids that mean something different in each — the worst possible failure, because
 * both halves would look like they worked. Staging is exercised by scripts/lapsed-removal-test.ts
 * and by a real staging removal, never by this screen. */
const WRITE_ENV = "production";

/* THE GROUPS THE REMOVAL CONTROL ACTS ON. ACTIVE and NEVER_A_MEMBER are shown for context and
 * carry no checkbox at all — they are not removal candidates and a disabled checkbox next to them
 * would read as "not yet" rather than "never". */
const SELECTABLE_STATES = new Set(["LAPSED", "PAST_DUE"]);

/* THE GROUPS THAT RENDER. ACTIVE and NEVER_A_MEMBER are computed exactly as before and still feed
 * the funnel — the classification is untouched — but they are not drawn. This sheet is for people
 * being removed; a current member on a page where a wrong click cannot be undone is noise, and
 * noise next to a live checkbox is a hazard rather than context. */
const RENDERED_STATES = SELECTABLE_STATES;

type RemovedRow = {
  id: string; name: string; matchId: number | null; matchName: string;
  date: string; city: string; field: string; removedAt: string; by: string; verdict: string;
};

/* "Sep 1 · 18:30" — one line, from two text fields. Built with a UTC Date because the inputs are
 * a plain YYYY-MM-DD and a plain HH:MM that were already read off the wall clock; parsing the date
 * alone at UTC midnight and formatting in UTC cannot shift the day. */
const whenLabel = (ymd: string, kickoff: string): string => {
  const d = new Date(`${ymd}T00:00:00Z`);
  const day = Number.isNaN(d.getTime()) ? ymd
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return kickoff ? `${day} · ${kickoff}` : day;
};

const money = (cents: number) => "$" + (cents / 100).toFixed(2);
const num = (n: number) => n.toLocaleString("en-US");

export default function LapsedSpotsView() {
  const [data, setData] = useState<(View & { today: string; nowHm: string; removed: RemovedRow[] }) | null>(null);
  /* TWO TABS. "To remove" is the live list and the default; "Removed" is what this page has
   * already taken off a roster, read from change_log so it survives a reload. */
  const [tab, setTab] = useState<"live" | "removed">("live");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const { data: s } = await supabase.auth.getSession();
      const t = s.session?.access_token;
      if (!t) throw new Error("Not signed in.");
      const r = await fetch("/api/lapsed-spots", { headers: { Authorization: `Bearer ${t}` }, cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setData(j);
    } catch (e) {
      // AN ERROR IS AN ERROR. It never falls through to an empty list.
      setErr(e instanceof Error ? e.message : String(e));
      setData(null);
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const lapsedCount = useMemo(() => data?.groups.find((g) => g.state === "LAPSED")?.rows.length ?? 0, [data]);

  /* ── SELECTION ──────────────────────────────────────────────────────────────────────────────
   * A Set of spotId. Seeded from the model's own defaultChecked(), so what starts ticked and what
   * the reason chip says come from ONE function and cannot drift. Re-seeded on every load — a
   * refresh must not carry a stale tick onto a row whose guard has since changed. */
  const [picked, setPicked] = useState<Set<number>>(new Set());
  useEffect(() => {
    if (!data) { setPicked(new Set()); return; }
    const next = new Set<number>();
    for (const g of data.groups) {
      if (!SELECTABLE_STATES.has(g.state)) continue;
      for (const r of g.rows) if (defaultChecked(r.guard)) next.add(r.spotId);
    }
    setPicked(next);
  }, [data]);

  const candidates: LapsedSpot[] = useMemo(
    () => (data?.groups ?? []).filter((g) => SELECTABLE_STATES.has(g.state)).flatMap((g) => g.rows),
    [data],
  );
  /* THE SELECTION, RESOLVED. blocked rows are filtered out HERE as well as being disabled in the
   * markup — a checkbox is a control and a control can be driven by something other than a click.
   * The money rule is not a UI state. */
  const selected: LapsedSpot[] = useMemo(
    () => candidates.filter((r) => picked.has(r.spotId) && r.guard.selectability !== "blocked"),
    [candidates, picked],
  );

  const toggleSpot = useCallback((r: LapsedSpot) => {
    if (r.guard.selectability === "blocked") return;
    setPicked((prev) => { const n = new Set(prev); if (n.has(r.spotId)) n.delete(r.spotId); else n.add(r.spotId); return n; });
  }, []);
  /* THE PERSON CHECKBOX toggles that person's spots TOGETHER — someone holding ten spots is a
   * decision about ten matches. It never touches a blocked row. */
  const togglePerson = useCallback((rows: LapsedSpot[]) => {
    const actionable = rows.filter((r) => r.guard.selectability !== "blocked");
    setPicked((prev) => {
      const allOn = actionable.length > 0 && actionable.every((r) => prev.has(r.spotId));
      const n = new Set(prev);
      for (const r of actionable) { if (allOn) n.delete(r.spotId); else n.add(r.spotId); }
      return n;
    });
  }, []);

  /* ── THE RUN ────────────────────────────────────────────────────────────────────────────────
   * confirming -> running -> done. Results survive until dismissed: they are the ONLY record the
   * operator sees and there is no rollback. */
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [inFlight, setInFlight] = useState<LapsedSpot | null>(null);
  const [results, setResults] = useState<RemovalResult[] | null>(null);
  const [halted, setHalted] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const ranAt = useRef<string>("");

  const runRemoval = useCallback(async () => {
    setConfirming(false); setRunning(true); setHalted(null);
    const done: RemovalResult[] = [];
    setResults(done.slice());
    ranAt.current = new Date().toISOString();
    // ONE saveId FOR THE WHOLE RUN, so change_log groups these rows as one operator action.
    const saveId = crypto.randomUUID();
    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;

    for (const r of selected) {
      setInFlight(r);
      let verdict: RemovalVerdict = "unknown";
      let detail: string | null = null;
      try {
        if (!token) throw new Error("Not signed in.");
        const res = await fetch(`/api/matchday/${WRITE_ENV}/roster/${r.matchId}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          // The path is built SERVER-SIDE from the kind + userMatchId. The client never sends a
          // path, and it sends userMatchId — the ROSTER ROW id — never userId.
          body: JSON.stringify({ kind: "remove", userMatchId: r.userMatchId, saveId, source: "Lapsed spots", matchName: r.matchName }),
        });
        const j = await res.json().catch(() => ({}));
        if (res.ok && typeof j.outcome === "string") {
          // THE VERDICT IS THE SERVER'S READ-BACK, never our intent and never the HTTP status.
          verdict = j.outcome as RemovalVerdict;
        } else if (j.ambiguous === true) {
          verdict = "unknown"; detail = String(j.error ?? "ambiguous write");
        } else if (res.status >= 400 && res.status < 500) {
          verdict = "failed"; detail = `${res.status} ${String(j.error ?? "").slice(0, 200)}`.trim();
        } else {
          verdict = "unknown"; detail = `${res.status} ${String(j.error ?? "").slice(0, 200)}`.trim();
        }
      } catch (e) {
        // A network throw is UNKNOWN, never failed: the request may have reached the API.
        verdict = "unknown"; detail = e instanceof Error ? e.message : String(e);
      }
      done.push({ spot: r, verdict, detail });
      setResults(done.slice());
      if (HALTS_RUN(verdict)) {
        setHalted(`Halted on ${r.name} — ${r.matchName}. ${done.length} of ${selected.length} sent. ` +
          `The rest were NOT sent. Reload and check this row before doing anything else.`);
        break;
      }
    }
    setInFlight(null); setRunning(false);
  }, [selected]);

  /* COPY — the VISIBLE tab, tab-separated. It reads the same arrays the tables render from, so it
   * cannot drift from the screen, and it is scoped by `tab` so the Removed history never lands on
   * the clipboard while the operator is looking at the live list. */
  const copyVisible = useCallback(async () => {
    if (!data) return;
    const rows = tab === "removed"
      ? [["Player", "Match", "Match date", "City", "Removed", "By", "Verdict"].join("\t"),
         ...data.removed.map((r) => [r.name, r.matchName, r.date, r.city, r.removedAt.slice(0, 16).replace("T", " "), r.by, r.verdict.toUpperCase()].join("\t"))]
      : [["Player", "Email", "When", "Match", "Field", "City", "Membership", "Status"].join("\t"),
         ...candidates.map((r) => [
           r.name, r.email, whenLabel(r.date, r.kickoff), r.matchName, r.field, r.city,
           r.state === "LAPSED" ? `lapsed ${r.lapsedOn ?? "date unknown"}` : r.state === "PAST_DUE" ? "payment pending" : r.state,
           [r.guard.reason, r.contextChip, r.isFirstMatch ? "first match" : null].filter(Boolean).join(" · "),
         ].join("\t"))];
    try {
      await navigator.clipboard.writeText(rows.join("\n"));
      setCopied(true); setTimeout(() => setCopied(false), 1600);
    } catch { setErr("Could not write to the clipboard."); }
  }, [data, tab, candidates]);

  const downloadCsv = useCallback(() => {
    if (!results?.length) return;
    const blob = new Blob([removalCsv(results, ranAt.current)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `lapsed-removals-${ranAt.current.slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  }, [results]);

  return (
    <div className="ls">
      <div className="ls-head">
        <div>
          <h1>Lapsed-member spots</h1>
          <p className="ls-sub">Free spots on future matches, grouped by whether the holder is still a member. Removing a spot cannot be undone.</p>
        </div>
        <button type="button" className="ls-btn" onClick={() => void copyVisible()} data-testid="ls-copy">
          {copied ? "Copied" : "Copy"}
        </button>
        <button type="button" className="ls-btn" onClick={() => void load()} disabled={loading} data-testid="ls-refresh">
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {err ? (
        <div className="ls-err" data-testid="ls-error">
          <b>The query failed — this is NOT an empty list.</b> {err}{" "}
          <button type="button" className="ls-btn" onClick={() => void load()}>Retry</button>
        </div>
      ) : loading && !data ? (
        <div className="ls-state">Loading…</div>
      ) : data ? (
        <>
          {/* THE DENOMINATOR. Printed whether or not anything was found — these numbers are what
              prove the query ran, and they are the difference between "nobody lapsed" and "it
              broke". They come before the rows for exactly that reason. */}
          {/* TWO TABS. A removed row leaves the first and appears in the second; the header count
              and the Remove button read only the first, so neither is inflated by history. */}
          <div className="ls-tabs" role="tablist" data-testid="ls-tabs">
            <button type="button" role="tab" aria-selected={tab === "live"} data-testid="ls-tab-live"
              className={tab === "live" ? "on" : ""} onClick={() => setTab("live")}>
              To remove <span className="ls-tabn">{num(candidates.length)}</span>
            </button>
            <button type="button" role="tab" aria-selected={tab === "removed"} data-testid="ls-tab-removed"
              className={tab === "removed" ? "on" : ""} onClick={() => setTab("removed")}>
              Removed <span className="ls-tabn">{num(data.removed.length)}</span>
            </button>
          </div>

          {tab === "removed" ? (
            <section className="ls-grp" data-testid="ls-removed-tab">
              <div className="ls-grph"><span className="ls-grpn">Removed by this page — newest first</span>
                <span className="ls-grpc">{data.removed.length}</span></div>
              {data.removed.length === 0 ? (
                <div className="ls-empty">This page has not removed anyone yet.</div>
              ) : (
                <div className="ls-tbl">
                  <div className="ls-tr ls-th ls-rem">
                    <div>Player</div><div>Match</div><div>Match date</div><div>City</div>
                    <div>Removed</div><div>By</div><div>Verdict</div>
                  </div>
                  {data.removed.map((r) => (
                    <div className="ls-tr ls-rem" key={r.id} data-testid="ls-removed-row" data-verdict={r.verdict}>
                      <div className="ls-nm">{r.name}</div>
                      <div className="ls-mt" title={r.matchName}>{r.matchName}</div>
                      <div className="ls-dt">{r.date}</div>
                      <div>{r.city}</div>
                      <div className="ls-dt">{r.removedAt.slice(0, 16).replace("T", " ")}</div>
                      <div className="ls-em" title={r.by}>{r.by}</div>
                      <div><span className={"ls-v ls-v-" + r.verdict}>{r.verdict.toUpperCase()}</span></div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          ) : (
          <>
          <div className="ls-denom" data-testid="ls-denominator">
            <b>{num(data.futureMatches)}</b> future matches ·{" "}
            <b>{num(data.liveSpots)}</b> live spots ·{" "}
            <b>{num(data.freeSpots)}</b> free ·{" "}
            <b data-testid="ls-lapsed-count">{num(lapsedCount)}</b> held by a lapsed member ·{" "}
            {/* ACTIVE and NEVER_A_MEMBER are not drawn any more, so the funnel is the only place
                they are still counted — the classification did not weaken, only the rendering. */}
            <b data-testid="ls-today-count">{num(data.todaySpots)}</b> on matches starting today ·{" "}
            <span data-testid="ls-unrendered">
              {num(data.groups.find((g) => g.state === "ACTIVE")?.rows.length ?? 0)} active-member ·{" "}
              {num(data.groups.find((g) => g.state === "NEVER_A_MEMBER")?.rows.length ?? 0)} never-a-member (not listed)
            </span>
            <span className="ls-fakes" data-testid="ls-fakes">
              {num(data.fakeSpots)} fake player{data.fakeSpots === 1 ? "" : "s"} excluded
            </span>
            <span className="ls-today">as at {data.today}</span>
          </div>

          {/* ── THE ACTION BAR. Its count is the SELECTION, never the page total. ─────────────── */}
          {candidates.length > 0 ? (
            <div className="ls-bar" data-testid="ls-actionbar">
              <span className="ls-barn" data-testid="ls-selected-count">
                {num(selected.length)} of {num(candidates.filter((r) => r.guard.selectability !== "blocked").length)} selectable spots ticked
              </span>
              {candidates.some((r) => r.guard.selectability === "blocked") ? (
                <span className="ls-barb" data-testid="ls-blocked-count">
                  {num(candidates.filter((r) => r.guard.selectability === "blocked").length)} paid — cannot be removed here
                </span>
              ) : null}
              <button type="button" className="ls-danger" data-testid="ls-remove"
                disabled={selected.length === 0 || running}
                onClick={() => setConfirming(true)}>
                {running ? "Removing…" : `Remove ${selected.length} spot${selected.length === 1 ? "" : "s"}`}
              </button>
            </div>
          ) : null}

          {data.groups.filter((g) => RENDERED_STATES.has(g.state)).map((g) => (
            <section key={g.state} className={"ls-grp ls-" + g.state.toLowerCase()} data-testid="ls-group" data-state={g.state}>
              <div className="ls-grph">
                <span className="ls-grpn">{STATE_LABEL[g.state]}</span>
                <span className="ls-grpc" data-testid="ls-group-count">{g.rows.length}</span>
              </div>
              {g.rows.length === 0 ? (
                /* EVEN AN EMPTY GROUP SAYS WHAT IT LOOKED FOR. */
                <div className="ls-empty">No free future spot is held by someone in this state.</div>
              ) : (
                <div className="ls-tbl">
                  <div className={"ls-tr ls-th" + (SELECTABLE_STATES.has(g.state) ? " ls-pick" : "")}>
                    {SELECTABLE_STATES.has(g.state) ? <div /> : null}
                    <div>Player</div><div>When</div><div>Match</div><div>City</div><div>Membership</div>
                  </div>
                  {g.rows.map((r, i) => (
                    <div className={"ls-tr" + (SELECTABLE_STATES.has(g.state) ? " ls-pick" : "")
                        + (inFlight?.spotId === r.spotId ? " ls-inflight" : "")}
                      key={r.spotId} data-testid="ls-row" data-spot={r.spotId} data-state={r.state}
                      data-guard={r.guard.selectability}>
                      {SELECTABLE_STATES.has(g.state) ? (
                        <div className="ls-cb">
                          <input type="checkbox" data-testid="ls-spot-check" data-spot={r.spotId}
                            checked={picked.has(r.spotId) && r.guard.selectability !== "blocked"}
                            disabled={r.guard.selectability === "blocked" || running}
                            onChange={() => toggleSpot(r)}
                            aria-label={`Remove ${r.name} from ${r.matchName}`} />
                          {/* THE PERSON CHECKBOX sits on that person's FIRST row and toggles all of
                              their spots at once — ten spots is a decision about ten matches. */}
                          {i === 0 || g.rows[i - 1].userId !== r.userId ? (
                            <button type="button" className="ls-all" data-testid="ls-person-check"
                              data-user={r.userId} disabled={running}
                              onClick={() => togglePerson(g.rows.filter((x) => x.userId === r.userId))}
                              title={`Toggle all ${g.rows.filter((x) => x.userId === r.userId).length} spots for ${r.name}`}>
                              all {g.rows.filter((x) => x.userId === r.userId).length}
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                      {/* PLAYER — name, the FULL email beneath, chips under both. The email is a
                          real text node and is user-selectable: a truncated email cannot be
                          copied, and copying it is most of what it is for. */}
                      <div className="ls-nm">
                        <span className="ls-nmtop">{r.name}</span>
                        <span className="ls-mail">{r.email}</span>
                        {/* WHY THIS ROW IS NOT TICKED, UNDER THE NAME. It was in the membership
                            cell (clipped by nowrap) and then in a trailing column (past the
                            horizontal scroll, so invisible at every real width). A reason nobody
                            can read is not a stated reason. This column is always on screen. */}
                        {r.guard.reason ? (
                          <span className={"ls-chip " + (r.guard.selectability === "blocked" ? "ls-chip-red" : "ls-chip-amber")}
                            data-testid="ls-guard-chip" data-guard={r.guard.selectability}>{r.guard.reason}</span>
                        ) : null}
                        {/* CONTEXT, NOT AN EXCLUSION. The dunning note sits beside a TICKED box on
                            purpose — it says what state the person is in, not that they are being
                            skipped. It is styled differently from a guard chip for that reason. */}
                        {r.contextChip ? (
                          <span className="ls-chip ls-chip-blue" data-testid="ls-context-chip">{r.contextChip}</span>
                        ) : null}
                        {/* A CHIP ONLY WHERE IT IS TRUE. As a column this was "—" on every row. */}
                        {r.isFirstMatch ? (
                          <span className="ls-chip ls-chip-blue" data-testid="ls-firstmatch">first match</span>
                        ) : null}
                      </div>
                      {/* WHEN — date and kickoff on one line. SPOT and FIRST MATCH are gone as
                          columns: both were a constant on every row ($0.00 and "—"). A paid spot
                          already says so on its chip, and a first match now says so on a chip too
                          — a column that is the same on every row is not information. */}
                      <div className="ls-when">
                        {whenLabel(r.date, r.kickoff)}
                        {r.isToday ? <span className="ls-todaytag">today</span> : null}
                      </div>
                      {/* MATCH — name, field beneath. Both full, neither truncated. */}
                      <div className="ls-mt">
                        <span className="ls-mtop">{r.matchName}</span>
                        <span className="ls-fl">{r.field}</span>
                      </div>
                      <div className="ls-city">{r.city}</div>
                      <div className="ls-ms">
                        {r.state === "LAPSED"
                          ? <>lapsed {r.lapsedOn ?? "date unknown"}{r.lapseReason ? <span className="ls-rsn"> · {r.lapseReason}</span> : null}</>
                          : r.state === "PAST_DUE" ? "payment pending"
                          : r.state === "ACTIVE" ? "active" : "never a member"}
                        {/* THE REASON A ROW IS NOT TICKED, ON THE ROW. An unchecked box with no
                            stated reason is indistinguishable from an unchecked box the operator
                            ticked off themselves. */}
                      </div>

                    </div>
                  ))}
                </div>
              )}
            </section>
          ))}

          </>
          )}

          {/* ── THE CONFIRM. The sentence is computed from the selection by confirmSentence, the
              same function the suite asserts against — not assembled here, where it could quietly
              start reading the page total instead. ──────────────────────────────────────────── */}
          {confirming ? (
            <div className="ls-modalwrap" role="dialog" aria-modal="true" aria-labelledby="ls-confirm-h" data-testid="ls-confirm">
              <div className="ls-modal">
                <h2 id="ls-confirm-h">Remove these spots?</h2>
                <p className="ls-confirmtext" data-testid="ls-confirm-sentence">{confirmSentence(selected)}</p>
                <div className="ls-modalfoot">
                  <button type="button" className="ls-btn" onClick={() => setConfirming(false)} data-testid="ls-cancel">Cancel</button>
                  <button type="button" className="ls-danger" onClick={() => void runRemoval()} data-testid="ls-confirm-go">
                    Remove {confirmCounts(selected).spots} spot{confirmCounts(selected).spots === 1 ? "" : "s"}
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          {/* ── PROGRESS AND RESULTS. Kept on screen until dismissed: there is no rollback and this
              is the only record the operator sees. ──────────────────────────────────────────── */}
          {results ? (
            <section className="ls-grp ls-results" data-testid="ls-results">
              <div className="ls-grph">
                <span className="ls-grpn">Removal run — {results.length} of {selected.length || results.length} sent</span>
                {running ? (
                  <span className="ls-inflighttxt" data-testid="ls-inflight">
                    {inFlight ? `sending ${inFlight.name} · ${inFlight.matchName}…` : "starting…"}
                  </span>
                ) : (
                  <>
                    <button type="button" className="ls-btn" onClick={downloadCsv} data-testid="ls-csv">Download CSV</button>
                    <button type="button" className="ls-btn" onClick={() => { setResults(null); setHalted(null); void load(); }} data-testid="ls-dismiss">Dismiss</button>
                  </>
                )}
              </div>
              {halted ? <div className="ls-halt" data-testid="ls-halted"><b>RUN HALTED — an outcome was UNKNOWN.</b> {halted}</div> : null}
              <div className="ls-tbl">
                <div className="ls-tr ls-th ls-res">
                  <div>Person</div><div>Match</div><div>Date</div><div>Verdict</div><div>Detail</div>
                </div>
                {results.map((r) => (
                  <div className="ls-tr ls-res" key={r.spot.spotId} data-testid="ls-result" data-verdict={r.verdict}>
                    <div className="ls-nm">{r.spot.name}</div>
                    <div className="ls-mt" title={r.spot.matchName}>{r.spot.matchName}</div>
                    <div className="ls-dt">{r.spot.date}</div>
                    <div><span className={"ls-v ls-v-" + r.verdict}>{r.verdict.toUpperCase()}</span></div>
                    <div className="ls-em" title={r.detail ?? ""}>{r.detail ?? "—"}</div>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </>
      ) : null}

      <style jsx>{`
        .ls{max-width:100%;overflow-x:hidden;--ink:#10231A;--mut:#6E8076;--line:#E4EAE5;--line2:#EFF3EF;--forest:#0F3323;--slot:#F4F7F4;
          --red:#A5321B;--redBg:#FDECE8;--redLine:#F2C6BC;--amb:#8A5A08;--ambBg:#FFF6E3;--ambLine:#F0DFB8;
          --blu:#12406F;--bluBg:#EFF6FF;--bluLine:#BBD6F6;--grn:#0B7A3E;
          font-size:14px;color:var(--ink);padding:22px 26px 70px;max-width:1560px}
        h1{font-size:26px;letter-spacing:-.5px;margin:0 0 4px}
        .ls-head{display:flex;align-items:flex-start;gap:16px;margin-bottom:12px}
        .ls-sub{margin:0;color:var(--mut);font-size:13px;max-width:70ch}
        .ls-btn{margin-left:auto;border:1px solid var(--line);background:#fff;border-radius:999px;
          padding:7px 15px;font:inherit;font-size:13px;font-weight:700;color:#3C4F44;cursor:pointer;white-space:nowrap}
        .ls-btn:disabled{opacity:.6;cursor:default}
        .ls-err{background:var(--redBg);border:1px solid var(--redLine);color:#7C2412;border-radius:10px;
          padding:12px 15px;font-size:13px;line-height:1.55}
        .ls-state{padding:34px;text-align:center;color:var(--mut)}
        .ls-denom{background:#fff;border:1px solid var(--line);border-radius:10px;padding:11px 15px;
          font-size:13px;color:var(--mut);margin-bottom:14px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
        .ls-denom b{color:var(--ink);font-variant-numeric:tabular-nums}
        .ls-fakes{margin-left:auto;font-size:11.5px}
        .ls-today{font-size:11.5px;padding-left:10px;border-left:1px solid var(--line)}
        .ls-grp{background:#fff;border:1px solid var(--line);border-radius:10px;margin-bottom:14px;overflow:hidden}
        .ls-lapsed{border-color:var(--redLine)}
        .ls-grph{display:flex;align-items:center;gap:10px;padding:11px 15px;border-bottom:1px solid var(--line2);
          background:#F7FAF8;font-size:12.5px;font-weight:800}
        .ls-lapsed .ls-grph{background:var(--redBg);color:#7C2412}
        .ls-grpc{margin-left:auto;background:#fff;border:1px solid var(--line);border-radius:999px;
          padding:2px 10px;font-variant-numeric:tabular-nums}
        .ls-empty{padding:16px;color:var(--mut);font-size:12.5px}
        .ls-tbl{overflow-x:visible}
        .ls-tr{display:grid;grid-template-columns:minmax(190px,1.25fr) 132px minmax(180px,1.35fr) 104px minmax(170px,1.15fr);
          align-items:start;border-bottom:1px solid var(--line2)}
        .ls-tr:last-child{border-bottom:0}
        /* NOTHING TRUNCATES. Every cell wraps; no ellipsis anywhere. A truncated email cannot be
           copied, and copying it is most of what it is for. */
        .ls-tr>div{padding:9px 10px;min-width:0;overflow-wrap:anywhere;word-break:break-word;white-space:normal;line-height:1.35}
        .ls-th{background:#FBFDFB;font-size:10.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#8C9E93}
        .r{text-align:right}
        .ls-nm{font-weight:700}
        .ls-nm,.ls-mt{display:flex;flex-direction:column;gap:3px;align-items:flex-start}
        .ls-nmtop{font-weight:700;font-size:13.5px}
        .ls-mtop{font-weight:600;font-size:13px}
        /* THE FULL EMAIL, selectable — a real text node, not a title attribute. */
        .ls-mail{font-size:11.5px;color:var(--mut);user-select:all;overflow-wrap:anywhere}
        .ls-fl{font-size:11.5px;color:var(--mut)}
        .ls-em{color:var(--mut);font-size:12px}
        .ls-when{font-variant-numeric:tabular-nums;font-size:12.5px;font-weight:600}
        .ls-city{font-size:12.5px}
        .ls-dt,.ls-amt{font-variant-numeric:tabular-nums}
        .ls-ms{font-size:12.5px}
        .ls-rsn{color:var(--mut)}
        .ls-dash{color:#B7C4BC}
        .ls-chip{font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;border-radius:999px;padding:2px 8px;white-space:nowrap}
        .ls-chip-blue{background:var(--bluBg);color:var(--blu);border:1px solid var(--bluLine)}
        .ls-chip-amber{background:var(--ambBg);color:var(--amb);border:1px solid var(--ambLine)}
        .ls-chip-red{background:var(--redBg);color:var(--red);border:1px solid var(--redLine)}
        .ls-tabs{display:flex;gap:6px;margin:0 0 12px}
        .ls-tabs button{border:1px solid var(--line);background:#fff;border-radius:999px;padding:7px 15px;
          font:inherit;font-size:13px;font-weight:700;color:#3C4F44;cursor:pointer;display:flex;align-items:center;gap:7px}
        .ls-tabs button.on{background:var(--forest);border-color:var(--forest);color:#fff}
        .ls-tabn{font-size:11px;font-weight:800;border-radius:999px;padding:1px 7px;background:rgba(0,0,0,.07)}
        .ls-tabs button.on .ls-tabn{background:rgba(255,255,255,.2)}
        .ls-todaytag{margin-left:6px;font-size:9.5px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;
          border-radius:999px;padding:1px 6px;background:var(--forest);color:#fff}
        .ls-tr.ls-rem{grid-template-columns:minmax(150px,1fr) minmax(180px,1.3fr) 104px 108px 128px minmax(150px,1fr) 96px}

        .ls-pastdue .ls-grph{background:var(--ambBg);color:#7A4E06}
        .ls-pastdue{border-color:var(--ambLine)}

        /* PINNED TO THE BOTTOM OF THE VIEWPORT. Sticky-to-top left it above the fold and out of
           sight once the operator scrolled into the list — the count and the button must be
           readable at the moment a box is ticked, not before it. */
        .ls-bar{position:sticky;bottom:12px;top:auto;z-index:5;box-shadow:0 6px 22px rgba(16,35,26,.13);display:flex;align-items:center;gap:12px;flex-wrap:wrap;
          background:#fff;border:1px solid var(--line);border-radius:10px;padding:10px 14px;margin-bottom:14px}
        .ls-barn{font-size:13px;font-weight:700}
        .ls-barb{font-size:12px;color:var(--red)}
        .ls-danger{margin-left:auto;border:1px solid #8E2A12;background:#A5321B;color:#fff;border-radius:999px;
          padding:8px 18px;font:inherit;font-size:13px;font-weight:800;cursor:pointer;white-space:nowrap}
        .ls-danger:disabled{opacity:.45;cursor:default}

        .ls-tr.ls-pick{grid-template-columns:92px minmax(190px,1.25fr) 128px minmax(175px,1.35fr) 100px minmax(165px,1.15fr)}
        /* The name cell is the only one that stacks: name on top, the reason chip beneath it. */
        .ls-pick .ls-nm{white-space:normal;overflow:visible;display:flex;flex-direction:column;align-items:flex-start;gap:4px;line-height:1.3}
        .ls-pick .ls-nm .ls-chip{white-space:normal;text-align:left}
        .ls-cb{display:flex;align-items:center;gap:6px}
        .ls-cb input{width:16px;height:16px;accent-color:#A5321B;cursor:pointer}
        .ls-cb input:disabled{cursor:not-allowed}
        .ls-all{border:1px solid var(--line);background:#fff;border-radius:999px;padding:1px 7px;
          font:inherit;font-size:10px;font-weight:700;color:#3C4F44;cursor:pointer;white-space:nowrap}
        .ls-inflight{background:#FFF8E8}
        .ls-ms{display:flex;align-items:center;gap:7px;white-space:nowrap;overflow:hidden}

        .ls-modalwrap{position:fixed;inset:0;background:rgba(16,35,26,.42);display:flex;align-items:center;
          justify-content:center;padding:20px;z-index:60}
        .ls-modal{background:#fff;border-radius:12px;max-width:540px;width:100%;padding:20px 22px;
          box-shadow:0 18px 48px rgba(16,35,26,.28)}
        .ls-modal h2{font-size:17px;margin:0 0 10px}
        .ls-confirmtext{font-size:13.5px;line-height:1.6;margin:0 0 18px}
        .ls-modalfoot{display:flex;gap:10px;justify-content:flex-end}
        .ls-modalfoot .ls-btn,.ls-modalfoot .ls-danger{margin-left:0}

        .ls-results{border-color:var(--forest)}
        .ls-results .ls-grph{background:var(--forest);color:#fff}
        .ls-results .ls-btn{margin-left:8px}
        .ls-inflighttxt{margin-left:auto;font-size:12px;font-weight:600;opacity:.85}
        .ls-halt{background:var(--redBg);border-bottom:1px solid var(--redLine);color:#7C2412;
          padding:11px 15px;font-size:12.5px;line-height:1.55}
        .ls-tr.ls-res{grid-template-columns:150px minmax(180px,1fr) 96px 110px minmax(220px,1fr);min-width:820px}
        .ls-v{font-size:10.5px;font-weight:800;letter-spacing:.06em;border-radius:999px;padding:2px 9px}
        .ls-v-landed{background:#E4FBEC;color:#0B7A3E;border:1px solid #B7E9CB}
        .ls-v-failed{background:var(--redBg);color:var(--red);border:1px solid var(--redLine)}
        .ls-v-notapplied{background:var(--ambBg);color:var(--amb);border:1px solid var(--ambLine)}
        .ls-v-unknown{background:#3A2418;color:#FFE9B8;border:1px solid #6A4526}
      `}</style>
    </div>
  );
}
