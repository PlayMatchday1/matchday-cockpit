"use client";

// TEMPORARY — App Store Connect 401 diagnostic trigger. Fetches
// /api/diag/appstore-token with the session bearer and shows the JSON to copy.
// Delete this component (and the route) once the 401 is resolved.

import { useState } from "react";
import { supabase } from "@/lib/supabase";

export default function AppStoreTokenDiag() {
  const [out, setOut] = useState<string>("");
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    setOut("");
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error("No active session — sign in again.");
      const res = await fetch("/api/diag/appstore-token", { headers: { Authorization: `Bearer ${token}` } });
      const json = await res.json();
      setOut(JSON.stringify(json, null, 2));
    } catch (e) {
      setOut(`error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mb-12 rounded-2xl border-[1.5px] border-coral/40 bg-coral-soft/20 p-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-bold text-deep-green">App Store token diagnostic (temporary)</h3>
          <p className="mt-1 text-xs text-deep-green/65">
            Builds a real token and calls Apple’s /v1/apps. The private key never appears in the output. Copy the JSON
            below and send it back.
          </p>
        </div>
        <button
          type="button"
          onClick={run}
          disabled={busy}
          className="shrink-0 rounded-md bg-deep-green px-4 py-2 text-sm font-bold text-cream transition hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Running…" : "Run diagnostic"}
        </button>
      </div>
      {out && (
        <pre className="mt-3 max-h-[420px] overflow-auto rounded-md bg-white p-3 text-[11px] leading-relaxed text-deep-green ring-1 ring-cream-line">
          {out}
        </pre>
      )}
    </section>
  );
}
