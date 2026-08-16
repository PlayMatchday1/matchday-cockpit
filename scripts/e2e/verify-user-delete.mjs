// DELETING AN ADMIN ACCOUNT — the write, end to end.
//
// THE BUG THIS PINS. The trash icon deleted straight from the browser and removed the row from the
// list BEFORE awaiting. RLS on app_users grants SELECT and nothing else, so the DELETE matched zero
// rows and PostgREST answered 204 with `error: null` — the code checked only that error, the
// rollback could never fire, and the account came back on refresh. A successful delete and a failed
// one were indistinguishable.
//
// EVERY ACCOUNT HERE IS CREATED BY THIS SUITE AND DELETED BY IT. It never touches a real one — in
// particular NOT rmancuso1@gmail.com, which is verify-city-confinement's city-manager fixture.
//
//   node scripts/e2e/verify-user-delete.mjs
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { netRetry, installHarnessGuard, fatal, closeContext, closeBrowser } from "./_session.mjs";
installHarnessGuard();

const BASE = process.env.BASE || "http://localhost:3000";
const ADMIN = "rmancuso@playmatchday.com";
const THROWAWAY = "zz-user-delete-suite@invalid.test";

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

  const wipe = async () => {
    await svc.from("app_users").delete().eq("email", THROWAWAY);
    const { data } = await svc.auth.admin.listUsers({ page: 1, perPage: 1000 });
    for (const u of data?.users ?? []) if (u.email === THROWAWAY) await svc.auth.admin.deleteUser(u.id);
  };
  const authRowsFor = async (email) => {
    const { data } = await svc.auth.admin.listUsers({ page: 1, perPage: 1000 });
    return (data?.users ?? []).filter((u) => u.email === email).length;
  };
  const appRowsFor = async (email) => {
    const { data } = await svc.from("app_users").select("id").eq("email", email);
    return (data ?? []).length;
  };
  const makeAccount = async () => {
    await wipe();
    const { data: au } = await svc.auth.admin.createUser({ email: THROWAWAY, email_confirm: true });
    const { data: row } = await svc.from("app_users").insert({ email: THROWAWAY, full_name: "Delete Suite" }).select("id").maybeSingle();
    return { appId: row.id, authId: au.user.id };
  };

  const link = await netRetry(() => svc.auth.admin.generateLink({ type: "magiclink", email: ADMIN }), "generateLink");
  const vv = await netRetry(() => anon.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token }), "verifyOtp");
  const token = vv.data.session.access_token;

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    storageState: { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: `sb-${ref}-auth-token`, value: JSON.stringify(vv.data.session) }] }] },
  });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  const call = (body, tok) => page.evaluate(async ([b, t]) => {
    const r = await fetch("/api/admin/users/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(t ? { Authorization: `Bearer ${t}` } : {}) },
      body: JSON.stringify(b),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, [body, tok ?? null]);

  console.log("deleting an admin account — the write\n");

  // ── IT ACTUALLY LANDS, IN BOTH STORES ────────────────────────────────────
  console.log("the delete lands:");
  {
    const acct = await makeAccount();
    // POSITIVE CONTROL — the account really existed first, or "it is gone" proves nothing.
    eq("the throwaway account exists in BOTH stores before the call",
      { app: await appRowsFor(THROWAWAY), auth: await authRowsFor(THROWAWAY) }, { app: 1, auth: 1 });

    const res = await call({ id: acct.appId }, token);
    eq("the route answers 200", res.status, 200);
    eq("…and reports LANDED, from a re-read rather than a status code", res.body.outcome, "LANDED");
    eq("the app_users row is gone", await appRowsFor(THROWAWAY), 0);
    // A DELETE THAT LEAVES THE IDENTITY IS NOT A DELETE — they could still authenticate.
    eq("the Supabase Auth identity is gone too", await authRowsFor(THROWAWAY), 0);
  }

  // ── IT IS LOGGED, EMAIL ONLY ─────────────────────────────────────────────
  console.log("\nit is recorded in change_log:");
  {
    const { data: log } = await svc.from("change_log")
      .select("source, method, outcome, request_body")
      .eq("source", "User admin · delete account")
      .order("created_at", { ascending: false }).limit(1);
    const e = log?.[0];
    eq("an entry exists for the delete", !!e, true);
    if (e) {
      eq("…recorded as a DELETE that landed", { m: e.method, o: e.outcome }, { m: "DELETE", o: "landed" });
      // PII: the email is the whole body. Nothing else about the person is written to a store with
      // different access rules and a longer life than the row itself.
      eq("…and the body carries the email and NOTHING else", Object.keys(e.request_body ?? {}).sort(), ["email"]);
    }
  }

  // ── THE GUARDS ───────────────────────────────────────────────────────────
  console.log("\nthe guards:");
  {
    const acct = await makeAccount();
    eq("an unauthenticated caller is refused", (await call({ id: acct.appId }, null)).status, 401);
    eq("…and the account is untouched by that attempt", await appRowsFor(THROWAWAY), 1);

    // Deleting yourself would lock the last admin out of the tool that grants admin.
    const { data: me } = await svc.from("app_users").select("id").eq("email", ADMIN).maybeSingle();
    const self = await call({ id: me.id }, token);
    eq("deleting your own account is refused", self.status, 400);
    eq("…reported as NOT APPLIED", self.body.outcome, "NOT APPLIED");
    eq("…and the admin still exists", await appRowsFor(ADMIN), 1);

    const missing = await call({ id: "00000000-0000-0000-0000-000000000000" }, token);
    eq("an unknown id is NOT APPLIED, not a false success", { s: missing.status, o: missing.body.outcome }, { s: 404, o: "NOT APPLIED" });

    await wipe();
    eq("the suite cleaned up after itself", { app: await appRowsFor(THROWAWAY), auth: await authRowsFor(THROWAWAY) }, { app: 0, auth: 0 });
  }

  // ── THE OLD FAILURE MODE CANNOT RETURN ───────────────────────────────────
  // The client wrote app_users directly and RLS silently no-opped it. Prove the policy still
  // refuses that path, so anyone re-adding a browser-side delete gets a red test rather than a
  // button that lies.
  console.log("\nthe client still cannot write app_users directly:");
  {
    const acct = await makeAccount();
    const asAdmin = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
      auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const del = await asAdmin.from("app_users").delete().eq("id", acct.appId).select("id");
    eq("a browser-side DELETE reports no error…", del.error, null);
    eq("…affects ZERO rows — which is why it fooled the old code", del.data, []);
    eq("…and the row is still there", await appRowsFor(THROWAWAY), 1);
    await wipe();
  }

  console.log(`\n================ RESULT ================\nAssertions: ${PASS} passed, ${FAIL} failed`);
  if (fails.length) fails.forEach((f) => console.log("   FAILED: " + f));
  await closeContext(ctx);
  await closeBrowser(browser);
  process.exit(FAIL === 0 ? 0 : 1);
}
main().catch(fatal);
