"use client";
// The browser side of /api/covers: the session's bearer token, the availability probe, and one call shape.
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { verdictLine, type CoverVerdict } from "@/lib/fieldCovers";

export async function coverHeaders(json = true): Promise<Record<string, string> | null> {
  const { data } = await supabase.auth.getSession();
  const t = data.session?.access_token;
  return t ? { Authorization: `Bearer ${t}`, ...(json ? { "Content-Type": "application/json" } : {}) } : null;
}

export type CoversStatus = { available: boolean; canEdit: boolean; reason: string | null };

/** null while loading. Unavailable (or signed out) renders nothing: the backend half has not shipped. */
export function useCoversStatus(): CoversStatus | null {
  const [s, setS] = useState<CoversStatus | null>(null);
  useEffect(() => {
    let live = true;
    void (async () => {
      const h = await coverHeaders(false);
      if (!h) { if (live) setS({ available: false, canEdit: false, reason: "Not signed in." }); return; }
      const r = await fetch("/api/covers/status", { headers: h, cache: "no-store" }).catch(() => null);
      const j = r?.ok ? ((await r.json()) as CoversStatus) : null;
      if (live) setS(j ?? { available: false, canEdit: false, reason: "Couldn't check whether cover photos are available." });
    })();
    return () => { live = false; };
  }, []);
  return s;
}

export async function coversGetJson<T>(path: string): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const h = await coverHeaders(false);
  if (!h) return { ok: false, error: "No active session. Sign in again." };
  const r = await fetch(path, { headers: h, cache: "no-store" }).catch(() => null);
  if (!r) return { ok: false, error: "The Clubhouse did not answer." };
  const j = await r.json().catch(() => ({}));
  return r.ok ? { ok: true, data: j as T } : { ok: false, error: (j as { error?: string }).error ?? `HTTP ${r.status}` };
}

/** One write. The verdict comes from the route's read-back; a call that never answered is UNKNOWN. Never retried. */
export async function coversWrite(path: string, init: { method: string; json?: unknown; form?: FormData }, what: string):
  Promise<{ verdict: CoverVerdict | null; line: string; body: Record<string, unknown> }> {
  const h = await coverHeaders(!init.form);
  if (!h) return { verdict: null, line: "No active session. Sign in again; nothing was sent.", body: {} };
  let r: Response;
  try {
    r = await fetch(path, { method: init.method, headers: h, body: init.form ?? (init.json === undefined ? undefined : JSON.stringify(init.json)) });
  } catch (e) {
    return { verdict: "UNKNOWN", line: verdictLine("UNKNOWN", what, `the Clubhouse did not answer (${e instanceof Error ? e.message : String(e)})`), body: {} };
  }
  const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  const verdict = (body.verdict as CoverVerdict | undefined) ?? null;
  // A refusal before any write (validation, permission, 503) has no verdict: nothing was sent upstream.
  if (!verdict) return { verdict: null, line: `Not saved: ${String(body.error ?? `HTTP ${r.status}`)}`, body };
  return { verdict, line: verdictLine(verdict, what, (body.error as string | null) ?? null), body };
}
