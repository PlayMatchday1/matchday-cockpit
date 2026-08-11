"use client";

import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!.trim();
const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!.trim();

export const supabase = createClient(url, key);

// ── TEST-ONLY realtime capture seam (Phase 19 Step 0b) ──────────────────────────────────────
// Production behaviour is UNTOUCHED: unless a test sets `window.__CRM_TEST_REALTIME__ = []`
// BEFORE the app mounts (via Playwright addInitScript), this wrapper is a transparent pass-
// through — the flag is never set in prod. When it IS set, every channel's postgres_changes
// handlers are recorded so a hermetic test can invoke a synthetic INSERT at the subscription
// boundary and assert the realtime PAINT — the one CrmClient behaviour that can't be driven by
// a live websocket in a hermetic run. `.subscribe()` still runs (harmless; receives nothing).
// See scripts/e2e/verify-crm-characterize.mjs.
if (typeof window !== "undefined") {
  type Rec = { name: string; handlers: Array<{ event: unknown; filter: unknown; cb: (p: unknown) => void }> };
  const w = window as unknown as { __CRM_TEST_REALTIME__?: Rec[] };
  const origChannel = supabase.channel.bind(supabase);
  supabase.channel = ((name: string, opts?: unknown) => {
    const ch = origChannel(name, opts as never);
    if (Array.isArray(w.__CRM_TEST_REALTIME__)) {
      const rec: Rec = { name, handlers: [] };
      const origOn = ch.on.bind(ch);
      // supabase-js .on(type, filter, cb) — record (filter, cb) so the test can fire one.
      (ch as unknown as { on: unknown }).on = ((type: unknown, filter: unknown, cb: (p: unknown) => void) => {
        rec.handlers.push({ event: type, filter, cb });
        return (origOn as (a: unknown, b: unknown, c: unknown) => unknown)(type, filter, cb);
      });
      w.__CRM_TEST_REALTIME__.push(rec);
    }
    return ch;
  }) as typeof supabase.channel;
}
