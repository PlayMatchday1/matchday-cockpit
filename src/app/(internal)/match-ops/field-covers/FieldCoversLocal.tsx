"use client";
// The client half of the local cover page. See page.tsx for why it exists.
import { useCallback, useEffect, useState } from "react";
import FieldCoversSection from "@/components/covers/FieldCoversSection";
import MatchCoverField from "@/components/covers/MatchCoverField";
import { coversGetJson } from "@/components/covers/coversClient";
import { wallClockLabel } from "@/lib/fieldCovers";

type F = { id: number; title: string; city: string | null };
type M = { id: number; name: string; startDate: string; startDateUtc: string; isCancelled: boolean; coverId: number | null; coverUrl: string | null };

const CSS = `
.fcl{display:grid;grid-template-columns:220px minmax(0,1fr) minmax(0,460px);gap:16px;padding:16px;align-items:start;color:#0e1a13;font:14px/1.45 ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.fcl h2{font-size:12px;letter-spacing:.12em;color:#4a6157;margin:0 0 8px}
.fcl-box{background:#fff;border:1px solid #dde6e1;border-radius:12px;padding:14px;min-width:0}
.fcl-f{display:block;width:100%;text-align:left;border:0;background:none;padding:8px;border-radius:8px;font:inherit;cursor:pointer}
.fcl-f.on{background:#e7f4ec;font-weight:800}
.fcl-f small{display:block;color:#4a6157}
.fcl-m{display:flex;justify-content:space-between;gap:8px;width:100%;border:0;border-bottom:1px solid #eef2f0;background:none;padding:7px 4px;font:inherit;text-align:left;cursor:pointer}
.fcl-m.on{background:#f4f9f6}
.fcl-m em{font-style:normal;color:#4a6157;font-size:12px}
.fcl-ban{grid-column:1/-1;background:#fff8e6;border:1px solid #f1d58a;border-radius:10px;padding:8px 12px;font-size:12.5px}
.fcl-head{font-size:18px;font-weight:800;margin:0 0 2px}
@media (max-width:1100px){.fcl{grid-template-columns:1fr}}
`;

export default function FieldCoversLocal() {
  const [fields, setFields] = useState<F[] | null>(null);
  const [fieldId, setFieldId] = useState<number | null>(null);
  const [matches, setMatches] = useState<M[] | null>(null);
  const [matchId, setMatchId] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    void (async () => {
      const r = await coversGetJson<{ fields: F[] }>("/api/covers/fields");
      if (!r.ok) { setErr(r.error); return; }
      setFields(r.data.fields);
      const want = Number(new URLSearchParams(window.location.search).get("field"));
      setFieldId(r.data.fields.some((f) => f.id === want) ? want : r.data.fields[0]?.id ?? null);
    })();
  }, []);
  const loadMatches = useCallback(async (id: number) => {
    const r = await coversGetJson<{ matches: M[] }>(`/api/covers/fields/${id}/matches`);
    setMatches(r.ok ? r.data.matches : []);
    if (!r.ok) setErr(r.error);
  }, []);
  useEffect(() => { if (fieldId) { setMatchId(null); void loadMatches(fieldId); } }, [fieldId, loadMatches]);

  const field = fields?.find((f) => f.id === fieldId) ?? null;
  const now = Date.now();
  return (
    <div className="fcl" data-testid="fcl">
      <style>{CSS}</style>
      <div className="fcl-ban" data-testid="fcl-banner">LOCAL MODE: fake seed data on the local backend (localhost:3010). Nothing here reaches staging or production.
        The same two components are mounted in the Fields drawer and the Gameday Ops match panel, where they stay hidden until the backend ships.</div>
      {err && <div className="fcl-ban" data-testid="fcl-error">{err}</div>}
      <div className="fcl-box">
        <h2>FIELDS</h2>
        {(fields ?? []).map((f) => (
          <button key={f.id} className={"fcl-f" + (f.id === fieldId ? " on" : "")} data-testid="fcl-field" data-field-id={f.id} onClick={() => setFieldId(f.id)}>
            {f.title}<small>{f.city ?? ""} · ID {f.id}</small></button>
        ))}
      </div>
      <div className="fcl-box" data-testid="fcl-field-panel">
        {field && <><p className="fcl-head">{field.title}</p><p style={{ margin: "0 0 12px", color: "#4a6157", fontSize: 12.5 }}>Field panel · ID {field.id}</p>
          <FieldCoversSection key={`${field.id}:${tick}`} fieldId={field.id} /></>}
        <h2 style={{ marginTop: 18 }}>MATCHES AT THIS FIELD</h2>
        <button className="fcl-m" style={{ color: "#146c43", fontWeight: 700 }} onClick={() => { if (fieldId) void loadMatches(fieldId); setTick((t) => t + 1); }} data-testid="fcl-refresh">↻ Refresh</button>
        {(matches ?? []).map((m) => (
          <button key={m.id} className={"fcl-m" + (m.id === matchId ? " on" : "")} data-testid="fcl-match" data-match-id={m.id} onClick={() => setMatchId(m.id)}>
            <span>{wallClockLabel(m.startDate)} · {m.name}</span>
            <em>{new Date(m.startDateUtc).getTime() > now ? "upcoming" : "past"} · {m.coverId ? `cover #${m.coverId}` : "Default"} · ID {m.id}</em>
          </button>
        ))}
      </div>
      <div className="fcl-box" data-testid="fcl-match-panel">
        <h2>MATCH PANEL</h2>
        {matchId ? (
          <>
            <p className="fcl-head">{matches?.find((m) => m.id === matchId)?.name}</p>
            <p style={{ margin: "0 0 12px", color: "#4a6157", fontSize: 12.5 }}>ID {matchId} · {field?.title}</p>
            <MatchCoverField key={matchId} matchId={matchId} manageHref={(fid) => `/match-ops/field-covers?field=${fid}`} />
          </>
        ) : <p style={{ color: "#4a6157" }}>Pick a match.</p>}
      </div>
    </div>
  );
}
