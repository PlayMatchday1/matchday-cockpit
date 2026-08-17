// PERMISSION TOGGLES — the write that had never once written.
//
// THE BUG THIS PINS. AdminUsersView toggled app_users straight from the browser, moved the switch
// BEFORE awaiting, and checked only `updateErr`. RLS grants SELECT and nothing else, so the UPDATE
// matched zero rows and returned no error: the rollback could never fire and the switch stayed
// where you put it until reload. Corroborated at the other end — across the whole change_log,
// ZERO entries have ever changed is_admin or any can_access_* / can_manage_* / can_edit_* flag.
//
// THE REVOKE DIRECTION IS THE DANGEROUS ONE. A failed grant leaves someone with less access than
// intended. A failed revoke leaves them with MORE, and the screen looked identical either way.
//
// Every account here is created and destroyed by this suite. It never touches a real one.
//
//   node scripts/e2e/verify-user-permissions.mjs
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { netRetry, installHarnessGuard, fatal, closeContext, closeBrowser, sessionFor } from "./_session.mjs";
installHarnessGuard();

const BASE = process.env.BASE || "http://localhost:3000";
const ADMIN = "rmancuso@playmatchday.com";
const THROWAWAY = "zz-perms-suite@invalid.test";

let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ✓ ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

async function main() {
  process.loadEnvFile(".env.local");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const svc = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const anon = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
  const ref = new URL(url).host.split(".")[0];

  const wipe = () => svc.from("app_users").delete().eq("email", THROWAWAY);
  const make = async (extra = {}) => {
    await wipe();
    const { data } = await svc.from("app_users")
      .insert({ email: THROWAWAY, full_name: "Perms Suite", ...extra }).select("id").maybeSingle();
    return data.id;
  };
  const flagOf = async (id, key) => {
    const { data } = await svc.from("app_users").select(`id, ${key}`).eq("id", id).maybeSingle();
    return data?.[key] ?? null;
  };

  // ONE SESSION PER IDENTITY, cached across the whole gate run — see sessionFor in _session.mjs.
  const session = await sessionFor(ADMIN);
  const token = session.access_token;

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    storageState: { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: `sb-${ref}-auth-token`, value: JSON.stringify(session) }] }] },
  });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  const call = (body, tok) => page.evaluate(async ([b, t]) => {
    const r = await fetch("/api/admin/users/permissions", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(t ? { Authorization: `Bearer ${t}` } : {}) },
      body: JSON.stringify(b),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, [body, tok ?? null]);

  console.log("permission toggles — the write\n");

  // ── A GRANT LANDS, AND A REVOKE LANDS ────────────────────────────────────
  console.log("the write actually writes:");
  {
    const id = await make();
    eq("the throwaway account starts without Match Ops", await flagOf(id, "can_access_matchops"), false);

    const grant = await call({ id, key: "can_access_matchops", value: true }, token);
    eq("granting answers 200", grant.status, 200);
    eq("…reported LANDED, from a re-read and not a status code", grant.body.outcome, "LANDED");
    eq("…and the DATABASE says true", await flagOf(id, "can_access_matchops"), true);

    // THE DIRECTION THAT MATTERS. A revoke that silently fails leaves more access, not less.
    const revoke = await call({ id, key: "can_access_matchops", value: false }, token);
    eq("revoking reports LANDED", revoke.body.outcome, "LANDED");
    eq("…and the DATABASE says false", await flagOf(id, "can_access_matchops"), false);

    // A WRITE GRANT — not overridden by is_admin anywhere, so a failed revoke here left a real
    // capability in place.
    await call({ id, key: "can_edit_credits", value: true }, token);
    eq("a write grant (can_edit_credits) lands too", await flagOf(id, "can_edit_credits"), true);
    await call({ id, key: "can_edit_credits", value: false }, token);
    eq("…and can be revoked", await flagOf(id, "can_edit_credits"), false);

    const name = await call({ id, key: "full_name", value: "Renamed By Suite" }, token);
    eq("the name edit uses the same route and lands", { o: name.body.outcome, v: await flagOf(id, "full_name") },
      { o: "LANDED", v: "Renamed By Suite" });
    await wipe();
  }

  // ── IT IS LOGGED, EMAIL ONLY ─────────────────────────────────────────────
  console.log("\nit is recorded in change_log:");
  {
    const id = await make();
    await call({ id, key: "can_access_tech", value: true }, token);
    const { data: log } = await svc.from("change_log")
      .select("method, outcome, request_body, changes")
      .eq("source", "User admin · permissions")
      .order("created_at", { ascending: false }).limit(1);
    const e = log?.[0];
    eq("an entry exists", !!e, true);
    if (e) {
      eq("…recorded as landed", e.outcome, "landed");
      // PII: the email plus which flag moved. Nothing else about the person.
      eq("…the body carries email/key/value and nothing else", Object.keys(e.request_body ?? {}).sort(), ["email", "key", "value"]);
      eq("…and the change names the before and after", (e.changes ?? []).length > 0 && e.changes[0].before === "false" && e.changes[0].after === "true", true);
    }
    await wipe();
  }

  // ── THE GUARDS ───────────────────────────────────────────────────────────
  console.log("\nthe guards:");
  {
    const id = await make();
    eq("an unauthenticated caller is refused", (await call({ id, key: "is_admin", value: true }, null)).status, 401);
    eq("…and the flag is untouched", await flagOf(id, "is_admin"), false);

    // AN ALLOWLIST, NOT THE REQUEST'S WORD FOR IT. `key` becomes a column name.
    const bogus = await call({ id, key: "is_service_account", value: true }, token);
    eq("a column outside the allowlist is refused", bogus.status, 400);
    const injected = await call({ id, key: "city_identifier", value: true }, token);
    eq("…including one that exists but is not this route's business", injected.status, 400);

    const notBool = await call({ id, key: "is_admin", value: "yes" }, token);
    eq("a non-boolean for a boolean flag is refused", notBool.status, 400);

    const noop = await call({ id, key: "can_access_home", value: false }, token);
    eq("setting a value that is already set is NOT APPLIED, not a false success",
      { s: noop.status, o: noop.body.outcome }, { s: 200, o: "NOT APPLIED" });

    const missing = await call({ id: "00000000-0000-0000-0000-000000000000", key: "is_admin", value: true }, token);
    eq("an unknown id is NOT APPLIED", { s: missing.status, o: missing.body.outcome }, { s: 404, o: "NOT APPLIED" });
    await wipe();
  }

  // ── SELF-LOCKOUT ─────────────────────────────────────────────────────────
  {
    const { data: me } = await svc.from("app_users").select("id, is_admin").eq("email", ADMIN).maybeSingle();
    const self = await call({ id: me.id, key: "is_admin", value: false }, token);
    eq("removing your OWN admin is refused", { s: self.status, o: self.body.outcome }, { s: 400, o: "NOT APPLIED" });
    const { data: after } = await svc.from("app_users").select("is_admin").eq("id", me.id).maybeSingle();
    eq("…and the admin still holds it", after.is_admin, true);
  }

  // ── MIGRATION 0124 STILL BINDS ───────────────────────────────────────────
  // Granting a broad flag to a city manager is the combination that let one read every city. It
  // must be a STATED refusal, never the silent no-op this whole route exists to end.
  console.log("\nthe city-manager exclusivity check still binds:");
  {
    const id = await make({ is_city_manager: true, city_identifier: "ATX" });
    const clash = await call({ id, key: "can_access_matchops", value: true }, token);
    eq("granting a broad flag to a city manager is a 409", clash.status, 409);
    eq("…named as the exclusivity conflict", clash.body.conflict, "city-manager-exclusive");
    eq("…explained in words, not a Postgres string", /City Manager is scoped/i.test(clash.body.error ?? ""), true);
    // THE POINT: it did not quietly succeed, and it did not quietly fail either.
    eq("…and the flag really is still false", await flagOf(id, "can_access_matchops"), false);
    await wipe();
  }

  // ── THE OLD FAILURE MODE CANNOT RETURN ───────────────────────────────────
  console.log("\nthe client still cannot write app_users directly:");
  {
    const id = await make();
    const asAdmin = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
      auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const upd = await asAdmin.from("app_users").update({ can_access_tech: true }).eq("id", id).select("id");
    eq("a browser-side UPDATE reports no error…", upd.error, null);
    eq("…affects ZERO rows — which is why it hid for the table's whole history", upd.data, []);
    eq("…and the flag never moved", await flagOf(id, "can_access_tech"), false);
    await wipe();
  }

  console.log(`\n================ RESULT ================\nAssertions: ${PASS} passed, ${FAIL} failed`);
  if (fails.length) fails.forEach((f) => console.log("   FAILED: " + f));
  await closeContext(ctx);
  await closeBrowser(browser);
  process.exit(FAIL === 0 ? 0 : 1);
}
main().catch(fatal);
