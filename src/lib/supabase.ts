"use client";

import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!.trim();
const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!.trim();

export const supabase = createClient(url, key);

// ── TEST-ONLY realtime capture seam (Phase 19 Step 0b) ──────────────────────────────────────
// STRIPPED FROM THE PRODUCTION BUILD. The whole block is guarded by
// `process.env.NODE_ENV !== "production"`, which Next inlines to `"production" !== "production"`
// → `false` in the prod client bundle, so the minifier dead-code-eliminates everything below:
// in production there is NO wrapper, NO per-call branch, NO allocation, and NO way to capture or
// invoke a channel callback. The capability the test uses (invoking a captured postgres_changes
// handler with a synthetic row) therefore CANNOT exist in the shipped app — so it is not a spoof
// vector for an operator, who only ever runs the production build. It exists only in the dev
// build (`npm run dev`, which verify-crm-characterize drives) and even there stays inert unless a
// test explicitly arms `window.__CRM_TEST_REALTIME__ = []` before mount. `.subscribe()` still
// runs (harmless; receives nothing). See scripts/e2e/verify-crm-characterize.mjs.
if (process.env.NODE_ENV !== "production" && typeof window !== "undefined") {
  // `removed` lets a test tell a LIVE channel from one that was cleaned up (removeChannel /
  // unsubscribe). Without it the seam only ever grows, so a leaked SAME-NAMED subscription (the
  // real crash mode: one INSERT painted twice) is indistinguishable from correct re-subscription.
  // `ch` is the channel handle, matched on removal; it is never serialized by the tests.
  type Rec = { name: string; removed: boolean; ch: unknown; handlers: Array<{ event: unknown; filter: unknown; cb: (p: unknown) => void }> };
  const w = window as unknown as { __CRM_TEST_REALTIME__?: Rec[] };
  const origChannel = supabase.channel.bind(supabase);
  supabase.channel = ((name: string, opts?: unknown) => {
    const ch = origChannel(name, opts as never);
    if (Array.isArray(w.__CRM_TEST_REALTIME__)) {
      const rec: Rec = { name, removed: false, ch, handlers: [] };
      const origOn = ch.on.bind(ch);
      // supabase-js .on(type, filter, cb) — record (filter, cb) so the test can fire one.
      (ch as unknown as { on: unknown }).on = ((type: unknown, filter: unknown, cb: (p: unknown) => void) => {
        rec.handlers.push({ event: type, filter, cb });
        return (origOn as (a: unknown, b: unknown, c: unknown) => unknown)(type, filter, cb);
      });
      // A channel that unsubscribes itself is no longer live either.
      const origUnsub = ch.unsubscribe.bind(ch);
      (ch as unknown as { unsubscribe: unknown }).unsubscribe = ((...a: unknown[]) => {
        rec.removed = true;
        return (origUnsub as (...x: unknown[]) => unknown)(...a);
      });
      w.__CRM_TEST_REALTIME__.push(rec);
    }
    return ch;
  }) as typeof supabase.channel;
  // The provider cleans up with supabase.removeChannel(channel) — mark that rec not-live.
  const origRemove = supabase.removeChannel.bind(supabase);
  supabase.removeChannel = ((channel: unknown) => {
    if (Array.isArray(w.__CRM_TEST_REALTIME__)) {
      for (const r of w.__CRM_TEST_REALTIME__) if (r.ch === channel) r.removed = true;
    }
    return (origRemove as (c: unknown) => unknown)(channel as never);
  }) as typeof supabase.removeChannel;
}
