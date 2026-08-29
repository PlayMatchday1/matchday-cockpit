"use client";

/* VENUES & FIELDS — the same data the field-ID admin already served, read venue-first.
 *
 * THE PAGE WAS FIELD-FIRST: one flat row per MatchDay field id, sorted by match count. That is the
 * shape of the table, not the shape of the estate — "ATH Pearland" is one place with two field ids
 * on it and "Soccer Central" is one place with four. This groups by venue and opens to the fields.
 *
 * IT ADDS NO DATA PATH. GET /api/admin/fields returns fields[] (each with its mapping) and
 * venues[]; buildVenuesView groups them and computes every total. Nothing here re-reads Supabase
 * and nothing here computes a number the model did not.
 *
 * THE WRITE IS THE ROUTE THAT ALREADY EXISTS: POST /api/admin/fields/assign. It performs the
 * insert through recordWrite (read before, write, read after, verdict from the read-back) AND
 * writes fin_change_log, because the verdict lives in one table and the table's history lives in
 * the other — its own header says at length not to consolidate them. THIS FILE ADDS NOTHING TO
 * IT: same body, same refusals, same verdict, no retry, no second path.
 *
 * counts_as_regular_play IS NOT ON THE FORM. It is always sent false, which is what the route
 * defaults to and what 40 of 44 existing links hold. The flag doubles a venue's cost basis; it
 * must not be a checkbox on the form used to clear 36 unmapped fields in one sitting. Changing it
 * stays a separate, deliberate act.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import type { FieldsPayload } from "@/lib/fieldIdAdmin";
import { buildVenuesView, venueRollupBreaks, type VenueBlock, type VenueField } from "@/lib/venuesModel";

type AssignResult = {
  ok?: boolean;
  error?: string;
  outcome?: string;
  logRecorded?: boolean;
  finLogRecorded?: boolean;
  venueId?: number | null;
};

const money = (n: number) => "$" + Math.round(n).toLocaleString("en-US");
const num = (n: number) => n.toLocaleString("en-US");

export default function VenuesFieldsView() {
  const [data, setData] = useState<FieldsPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [city, setCity] = useState("");
  const [openIds, setOpenIds] = useState<Set<number>>(new Set());
  const [allOpen, setAllOpen] = useState(false);
  /** fieldId → the verdict line for that assignment. Per row, because each assignment is its own
   *  write with its own outcome — a page-level banner would report one and hide the rest. */
  const [done, setDone] = useState<Map<number, string>>(new Map());

  const load = useCallback(async (refresh: boolean) => {
    setLoading(true); setErr(null);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error("Not signed in.");
      const res = await fetch(`/api/admin/fields${refresh ? "?refresh=1" : ""}`, {
        headers: { Authorization: `Bearer ${token}` }, cache: "no-store",
      });
      const body = (await res.json()) as FieldsPayload & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setData(body);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(false); }, [load]);

  const view = useMemo(() => data ? buildVenuesView(data.fields, data.venues) : null, [data]);

  /* THE ROLLUP CHECK, ON SCREEN. venueRollupBreaks returns the breaks, and an empty array is the
   * passing value — which is also what an empty input returns. So the banner states the COUNT it
   * checked beside the result: "34 venues reconcile" is a claim, "0 breaks" on its own is not. */
  const breaks = useMemo(() => view ? venueRollupBreaks(view.venues) : [], [view]);

  const cities = useMemo(() => {
    if (!view) return [] as string[];
    return [...new Set(view.venues.map((v) => v.city).filter((c): c is string => !!c))].sort();
  }, [view]);

  const shown = useMemo(() => {
    if (!view) return [] as VenueBlock[];
    const needle = q.trim().toLowerCase();
    return view.venues.filter((v) => {
      if (city && v.city !== city) return false;
      if (!needle) return true;
      if (`${v.name} ${v.city ?? ""} ${v.venueId}`.toLowerCase().includes(needle)) return true;
      return v.fields.some((f) => `${f.title ?? ""} ${f.address ?? ""} ${f.fieldId}`.toLowerCase().includes(needle));
    });
  }, [view, q, city]);

  const isOpen = (id: number) => allOpen || openIds.has(id);
  const toggle = (id: number) => setOpenIds((s) => {
    const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n;
  });

  if (loading && !data) return <div className="vf-state">Loading venues…</div>;
  if (err && !data) return <div className="vf-state vf-bad">{err} <button className="vf-ghost" onClick={() => void load(false)}>Retry</button></div>;
  if (!view) return null;

  const u = view.unattributed;

  return (
    <div className="vf">
      {/* ── WARNING ONE: not on a venue. Live counts, never a constant. ── */}
      {u.fieldCount > 0 && (
        <div className="vf-warn vf-warn-red" data-testid="unmapped-banner">
          <b>{u.fieldCount} field{u.fieldCount === 1 ? " is" : "s are"} not on a venue.</b>{" "}
          {num(u.liveMatches)} live match{u.liveMatches === 1 ? "" : "es"} · {num(u.spots)} spots ·{" "}
          {money(u.revenue)} all-time carry no cost and no revenue attribution, and are missing from
          every finance page. Assign each to a venue, or create one.
          {u.upcoming.length > 0 && (
            <div className="vf-warn-sub" data-testid="unmapped-upcoming">
              And {u.upcoming.length === 1 ? "one is" : `${u.upcoming.length} are`} still generating:{" "}
              {u.upcoming.map((x) => `${x.title ?? "untitled"} (#${x.fieldId}) — ${x.upcomingMatches} upcoming`).join(" · ")}.
            </div>
          )}
        </div>
      )}

      {/* ── WARNING TWO: on a venue, billed at nothing. A DIFFERENT failure, so a different
             sentence — the money IS attributed, it is just costed at zero. ── */}
      {view.rateless.length > 0 && (
        <div className="vf-warn vf-warn-amber" data-testid="rateless-banner">
          <b>{view.rateless.length} venue{view.rateless.length === 1 ? " is" : "s are"} on the books with no rate.</b>{" "}
          Their fields are attributed, and billed at nothing —{" "}
          {view.rateless.map((v) => `${v.name} (#${v.venueId}${v.isActive ? ", active" : ""}, ${money(v.revenue)})`).join(" · ")}.
          {" "}A rate you do not know is not a rate to invent; this names them rather than defaulting one.
        </div>
      )}

      {/* THE ROLLUP CLAIM, STATED WITH ITS DENOMINATOR. */}
      <div className={"vf-roll" + (breaks.length ? " vf-roll-bad" : "")} data-testid="rollup">
        {breaks.length === 0
          ? `${view.venues.length} venues · ${view.venues.reduce((a, v) => a + v.fieldCount, 0)} mapped fields — every venue total equals the sum of its fields.`
          : `${breaks.length} venue total(s) do NOT equal the sum of their fields: ` +
            breaks.map((b) => `${b.name} ${b.column} ${b.venueTotal} vs ${b.fieldSum}`).join(" · ")}
      </div>

      <div className="vf-bar">
        <input className="vf-search" value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="Venue, field name, address or ID" data-testid="vf-search" />
        <span className="vf-lbl">City</span>
        <button className={"vf-chip" + (city === "" ? " on" : "")} onClick={() => setCity("")}>
          All <span className="n">{view.venues.length}</span>
        </button>
        {cities.map((c) => (
          <button key={c} className={"vf-chip" + (city === c ? " on" : "")} onClick={() => setCity(c)}>
            {c} <span className="n">{view.venues.filter((v) => v.city === c).length}</span>
          </button>
        ))}
        <span className="vf-spacer" />
        <button className="vf-ghost" data-testid="vf-expand" onClick={() => setAllOpen((v) => !v)}>
          {allOpen ? "Collapse all" : "Expand all"}
        </button>
        <button className="vf-ghost" onClick={() => void load(true)} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {/* ── NOT ON A VENUE — pinned at the top, always open, warning treatment. ── */}
      {u.fieldCount > 0 && (
        <div className="vf-card vf-un" data-testid="unmapped-block">
          <div className="vf-vh vf-vh-un">
            <div className="vf-vname">Not on a venue <span className="vf-tag vf-tag-red">unattributed</span></div>
            <div className="vf-city">—</div>
            <div className="vf-num">{u.fieldCount}</div>
            <div className="vf-num">{num(u.liveMatches)}<small>{num(u.cancelledMatches)} cancelled</small></div>
            <div className="vf-num">{num(u.spots)}</div>
            <div className="vf-rate">{money(u.revenue)}<small>no rate</small></div>
            <div />
          </div>
          <div className="vf-body">
            {u.fields.map((f) => (
              <AssignRow key={f.fieldId} f={f} venues={view.venues} done={done.get(f.fieldId) ?? null}
                onDone={(line) => { setDone((m) => new Map(m).set(f.fieldId, line)); void load(true); }} />
            ))}
          </div>
        </div>
      )}

      <div className="vf-card">
        <div className="vf-thead">
          <div>Venue</div><div>City</div><div className="r">Fields</div><div className="r">Matches</div>
          <div className="r">Spots</div><div className="r">Revenue</div><div />
        </div>
        {shown.length === 0 ? <div className="vf-state">Nothing matches that.</div> : shown.map((v) => (
          <div key={v.venueId} className={"vf-vb" + (isOpen(v.venueId) ? " open" : "")} data-testid="venue" data-venue={v.venueId}>
            <div className="vf-vh" role="button" tabIndex={0} onClick={() => toggle(v.venueId)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(v.venueId); } }}>
              <div className="vf-vname">
                {v.name} <span className="vf-vid">#{v.venueId}</span>
                {!v.isActive && <span className="vf-tag vf-tag-off">inactive</span>}
                {v.ratelessWarning && <span className="vf-tag vf-tag-amber">no rate</span>}
              </div>
              <div className="vf-city">{v.city ?? "—"}</div>
              <div className="vf-num">{v.fieldCount}</div>
              <div className="vf-num">{num(v.liveMatches)}<small>{num(v.cancelledMatches)} cancelled</small></div>
              <div className="vf-num">{num(v.spots)}</div>
              {/* THE RATE IS cost_per_match, the column Field Economics reads. Where per_match_rate
                  disagrees BOTH are shown with a marker — nothing is picked silently. */}
              <div className="vf-rate">{money(v.revenue)}
                <small className={v.rateDisagrees ? "vf-split" : undefined} data-testid={`rate-${v.venueId}`}>
                  {v.rate == null ? "no rate" : `$${v.rate}/match`}
                  {v.rateDisagrees && ` ⚠ per_match_rate ${v.altRate == null ? "null" : "$" + v.altRate}`}
                </small>
              </div>
              <div className="vf-caret">{isOpen(v.venueId) ? "▾" : "▸"}</div>
            </div>
            {isOpen(v.venueId) && (
              <div className="vf-body">
                {v.fields.length === 0
                  ? <div className="vf-empty">No field IDs are mapped to this venue.</div>
                  : v.fields.map((f) => <FieldRow key={f.fieldId} f={f} />)}
              </div>
            )}
          </div>
        ))}
        <div className="vf-foot">
          <span data-testid="vf-count">{shown.length} venue{shown.length === 1 ? "" : "s"} · {shown.reduce((a, v) => a + v.fieldCount, 0)} fields</span>
          <span>Sorted by revenue · totals are all-time</span>
        </div>
      </div>

      <style jsx>{CSS}</style>
    </div>
  );
}

