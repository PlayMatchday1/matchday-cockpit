// THE DOOR — does the PWA's launch route open for the account that launches it?
//
// WHY THIS EXISTS. verify-city-confinement drives /city/gameday, /city/reviews and /city/manager-pay
// directly and passes. Every city manager could still not get in, because an installed PWA does not
// navigate to those routes — it opens manifest.json's start_url, which was
// "/match-ops/player-chats". No city manager can open that: matchOpsReadGate refuses the tier
// outright. The suite tested the rooms and nothing tested the door.
//
// WHAT IT ASSERTS. For every real city-manager row plus a fixture for each tier shape, resolve what
// launching the app lands on, then ask the SERVER GATE THAT GUARDS THAT ROUTE whether it would
// serve it. Not canAccess() — canAccess grants matchops and chats to any confined row without
// reading either column (useAuth.ts:163), so it would cheerfully approve the very route that was
// broken. The server is the authority here precisely because the client and it disagree.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.loadEnvFile(".env.local");

let n = 0, failed = 0;
const t = (name: string, fn: () => void | Promise<void>) => {
  try { const r = fn(); if (r instanceof Promise) throw new Error("use tAsync"); n += 1; console.log(`  ok ${name}`); }
  catch (e) { failed += 1; console.log(`  FAIL ${name} — ${(e as Error).message.split("\n")[0]}`); }
};

type Row = Record<string, unknown>;

const manifest = JSON.parse(readFileSync("public/manifest.json", "utf8")) as { start_url?: string; scope?: string };
const START = String(manifest.start_url ?? "");

async function main() {
  const { firstAllowedPath } = await import("../src/lib/useAuth");
  const { matchOpsReadGate } = await import("../src/lib/matchOpsAuth");
  const { cityManagerGate } = await import("../src/lib/cityManagerAuth");
  const { can } = await import("../src/lib/capabilities");

  /* WHICH GATE GUARDS WHICH ROUTE. Returns null for a route this map does not know — and null is
   * treated as a FAILURE, not a pass, so adding a landing route without teaching this map is a red
   * suite rather than a silent hole. */
  const serverWouldServe = (route: string, row: Row, email: string): boolean | null => {
    if (route === "/city" || route.startsWith("/city/")) return cityManagerGate(row as never, email).ok;
    if (route === "/match-ops" || route.startsWith("/match-ops/")) return matchOpsReadGate(row as never, email).ok;
    if (route === "/home") return can(row, "home", email);
    if (route.startsWith("/admin/finance")) return can(row, "finance", email);
    if (route.startsWith("/lifecycle")) return can(row, "lifecycle", email);
    if (route.startsWith("/growth")) return can(row, "growth", email);
    if (route.startsWith("/membership")) return can(row, "membership", email);
    if (route.startsWith("/tech")) return can(row, "tech", email);
    if (route.startsWith("/org")) return can(row, "org", email);
    if (route === "/no-access") return false;   // landing here IS the failure
    return null;
  };

  /* THE LAUNCH RESOLUTION, as the app performs it. start_url "/" renders the shell, which routes
   * through firstAllowedPath per account. Any other start_url is a fixed destination for everyone. */
  const landingFor = (row: Row): string =>
    START === "/" ? firstAllowedPath(row as never) : START;

  t("manifest declares a start_url", () => assert.equal(START.length > 0, true));
  t('scope is "/" so every in-app route stays inside the installed window', () =>
    assert.equal(manifest.scope, "/"));

  // ── fixture rows: one per tier shape, so the suite holds even if an account is repointed ──────
  const base: Row = {
    email: "fixture@playmatchday.com", is_admin: false, is_service_account: false,
    is_city_manager: false, city_identifier: null,
    can_access_home: false, can_access_finance: false, can_access_lifecycle: false,
    can_access_growth: false, can_access_membership: false, can_access_matchops: false,
    can_access_chats: false, can_access_tech: false, can_access_org: false,
  };
  const cm = (city: string): Row => ({ ...base, email: `cm-${city}@playmatchday.com`, is_city_manager: true, city_identifier: city });
  const FIXTURES: { label: string; row: Row }[] = [
    { label: "city manager ATX", row: cm("ATX") },
    { label: "city manager SATX", row: cm("SATX") },
    { label: "city manager DFW", row: cm("DFW") },
    { label: "city manager HOU", row: cm("HOU") },
    { label: "city manager OKC (no such account today — the shape still must work)", row: cm("OKC") },
    { label: "admin", row: { ...base, email: "admin@playmatchday.com", is_admin: true } },
    { label: "confined non-manager (Warsaw shape)", row: { ...base, email: "waw@playmatchday.pl", city_identifier: "WAW", can_access_matchops: true, can_access_chats: true } },
    { label: "ordinary Match Ops operator", row: { ...base, email: "ops@playmatchday.com", can_access_matchops: true } },
  ];

  for (const f of FIXTURES) {
    const landing = landingFor(f.row);
    const served = serverWouldServe(landing, f.row, String(f.row.email));
    t(`${f.label}: launch lands on ${landing} — and the server serves it`, () => {
      assert.notEqual(landing, "", "no landing resolved");
      assert.notEqual(served, null, `no gate mapped for ${landing} — teach serverWouldServe`);
      assert.equal(served, true, `server would REFUSE ${landing}`);
    });
  }

  // ── and every REAL city-manager row on production ─────────────────────────────────────────────
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const { data, error } = await sb.from("app_users").select("*").eq("is_city_manager", true);
  if (error) { failed += 1; console.log(`  FAIL could not read app_users — ${error.message}`); }
  else {
    // Expects >= 1, so a read that returned nothing fails rather than passing vacuously.
    t(`control: production has city-manager rows to check (${data.length})`, () =>
      assert.equal(data.length >= 1, true));
    for (const row of data as Row[]) {
      const email = String(row.email);
      const landing = landingFor(row);
      const served = serverWouldServe(landing, row, email);
      t(`LIVE ${email} (${row.city_identifier}): lands on ${landing} — served`, () => {
        assert.notEqual(served, null, `no gate mapped for ${landing}`);
        assert.equal(served, true, `server would REFUSE ${landing}`);
      });
    }
  }

  console.log(`\n${n} passed, ${failed} failed`);
  if (failed) process.exit(1);
  if (n === 0) { console.log("ZERO ASSERTIONS — that is a failure, not a pass"); process.exit(1); }
}

main();
