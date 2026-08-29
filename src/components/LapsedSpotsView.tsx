"use client";

/* LAPSED-MEMBER SPOTS — READ ONLY. There is no removal control on this page and no write path
 * behind it. Ryan reads it and decides; nothing here acts.
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

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { STATE_LABEL, FREE_IS_NOT_MEMBER_NOTE, type LapsedSpotsView as View } from "@/lib/lapsedSpots";

const money = (cents: number) => "$" + (cents / 100).toFixed(2);
const num = (n: number) => n.toLocaleString("en-US");

export default function LapsedSpotsView() {
  const [data, setData] = useState<(View & { today: string }) | null>(null);
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

  return (
    <div className="ls">
      <div className="ls-head">
        <div>
          <h1>Lapsed-member spots</h1>
          <p className="ls-sub">Free spots on future matches, grouped by whether the holder is still a member. Read-only — nothing on this page removes anyone.</p>
        </div>
        <button type="button" className="ls-btn" onClick={() => void load()} disabled={loading} data-testid="ls-refresh">
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {/* THE SENTENCE THAT STAYS. */}
      <p className="ls-note" data-testid="ls-free-note">{FREE_IS_NOT_MEMBER_NOTE}</p>

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
          <div className="ls-denom" data-testid="ls-denominator">
            <b>{num(data.futureMatches)}</b> future matches ·{" "}
            <b>{num(data.liveSpots)}</b> live spots ·{" "}
            <b>{num(data.freeSpots)}</b> free ·{" "}
            <b data-testid="ls-lapsed-count">{num(lapsedCount)}</b> held by a lapsed member
            <span className="ls-fakes" data-testid="ls-fakes">
              {num(data.fakeSpots)} fake player{data.fakeSpots === 1 ? "" : "s"} excluded
            </span>
            <span className="ls-today">as at {data.today}</span>
          </div>

          {data.groups.map((g) => (
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
                  <div className="ls-tr ls-th">
                    <div>Player</div><div>Email</div><div>Match</div><div>Date</div>
                    <div>Field</div><div>City</div><div className="r">Spot</div>
                    <div>First match</div><div>Membership</div><div className="r">Guests</div>
                  </div>
                  {g.rows.map((r) => (
                    <div className="ls-tr" key={r.spotId} data-testid="ls-row" data-spot={r.spotId} data-state={r.state}>
                      <div className="ls-nm">{r.name}</div>
                      <div className="ls-em" title={r.email}>{r.email}</div>
                      <div className="ls-mt" title={r.matchName}>{r.matchName}</div>
                      <div className="ls-dt">{r.date}</div>
                      <div className="ls-fl" title={r.field}>{r.field}</div>
                      <div>{r.city}</div>
                      <div className="r ls-amt">{money(r.amountCents)}</div>
                      {/* SHOWN SO A FIRST-MATCH-FREE IS VISIBLE rather than read as a member spot. */}
                      <div>{r.isFirstMatch ? <span className="ls-chip ls-chip-blue">first match</span> : <span className="ls-dash">—</span>}</div>
                      <div className="ls-ms">
                        {r.state === "LAPSED"
                          ? <>lapsed {r.lapsedOn ?? "date unknown"}{r.lapseReason ? <span className="ls-rsn"> · {r.lapseReason}</span> : null}</>
                          : r.state === "ACTIVE" ? "active" : "never a member"}
                      </div>
                      {/* GUESTS ARE NOT LISTED AS REMOVABLE — a guest shares its host's user_id and
                          carries no other link. The count sits beside the decision because acting
                          on a host is not a decision only about the host. */}
                      <div className="r">{r.guestsOnMatch > 0
                        ? <span className="ls-chip ls-chip-amber" data-testid="ls-guests">{r.guestsOnMatch} on this match</span>
                        : <span className="ls-dash">—</span>}</div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          ))}
        </>
      ) : null}

      <style jsx>{`
        .ls{--ink:#10231A;--mut:#6E8076;--line:#E4EAE5;--line2:#EFF3EF;--forest:#0F3323;--slot:#F4F7F4;
          --red:#A5321B;--redBg:#FDECE8;--redLine:#F2C6BC;--amb:#8A5A08;--ambBg:#FFF6E3;--ambLine:#F0DFB8;
          --blu:#12406F;--bluBg:#EFF6FF;--bluLine:#BBD6F6;--grn:#0B7A3E;
          font-size:14px;color:var(--ink);padding:22px 26px 70px;max-width:1560px}
        h1{font-size:26px;letter-spacing:-.5px;margin:0 0 4px}
        .ls-head{display:flex;align-items:flex-start;gap:16px;margin-bottom:12px}
        .ls-sub{margin:0;color:var(--mut);font-size:13px;max-width:70ch}
        .ls-btn{margin-left:auto;border:1px solid var(--line);background:#fff;border-radius:999px;
          padding:7px 15px;font:inherit;font-size:13px;font-weight:700;color:#3C4F44;cursor:pointer;white-space:nowrap}
        .ls-btn:disabled{opacity:.6;cursor:default}
        .ls-note{background:var(--ambBg);border:1px solid var(--ambLine);color:#7A4E06;border-radius:10px;
          padding:11px 14px;font-size:12.5px;line-height:1.55;margin:0 0 12px}
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
        .ls-tbl{overflow-x:auto}
        .ls-tr{display:grid;grid-template-columns:130px minmax(180px,1fr) minmax(130px,1fr) 96px minmax(120px,1fr) 96px 74px 92px minmax(190px,1fr) 120px;
          align-items:center;border-bottom:1px solid var(--line2);min-width:1180px}
        .ls-tr:last-child{border-bottom:0}
        .ls-tr>div{padding:9px 8px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .ls-th{background:#FBFDFB;font-size:10.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#8C9E93}
        .r{text-align:right}
        .ls-nm{font-weight:700}
        .ls-em,.ls-fl,.ls-mt{color:var(--mut);font-size:12.5px}
        .ls-dt,.ls-amt{font-variant-numeric:tabular-nums}
        .ls-ms{font-size:12.5px}
        .ls-rsn{color:var(--mut)}
        .ls-dash{color:#B7C4BC}
        .ls-chip{font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;border-radius:999px;padding:2px 8px;white-space:nowrap}
        .ls-chip-blue{background:var(--bluBg);color:var(--blu);border:1px solid var(--bluLine)}
        .ls-chip-amber{background:var(--ambBg);color:var(--amb);border:1px solid var(--ambLine)}
      `}</style>
    </div>
  );
}