function Tags({ tags }: { tags: VenueField["tags"] }) {
  return <>{tags.map((t) => (
    <span key={t} className={"vf-mini " + (t === "counts as 2" ? "c2" : t === "renamed" ? "ren" : "ev")}>{t}</span>
  ))}</>;
}

function FieldRow({ f }: { f: VenueField }) {
  return (
    <div className="vf-fr" data-testid="field-row" data-field={f.fieldId}>
      <div className="vf-fid">{f.fieldId}</div>
      <div className="vf-fname">{f.title ?? "untitled"} <Tags tags={f.tags} /></div>
      <div className="vf-faddr" title={f.address ?? ""}>{f.address ?? "no address"}</div>
      <div className="vf-num">{num(f.liveMatches)}<small>{f.upcomingMatches ? `${f.upcomingMatches} upcoming` : " "}</small></div>
      <div className="vf-span">{f.span ?? "—"}</div>
      <div className="vf-num">{num(f.spots)}</div>
      <div className="vf-rate">{money(f.revenue)}</div>
      <style jsx>{CSS}</style>
    </div>
  );
}

/* ── ONE PICKER PER FIELD, never a group action ────────────────────────────────────────────────
 * Assign is DISABLED until a venue is chosen. Choosing "create" changes the button to
 * "Create & assign" so a new fin_venues row cannot happen by accident. The verdict comes back
 * from the route's own read-back and is rendered verbatim per row — LANDED / FAILED /
 * NOT APPLIED / UNKNOWN. No retry: `busy` is set before the fetch and the button stays disabled
 * for the life of the request, and a finished row replaces the control entirely. */
