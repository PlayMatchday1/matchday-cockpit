"use client";

// MATCH OPS › BACK OFFICE › APPLICATIONS — everyone who filled in a form on playmatchday.com.
//
// THE VISUAL GRAMMAR IS THE EXPENSES PAGE'S, and here it is doing real work rather than decoration:
//
//   GREY + PADLOCK  mirrored from the website. Cannot be edited here, and looks like it.
//   BLUE            Clubhouse's own — status, owner, notes.
//   a vertical rule between the two halves, so the boundary is visible without reading a legend.
//
// THREE STATES THAT MUST NOT RENDER ALIKE, which is most of what this component is for:
//   a value            — the person typed it
//   "not asked"        — their form had no such field. 63 people have no Job Role for this reason,
//                        and a blank box invites someone to chase data that was never collected.
//   a DERIVED value    — inferred from a zipcode, marked `zip`. A derived value that looks typed is
//                        one nobody will ever question.
//
// NO BULK STATUS ACTION. With 66 uncontacted the temptation is to mark them all at once, and that
// destroys the only signal on the page.

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import type { Person, Tiles } from "@/lib/applicationsModel";
import { matchesSearch } from "@/lib/applicationsModel";
import { STATUSES, CITY_ORDER, type Status } from "@/lib/webSubmissions";

type Payload = {
  stream: "team" | "partner"; people: Person[]; tiles: Tiles;
  cityNames: Record<string, string>; spamCount: number; showingSpam: boolean;
  scope: string | null; confined: boolean; rawSubmissions: number; unresolvedSubmissions: number;
  spamSubmissions: number;
  unresolvedByElement: Record<string, number>;
  error?: string;
};

