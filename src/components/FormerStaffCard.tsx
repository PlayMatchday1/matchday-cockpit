"use client";

/* FORMER STAFF — a switch on Player Lookup (0266, 2026-11-09). A person flagged here is left off Player Lifecycle
 * › Churn: former employees played and managed on free or $1 plans and read as the heaviest players who stopped.
 * MANAGE PLAYERS to change it (the route checks it fresh); everyone else sees the state, greyed. The verdict comes
 * from the route's read-back. */

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type State = { formerStaff: boolean; setBy: string | null; setAt: string | null; canManage: boolean };

async function call(path: string, init?: RequestInit): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return fetch(path, { ...init, headers: { ...(init?.headers ?? {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" }, cache: "no-store" });
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", year: "numeric" }) : "");

export default function FormerStaffCard({ playerId }: { playerId: number }) {
  const [st, setSt] = useState<State | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  const load = useCallback(async () => {
    const r = await call(`/api/lookup/former-staff?playerId=${playerId}`);
    const b = (await r.json().catch(() => ({}))) as Partial<State> & { error?: string };
    if (r.ok) setSt({ formerStaff: !!b.formerStaff, setBy: b.setBy ?? null, setAt: b.setAt ?? null, canManage: !!b.canManage });
    else setMsg({ text: b.error ?? `HTTP ${r.status}`, ok: false });
  }, [playerId]);
  useEffect(() => { setSt(null); setMsg(null); void load(); }, [load]);

  const toggle = async () => {
    if (!st || busy) return;
    setBusy(true); setMsg(null);
    const want = !st.formerStaff;
    try {
      const r = await call("/api/lookup/former-staff", { method: "POST", body: JSON.stringify({ playerId, formerStaff: want }) });
      const b = (await r.json().catch(() => ({}))) as Partial<State> & { verdict?: string; error?: string };
      if (b.verdict === "LANDED") {
        setSt((s) => ({ ...(s as State), formerStaff: !!b.formerStaff, setBy: b.setBy ?? null, setAt: b.setAt ?? null }));
        setMsg({ text: want ? "LANDED: flagged as former staff. They are left off Churn." : "LANDED: no longer former staff.", ok: true });
      } else setMsg({ text: `${b.verdict ?? "FAILED"}: ${b.error ?? `HTTP ${r.status}`}`, ok: false });
    } catch (e) {
      setMsg({ text: `UNKNOWN: ${e instanceof Error ? e.message : String(e)}`, ok: false });
    } finally { setBusy(false); }
  };

  if (!st) return msg ? <div className="panel"><p className="empty small">Former staff: {msg.text}</p></div> : null;
  return (
    <div className="panel" data-testid="former-staff">
      <div className="ptitle">
        <h3>FORMER STAFF</h3>
        <span className="acts">
          <label style={{ display: "inline-flex", alignItems: "center", gap: 8, cursor: st.canManage ? "pointer" : "default" }}
            title={st.canManage ? "" : "Needs MANAGE PLAYERS"}>
            <input type="checkbox" checked={st.formerStaff} disabled={!st.canManage || busy} onChange={toggle} data-testid="former-staff-toggle" />
            <span>{st.formerStaff ? "Former staff" : "Not staff"}</span>
          </label>
        </span>
      </div>
      <p className="empty small" style={{ margin: "6px 0 0" }}>
        {st.formerStaff ? `Left off Churn. Set by ${st.setBy ?? "unknown"} on ${when(st.setAt)}.` : "Former MatchDay staff are left off Player Lifecycle › Churn."}
        {!st.canManage && " Changing it needs MANAGE PLAYERS."}
      </p>
      {msg && <p className="small" style={{ margin: "6px 0 0", color: msg.ok ? "#1f8a57" : "#a8382b" }}>{msg.text}</p>}
    </div>
  );
}