function AssignRow({ f, venues, done, onDone }: {
  f: VenueField; venues: VenueBlock[]; done: string | null; onDone: (line: string) => void;
}) {
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newCity, setNewCity] = useState("");
  const [newBilling, setNewBilling] = useState("per_match");
  const creating = choice === "new";

  const sorted = useMemo(() => [...venues].sort((a, b) => a.name.localeCompare(b.name)), [venues]);

  const submit = async () => {
    if (!choice || busy) return;
    setBusy(true); setErr(null);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error("Not signed in.");
      const body = creating
        // counts_as_regular_play is NOT on this form; false is what the route defaults to.
        ? { fieldId: f.fieldId, mode: "new", venueName: newName.trim(), city: newCity, billingType: newBilling, countsAsRegularPlay: false }
        : { fieldId: f.fieldId, mode: "existing", venueId: Number(choice), countsAsRegularPlay: false };
      const res = await fetch("/api/admin/fields/assign", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      const j = (await res.json()) as AssignResult;
      // A REFUSAL STAYS ON THE ROW so the input can be fixed. A 2xx carries an OUTCOME, which is
      // not the same as success — the verdict below is the route's, reported verbatim.
      if (!res.ok) { setErr(j.error ?? `HTTP ${res.status}`); return; }
      const name = creating ? newName.trim() : (sorted.find((v) => String(v.venueId) === choice)?.name ?? `venue #${j.venueId}`);
      const outcome = String(j.outcome ?? "UNKNOWN").toUpperCase();
      onDone(outcome === "LANDED"
        ? `✓ Assigned to ${name}${j.logRecorded === false || j.finLogRecorded === false ? " — LANDED, but a change-log write did not record." : ""}`
        : `${outcome} — the read-back does not show the link on ${name}. Do not press again; check before retrying.`);
    } catch (e) {
      setErr(`UNKNOWN — ${e instanceof Error ? e.message : String(e)}. Reload before acting.`);
    } finally { setBusy(false); }
  };

  return (
    <div data-testid="assign-row" data-field={f.fieldId}>
      <div className="vf-fr vf-fr-un">
        <div className="vf-fid">{f.fieldId}</div>
        <div className="vf-fname">{f.title ?? "untitled"} <Tags tags={f.tags} /></div>
        <div className="vf-faddr" title={f.address ?? ""}>{f.address ?? "no address"}</div>
        <div className="vf-num">{num(f.liveMatches)}<small>{f.upcomingMatches ? `${f.upcomingMatches} upcoming` : " "}</small></div>
        <div className="vf-span">{f.span ?? "—"}</div>
        <div className="vf-num">{num(f.spots)}</div>
        <div className="vf-rate">{money(f.revenue)}<small className="vf-unat">unattributed</small></div>
      </div>
      <div className="vf-asr">
        {done ? <span className="vf-asdone" data-testid="assign-done">{done}</span> : (
          <>
            <span className="vf-aslbl">Belongs to</span>
            <select className="vf-assel" data-testid="assign-select" value={choice} disabled={busy}
              onChange={(e) => { setChoice(e.target.value); setErr(null); }}>
              <option value="">Choose a venue…</option>
              {sorted.map((v) => (
                <option key={v.venueId} value={v.venueId}>
                  {v.name} · #{v.venueId} · {v.rate == null ? "no rate" : `$${v.rate}/match`}
                </option>
              ))}
              <option value="new">+ Create a new venue…</option>
            </select>
            {creating && (
              <>
                <input className="vf-asin" data-testid="new-venue-name" placeholder="New venue name" value={newName}
                  disabled={busy} onChange={(e) => setNewName(e.target.value)} />
                <select className="vf-assel vf-assel-sm" data-testid="new-venue-city" value={newCity} disabled={busy}
                  onChange={(e) => setNewCity(e.target.value)}>
                  <option value="">City…</option>
                  {[...new Set(venues.map((v) => v.city).filter((c): c is string => !!c))].sort()
                    .map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
                <select className="vf-assel vf-assel-sm" data-testid="new-venue-billing" value={newBilling} disabled={busy}
                  onChange={(e) => setNewBilling(e.target.value)}>
                  <option value="per_match">per_match</option>
                  <option value="profit_share">profit_share</option>
                  <option value="monthly_flat">monthly_flat</option>
                </select>
                <span className="vf-asnote">Created with NO rate — it will show under “no rate”, not as free.</span>
              </>
            )}
            <button className="vf-assign" data-testid="assign-btn"
              disabled={busy || !choice || (creating && (!newName.trim() || !newCity))}
              onClick={() => void submit()}>
              {busy ? "Writing…" : creating ? "Create & assign" : "Assign"}
            </button>
            {err && <span className="vf-aserr" data-testid="assign-err">{err}</span>}
          </>
        )}
      </div>
      <style jsx>{CSS}</style>
    </div>
  );
}