const fmtDate = (ymd: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(ymd)
    ? new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
    : "—";

/** The one place a mirrored value is drawn. Grey, padlocked, and never an input. */
function Locked({ v, asked, hint }: { v: string; asked: boolean; hint?: string }) {
  if (!asked) return <span className="pill na" title="This form never asked for it">not asked</span>;
  if (!v.trim()) return <span className="pill na" title="Asked, left blank">blank</span>;
  return <span className="pill lock" title={hint}><span className="pad">🔒</span>{v}</span>;
}

export default function ApplicationsView() {
  const [tab, setTab] = useState<"team" | "partner">("team");
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [city, setCity] = useState<string | null>(null);
  const [newOnly, setNewOnly] = useState(false);
  const [spam, setSpam] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(async (t: "team" | "partner", showSpam: boolean) => {
    setLoading(true); setErr(null);
    try {
      const { data: s } = await supabase.auth.getSession();
      const token = s.session?.access_token;
      const r = await fetch(`/api/applications?stream=${t}${showSpam ? "&spam=1" : ""}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {}, cache: "no-store",
      });
      const j = (await r.json()) as Payload;
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setData(j);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(tab, spam); }, [tab, spam, load]);

  const people = data?.people ?? [];
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of people) m.set(p.cityCode ?? "__none", (m.get(p.cityCode ?? "__none") ?? 0) + 1);
    return m;
  }, [people]);

  const list = useMemo(() => people.filter((p) =>
    (city === null || (city === "__none" ? !p.cityCode : p.cityCode === city))
    && (!newOnly || p.status === "New")
    && matchesSearch(p, q)), [people, city, newOnly, q]);

  const newCount = people.filter((p) => p.status === "New").length;

  async function saveContact(p: Person, patch: { status?: Status; owner?: string | null }) {
    setSaving(p.email);
    try {
      const { data: s } = await supabase.auth.getSession();
      const token = s.session?.access_token;
      const r = await fetch("/api/applications/contact", {
        method: "POST",
        headers: { "content-type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ stream: p.stream, email: p.email, ...patch }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      // The SERVER's read-back, never an optimistic patch — a 2xx is not evidence it landed.
      setData((d) => d && ({ ...d, people: d.people.map((x) => x.email === p.email
        ? { ...x, status: j.contact?.status ?? x.status, owner: j.contact?.owner ?? x.owner } : x) }));
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(null); }
  }

  const isTeam = tab === "team";
  const head = isTeam
    ? ["Applicant", "City", "Role", "Applied", "Status", "Owner", ""]
    : ["Contact", "Company", "Location", "Enquired", "Status", "Owner", ""];

  return (
    <div className="apps">
      <h1 className="h1">APPLICATIONS</h1>
      <p className="sub">
        Everyone who filled in a form on playmatchday.com. Mirrored from the website — grey fields
        come from the form and cannot be edited here. Blue fields are yours.
      </p>
      {data?.confined && (
        <p className="note" data-testid="apps-scope">
          Scoped to {data.cityNames[data.scope ?? ""] ?? data.scope}. Applicants whose city could not
          be resolved are not shown — a city that cannot be proved is not a city you can be given.
        </p>
      )}
      {/* THE FAILURE THAT WOULD OTHERWISE BE SILENT. Editing an Elementor form mints a NEW form id,
          and new submissions then arrive under an id nothing recognises — resolving to nothing,
          indefinitely, looking like a quiet week. This banner is on the PAGE and not only in the
          sync log, and it NAMES the element_id so whoever goes to look knows which form to open. */}
      {data && data.unresolvedSubmissions > 0 && (
        <div className="banner" data-testid="apps-unresolved">
          <b>{data.unresolvedSubmissions} submissions are from forms this system cannot label.</b>{" "}
          Their fields are shown under the website's raw keys rather than guessed at — a label
          borrowed from another form would file a company into a surname. Form{" "}
          {Object.entries(data.unresolvedByElement ?? {}).length ? "IDs" : "ID"}:{" "}
          {Object.entries(data.unresolvedByElement ?? {})
            .sort((a, b) => b[1] - a[1])
            .map(([el, n]) => `${el} (${n})`).join(" · ")}
          . <b>If this number grows, a live form was edited and minted a new ID.</b>
        </div>
      )}

      <div className="tabs" role="tablist">
        {(["team", "partner"] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""}
            onClick={() => { setTab(t); setCity(null); setOpen(new Set()); }} data-testid={`apps-tab-${t}`}>
            {t === "team" ? "Team applications" : "Partner leads"}
          </button>
        ))}
      </div>

      <div className="tiles" data-testid="apps-tiles">
        {(data?.tiles ?? []).map((x) => (
          <div key={x.k} className={`tile ${x.tone ?? ""}`}>
            <div className="k">{x.k}</div><div className="v">{x.v}</div><div className="h">{x.h}</div>
          </div>
        ))}
      </div>

      <div className="bar">
        <input className="search" placeholder="Name, email, phone, company or city" value={q}
          onChange={(e) => setQ(e.target.value)} data-testid="apps-search" />
        <button className={`chip ${newOnly ? "on" : ""}`} onClick={() => setNewOnly((v) => !v)} data-testid="apps-newonly">
          Not contacted <span className="n">{newCount}</span>
        </button>
        {!isTeam && data && data.spamCount > 0 && (
          /* QUARANTINE IS VIEWABLE. A rule that hides without recourse cannot be audited when wrong. */
          <button className={`chip warn ${spam ? "on" : ""}`} onClick={() => setSpam((v) => !v)} data-testid="apps-spam">
            {spam ? "Showing quarantined" : "Quarantined"} <span className="n">{data.spamCount}</span>
          </button>
        )}
      </div>

      <div className="cityRow" data-testid="apps-cities">
        <span className="lbl">City</span>
        <button className={`chip ${city === null ? "on" : ""}`} onClick={() => setCity(null)}>
          All <span className="n">{people.length}</span>
        </button>
        {CITY_ORDER.filter((c) => counts.get(c)).map((c) => (
          <button key={c} className={`chip ${city === c ? "on" : ""}`} onClick={() => setCity(c)}>
            {data?.cityNames[c] ?? c} <span className="n">{counts.get(c)}</span>
          </button>
        ))}
        {counts.get("__none") && (
          <button className={`chip warn ${city === "__none" ? "on" : ""}`} onClick={() => setCity("__none")}>
            No city <span className="n">{counts.get("__none")}</span>
          </button>
        )}
      </div>

      {err && <p className="err" data-testid="apps-error">{err}</p>}

      <section className="card">
        <div className={`thead ${isTeam ? "" : "p"}`}>{head.map((h, i) => <div key={i}>{h}</div>)}</div>
        {loading ? (
          <div className="empty">Loading…</div>
        ) : !list.length ? (
          <div className="empty">Nothing matches those filters.</div>
        ) : list.map((p) => {
          const isOpen = open.has(p.email);
          return (
            <div key={p.email} className="rowwrap" data-testid="apps-row">
              <div className={`row ${isTeam ? "" : "p"}`}>
                <div className="who">
                  <b>{p.name}</b>
                  <span className="em">{p.email}</span>
                  {p.submissions > 1 && <span className="pill multi" title={`First applied ${fmtDate(p.firstApplied)}`}>{p.submissions} submissions</span>}
                  {p.unresolved && <span className="pill warnp" title="This form's labels are not recoverable from the site">raw fields</span>}
                </div>
                <div>{isTeam ? <CityCell p={p} /> : <Locked v={p.company.value} asked={p.company.asked} />}</div>
                <div>{isTeam ? <Locked v={p.role.value} asked={p.role.asked} /> : <CityCell p={p} />}</div>
                <div className="mono">{fmtDate(p.applied)}</div>
                {/* ── THE BLUE HALF. Everything left of here is the website's; everything from here
                       is ours, and the rule between them says so without a legend. ── */}
                <div className="own">
                  <select className="sel" value={p.status} disabled={saving === p.email}
                    onChange={(e) => void saveContact(p, { status: e.target.value as Status })}
                    data-testid="apps-status">
                    {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <div className="own">
                  <input className="inp" defaultValue={p.owner ?? ""} placeholder="—" disabled={saving === p.email}
                    onBlur={(e) => { const v = e.target.value.trim(); if (v !== (p.owner ?? "")) void saveContact(p, { owner: v || null }); }}
                    data-testid="apps-owner" />
                </div>
                <div>
                  <button className="exp" onClick={() => setOpen((s) => {
                    const n = new Set(s); if (n.has(p.email)) n.delete(p.email); else n.add(p.email); return n;
                  })} aria-expanded={isOpen}>{isOpen ? "−" : "+"}</button>
                </div>
              </div>
              {isOpen && (
                <div className="detail" data-testid="apps-detail">
                  {isTeam ? (
                    <>
                      <D k="Phone" f={p.phone} />
                      <D k="Availability" f={p.availability} />
                      <div><div className="dk">First applied</div><div className="dv">{fmtDate(p.firstApplied)} · {p.submissions} submission{p.submissions > 1 ? "s" : ""}</div></div>
                      <div><div className="dk">City as typed</div><div className="dv">{p.cityRaw || "blank"}</div></div>
                      {p.why.asked && <div className="why"><div className="dk">Why would you be a good fit for MatchDay?</div><div className="dv">{p.why.value || "blank"}</div></div>}
                    </>
                  ) : (
                    <>
                      <D k="Company" f={p.company} />
                      <div><div className="dk">Location as typed</div><div className="dv">{p.cityRaw || "blank"}</div></div>
                      <div><div className="dk">First enquired</div><div className="dv">{fmtDate(p.firstApplied)} · {p.submissions} submission{p.submissions > 1 ? "s" : ""}</div></div>
                      {p.vision.asked && <div className="why"><div className="dk">Vision</div><div className="dv">{p.vision.value || "blank"}</div></div>}
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </section>

      <style jsx>{`
        .apps { padding: 4px 0 40px }
        .h1 { font-size: 30px; font-weight: 900; letter-spacing: -.6px; margin: 0 0 6px }
        .sub, .note { font-size: 12.5px; color: rgba(16,35,26,.55); margin: 0 0 10px; max-width: 760px; line-height: 1.5 }
        .note { color: #B8730B }
        .banner { border: 1px solid #F0D8A8; background: #FFF8EC; color: #7A5008; border-radius: 10px; padding: 11px 14px; font-size: 12.5px; line-height: 1.55; margin: 0 0 12px; max-width: 900px }
        .banner b { color: #5E3D05 }
        .tabs { display: flex; gap: 6px; margin: 14px 0 } 
        .tabs button { border: 1px solid #E4EAE5; background: #fff; border-radius: 999px; padding: 7px 15px; font: inherit; font-size: 13px; font-weight: 700; color: rgba(16,35,26,.55); cursor: pointer }
        .tabs button.on { background: #0F3323; border-color: #0F3323; color: #fff }
        .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(158px, 1fr)); gap: 10px; margin-bottom: 14px }
        .tile { background: #fff; border: 1px solid #E4EAE5; border-radius: 10px; padding: 13px 15px }
        .tile.hot { border-color: #F2D3C0; background: #FFF6F2 } .tile.good { border-color: #BFE7CF; background: #F2FBF5 }
        .tile .k { font-size: 10px; font-weight: 800; letter-spacing: .09em; text-transform: uppercase; color: #93A49A }
        .tile .v { font-size: 23px; font-weight: 900; margin: 2px 0 1px } .tile .h { font-size: 11px; color: rgba(16,35,26,.45) }
        .bar { display: flex; gap: 9px; align-items: center; flex-wrap: wrap; margin-bottom: 9px }
        .search { flex: 1; min-width: 220px; border: 1px solid #E4EAE5; border-radius: 9px; padding: 9px 12px; font: inherit; font-size: 15px }
        @media (min-width: 640px) { .search { font-size: 13px } }
        .cityRow { display: flex; gap: 7px; align-items: center; flex-wrap: wrap; margin-bottom: 13px }
        .lbl { font-size: 10.5px; font-weight: 800; letter-spacing: .09em; color: #93A49A; text-transform: uppercase }
        .chip { border: 1px solid #E4EAE5; background: #fff; border-radius: 999px; padding: 6px 13px; font: inherit; font-size: 13px; font-weight: 600; color: rgba(16,35,26,.7); cursor: pointer; min-height: 34px }
        .chip.on { background: #0F3323; border-color: #0F3323; color: #fff }
        .chip.warn.on { background: #B8730B; border-color: #B8730B }
        .chip .n { opacity: .55; margin-left: 5px; font-weight: 800 }
        .card { background: #fff; border: 1.5px solid #E4EAE5; border-radius: 14px; overflow: hidden }
        .thead, .row { display: grid; grid-template-columns: minmax(220px,2.2fr) 150px 150px 110px 132px 128px 42px; gap: 10px; align-items: center; padding: 10px 14px }
        .thead { background: #F5F8F5; font-size: 9.5px; font-weight: 900; letter-spacing: .09em; text-transform: uppercase; color: rgba(16,35,26,.5) }
        .row { border-top: 1px solid #EFF3EF; font-size: 13px }
        /* THE RULE BETWEEN THE TWO HALVES. Everything left is the website's, everything right ours. */
        .row .own:first-of-type, .thead div:nth-child(5) { border-left: 2px solid #BBD6F6; padding-left: 10px }
        .who { display: flex; flex-direction: column; gap: 2px; min-width: 0 }
        .who .em { font-size: 11.5px; color: rgba(16,35,26,.45); overflow-wrap: anywhere }
        .pill { display: inline-flex; align-items: center; gap: 5px; border-radius: 999px; padding: 3px 9px; font-size: 12px; font-weight: 700; max-width: 100% }
        .pill.lock { background: #F1F4F1; color: #3C4F44 } .pill.lock .pad { opacity: .5; font-size: 10px }
        .pill.na { background: #FAFBFA; color: #A9B5AD; font-style: italic; font-weight: 600 }
        .pill.derived { background: #EFECFD; color: #5B4BC4 } .pill.derived .pad { font-size: 9px; opacity: .7; letter-spacing: .06em }
        .pill.multi { background: #EFF6FF; color: #1E5FBF; align-self: flex-start; font-size: 11px }
        .pill.warnp { background: #FFF6E3; color: #B8730B; align-self: flex-start; font-size: 11px }
        .sel, .inp { width: 100%; border: 1px solid #BBD6F6; background: #F7FBFF; border-radius: 8px; padding: 6px 8px; font: inherit; font-size: 12.5px; color: #10231A }
        .exp { border: 1px solid #E4EAE5; background: #fff; border-radius: 8px; width: 28px; height: 28px; font-size: 15px; font-weight: 800; cursor: pointer; color: rgba(16,35,26,.55) }
        .detail { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; padding: 4px 14px 16px; background: #FAFCFA; border-top: 1px dashed #E4EAE5 }
        .detail .why { grid-column: 1/-1 }
        .dk { font-size: 10px; font-weight: 800; letter-spacing: .09em; color: #93A49A; text-transform: uppercase; margin-bottom: 3px }
        .dv { background: #fff; border: 1px solid #E4EAE5; border-radius: 8px; padding: 10px 12px; font-size: 13px; color: #3C4F44; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 200px; overflow: auto }
        .empty { padding: 30px; text-align: center; color: rgba(16,35,26,.5); font-size: 13.5px }
        .err { color: #E8492A; font-size: 12.5px }
        .mono { font-variant-numeric: tabular-nums }
        @media (max-width: 900px) { .thead { display: none } .row { grid-template-columns: 1fr 1fr; gap: 8px } .row .own:first-of-type, .thead div:nth-child(5) { border-left: 0; padding-left: 0 } }
      `}</style>
    </div>
  );
}

function CityCell({ p }: { p: Person }) {
  if (!p.cityCode) return <span className="pill na" title={p.cityRaw ? `Typed "${p.cityRaw}" — not on the map` : "This form never asked"}>{p.cityRaw ? "unrecognised" : "not asked"}</span>;
  // DERIVED, AND IT SAYS SO. Inferred from a zipcode — never rendered like a city someone typed.
  if (p.citySource === "zip") return <span className="pill derived" title={`Derived from zipcode ${p.cityRaw}`}>{p.cityName} <span className="pad">ZIP</span></span>;
  return <span className="pill lock"><span className="pad">🔒</span>{p.cityName}</span>;
}

function D({ k, f }: { k: string; f: { value: string; asked: boolean } }) {
  return (
    <div>
      <div className="dk">{k}</div>
      <div className="dv">{!f.asked ? <i style={{ color: "#A9B5AD" }}>not asked on this form</i> : f.value || <i style={{ color: "#A9B5AD" }}>blank</i>}</div>
    </div>
  );
}
