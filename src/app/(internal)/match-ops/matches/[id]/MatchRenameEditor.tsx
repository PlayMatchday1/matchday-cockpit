"use client";

// Phase 1 — rename a staging match. One editable field (the name); the match's
// identity is read-only so you can be sure it's the right one. Save is disabled
// until the name differs, and shows old → new before it fires. It POSTs to
// /api/stage/matches/[id], which writes through the host-guarded staging client:
// this UI physically cannot reach production. Plain on purpose.

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type Identity = {
  id: number; name: string; startDate: string | null; type: string | null;
  category: string | null; isCancelled: boolean | null; fieldTitle: string | null; cityName: string | null;
};

async function authFetch(path: string, init?: RequestInit): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return fetch(path, { ...init, headers: { ...(init?.headers ?? {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" }, cache: "no-store" });
}

export default function MatchRenameEditor({ id }: { id: string }) {
  const [match, setMatch] = useState<Identity | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [loadedName, setLoadedName] = useState("");
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err" | "warn"; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoadErr(null); setMsg(null);
    const res = await authFetch(`/api/stage/matches/${id}`);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) { setLoadErr(json?.error ?? `HTTP ${res.status}`); return; }
    const m = json.match as Identity;
    setMatch(m); setLoadedName(m.name ?? ""); setName(m.name ?? "");
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  const trimmed = name.trim();
  const changed = !!match && trimmed.length > 0 && trimmed !== loadedName;

  const save = async () => {
    if (!changed) return;
    setSaving(true); setMsg(null);
    const res = await authFetch(`/api/stage/matches/${id}`, { method: "PUT", body: JSON.stringify({ name: trimmed }) });
    const json = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok) {
      setMsg({ kind: json?.ambiguous ? "warn" : "err", text: json?.error ?? `HTTP ${res.status}` });
      return;
    }
    const m = json.match as Identity;
    setMatch(m); setLoadedName(m.name ?? ""); setName(m.name ?? "");
    setMsg({ kind: "ok", text: `Saved. Name is now “${m.name}”.` });
  };

  const box: React.CSSProperties = { maxWidth: 620, margin: "0 auto", padding: "28px 20px", fontFamily: "system-ui, sans-serif", color: "#12241d" };
  const label: React.CSSProperties = { fontSize: 12, fontWeight: 700, color: "#6d7b74", textTransform: "uppercase", letterSpacing: 0.6 };
  const ro: React.CSSProperties = { fontSize: 14, marginTop: 2 };

  if (loadErr) return <div style={box}><h1 style={{ fontSize: 20 }}>Match {id}</h1><p style={{ color: "#a8391a" }}>Couldn’t load: {loadErr}</p></div>;
  if (!match) return <div style={box}><p style={{ color: "#6d7b74" }}>Loading match {id}…</p></div>;

  return (
    <div style={box}>
      <div style={{ fontSize: 11, fontWeight: 800, color: "#7A5200", background: "#FFF6D6", border: "1px solid #F0DC9B", borderRadius: 6, padding: "6px 10px", display: "inline-block", marginBottom: 16 }}>
        STAGING ONLY · writes go through the host-guarded client (cannot reach production)
      </div>

      <h1 style={{ fontSize: 20, margin: "0 0 14px" }}>Edit match {match.id}</h1>

      {/* read-only identity */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, border: "1px solid #e6ebe8", borderRadius: 10, padding: 14, marginBottom: 18 }}>
        <div><div style={label}>Starts</div><div style={ro}>{match.startDate ? new Date(match.startDate).toLocaleString() : "—"}</div></div>
        <div><div style={label}>Field</div><div style={ro}>{match.fieldTitle ?? "—"}{match.cityName ? ` · ${match.cityName}` : ""}</div></div>
        <div><div style={label}>Type / category</div><div style={ro}>{match.type ?? "—"} · {match.category ?? "—"}</div></div>
        <div><div style={label}>Cancelled</div><div style={ro}>{match.isCancelled ? "yes" : "no"}</div></div>
      </div>

      {/* the one editable field */}
      <div style={{ marginBottom: 10 }}>
        <label htmlFor="matchName" style={label}>Name</label>
        <input id="matchName" value={name} onChange={(e) => setName(e.target.value)} disabled={saving}
          style={{ display: "block", width: "100%", marginTop: 4, padding: "9px 11px", fontSize: 14, border: "1px solid #cdd6d0", borderRadius: 8, boxSizing: "border-box" }} />
      </div>

      {/* old → new preview, shown before firing */}
      {changed && (
        <div style={{ fontSize: 13, color: "#3f544a", marginBottom: 12 }}>
          Will change: <span style={{ textDecoration: "line-through", color: "#93a49b" }}>{loadedName}</span> → <b>{trimmed}</b>
        </div>
      )}

      <button type="button" onClick={save} disabled={!changed || saving}
        style={{ padding: "9px 16px", fontSize: 13, fontWeight: 700, borderRadius: 8, border: 0, cursor: changed && !saving ? "pointer" : "not-allowed", background: changed && !saving ? "#0d3b2e" : "#c7d0ca", color: "#fff" }}>
        {saving ? "Saving…" : "Save"}
      </button>

      {msg && (
        <p style={{ marginTop: 14, fontSize: 13, color: msg.kind === "ok" ? "#12704a" : msg.kind === "warn" ? "#7A5200" : "#a8391a" }}>
          {msg.kind === "warn" ? "⚠ " : ""}{msg.text}
        </p>
      )}
    </div>
  );
}