const CSS = `
.vf{--ink:#10231A;--mut:#6E8076;--line:#E4EAE5;--line2:#EFF3EF;--forest:#0F3323;--slot:#F4F7F4;
  --red:#A5321B;--redBg:#FDECE8;--redLine:#F2C6BC;--amb:#8A5A08;--ambBg:#FFF6E3;--ambLine:#F0DFB8;
  --grn:#0B7A3E;--grnBg:#E4FBEC;--blu:#12406F;--bluBg:#EFF6FF;--bluLine:#BBD6F6;
  font-size:14px;color:var(--ink)}
.vf-state{padding:34px;text-align:center;color:var(--mut)}
.vf-bad{color:var(--red)}
.vf-warn{border-radius:10px;padding:12px 15px;margin-bottom:12px;font-size:13px;line-height:1.55}
.vf-warn-red{background:var(--redBg);border:1px solid var(--redLine);color:#7C2412}
.vf-warn-amber{background:var(--ambBg);border:1px solid var(--ambLine);color:#7A4E06}
.vf-warn-sub{margin-top:7px;font-weight:600}
.vf-roll{font-size:12px;color:var(--mut);margin:0 2px 12px}
.vf-roll-bad{color:var(--red);font-weight:800}
.vf-bar{display:flex;gap:9px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
.vf-search{flex:1;min-width:220px;border:1px solid var(--line);border-radius:999px;padding:7px 14px;font:inherit;font-size:13px}
.vf-lbl{font-size:10.5px;font-weight:700;letter-spacing:.09em;color:#93A49A;text-transform:uppercase}
.vf-chip{border:1px solid var(--line);background:#fff;border-radius:999px;padding:6px 13px;font:inherit;font-size:13px;font-weight:600;color:#3C4F44;cursor:pointer;white-space:nowrap}
.vf-chip.on{background:var(--forest);border-color:var(--forest);color:#fff}
.vf-chip .n{color:var(--mut);font-weight:700;font-size:12px;margin-left:5px}
.vf-chip.on .n{color:#9FE0BB}
.vf-spacer{flex:1}
.vf-ghost{border:1px solid var(--line);background:#fff;border-radius:999px;padding:7px 15px;font:inherit;font-size:13px;font-weight:700;color:#3C4F44;cursor:pointer;white-space:nowrap}
.vf-ghost:disabled{opacity:.6;cursor:default}
.vf-card{background:#fff;border:1px solid var(--line);border-radius:10px;margin-bottom:14px;overflow:hidden}
.vf-un{border-color:var(--redLine)}
.vf-thead,.vf-vh{display:grid;grid-template-columns:minmax(210px,1.5fr) 116px 96px 116px 116px 150px 40px;padding:0 18px}
.vf-thead{background:#F7FAF8;border-bottom:1px solid var(--line)}
.vf-thead div{font-size:10.5px;font-weight:700;letter-spacing:.09em;color:#8C9E93;text-transform:uppercase;padding:10px 8px}
.vf-thead .r{text-align:right}
.vf-vb{border-bottom:1px solid var(--line)}
.vf-vb:last-child{border-bottom:0}
.vf-vh{align-items:center;cursor:pointer;user-select:none;background:#fff}
.vf-vh:hover{background:#FAFCFA}
.vf-vh:focus-visible{outline:2px solid var(--grn);outline-offset:-2px}
.vf-vh>div{padding:14px 8px;min-width:0}
.vf-vh-un{background:var(--redBg);cursor:default}
.vf-vname{font-weight:700;font-size:16px;letter-spacing:-.2px;display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.vf-vid{font-size:11.5px;font-weight:700;color:var(--mut);background:#F1F4F1;border-radius:999px;padding:2px 8px;font-variant-numeric:tabular-nums}
.vf-tag{font-size:10px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;border-radius:999px;padding:2px 8px;white-space:nowrap}
.vf-tag-off{background:#F1F4F1;color:#8C9E93}
.vf-tag-amber{background:var(--ambBg);color:var(--amb);border:1px solid var(--ambLine)}
.vf-tag-red{background:#fff;color:var(--red);border:1px solid var(--redLine)}
.vf-city{font-size:13px;color:var(--mut);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vf-num{font-weight:700;font-size:14.5px;font-variant-numeric:tabular-nums;text-align:right}
.vf-num small{display:block;font-weight:600;font-size:11.5px;color:var(--mut)}
.vf-rate{font-weight:700;font-size:14px;font-variant-numeric:tabular-nums;text-align:right}
.vf-rate small{display:block;font-weight:600;font-size:11.5px;color:var(--mut)}
.vf-split{color:var(--amb)!important;font-weight:700}
.vf-unat{color:var(--red)!important}
.vf-caret{width:26px;height:26px;border:1px solid var(--line);border-radius:7px;display:grid;place-items:center;font-size:10px;color:var(--mut);justify-self:end}
.vf-body{background:#FBFDFB;border-top:1px solid var(--line2)}
.vf-empty{padding:16px 34px;color:var(--mut);font-size:13px}
.vf-fr{display:grid;grid-template-columns:64px minmax(180px,1.4fr) minmax(150px,1fr) 106px 150px 100px 130px;
  align-items:center;padding:0 18px 0 34px;border-bottom:1px solid var(--line2)}
.vf-fr>div{padding:10px 8px;min-width:0}
.vf-fr-un{border-bottom:0}
.vf-fid{font-variant-numeric:tabular-nums;font-weight:700;font-size:13px;color:#3C4F44}
.vf-fname{font-size:14px;font-weight:600;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.vf-faddr{font-size:12px;color:var(--mut);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vf-span{font-size:12px;color:var(--mut);font-variant-numeric:tabular-nums;white-space:nowrap}
.vf-mini{font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;border-radius:999px;padding:2px 7px;white-space:nowrap}
.vf-mini.c2{background:var(--grnBg);color:var(--grn)}
.vf-mini.ren{background:var(--bluBg);color:var(--blu);border:1px solid var(--bluLine)}
.vf-mini.ev{background:#F1F4F1;color:var(--mut)}
.vf-asr{display:flex;align-items:center;gap:10px;padding:0 18px 14px 42px;flex-wrap:wrap;border-bottom:1px solid var(--line2)}
.vf-aslbl{font-size:10.5px;font-weight:700;letter-spacing:.09em;color:#93A49A;text-transform:uppercase}
.vf-assel{border:1px solid var(--line);border-radius:8px;padding:8px 11px;font:inherit;font-size:13.5px;background:#fff;min-width:280px;max-width:100%}
.vf-assel-sm{min-width:150px}
.vf-asin{border:1px solid var(--line);border-radius:8px;padding:8px 11px;font:inherit;font-size:13.5px;min-width:200px}
.vf-asnote{font-size:11.5px;color:var(--amb);font-weight:600}
.vf-assign{background:#4FE07E;border:0;border-radius:999px;padding:8px 17px;font:inherit;font-weight:700;font-size:13px;color:#08281A;cursor:pointer;white-space:nowrap}
.vf-assign:disabled{background:#DCE5DF;color:#A9B8AF;cursor:not-allowed}
.vf-asdone{font-size:13px;font-weight:700;color:var(--grn)}
.vf-aserr{font-size:12.5px;font-weight:700;color:var(--red)}
.vf-foot{display:flex;justify-content:space-between;gap:14px;flex-wrap:wrap;color:var(--mut);font-size:12.5px;padding:12px 18px;border-top:1px solid var(--line2)}
@media(max-width:1280px){
  .vf-thead,.vf-vh{grid-template-columns:minmax(180px,1.5fr) 100px 96px 116px 40px}
  .vf-thead div:nth-child(5),.vf-thead div:nth-child(6),.vf-vh>div:nth-child(5),.vf-vh>div:nth-child(6){display:none}
  .vf-fr{grid-template-columns:56px minmax(150px,1.4fr) 106px 130px}
  .vf-fr>div:nth-child(3),.vf-fr>div:nth-child(5),.vf-fr>div:nth-child(6){display:none}}
`;
