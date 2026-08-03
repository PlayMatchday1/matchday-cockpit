// Builds a Playwright storageState with a real Supabase session for the E2E
// identity, so headless runs land inside PagePermissionGuard instead of on the
// login redirect. Node-only. Reads .env.local automatically.
//
//   node scripts/e2e/auth.mjs          # reuse if <1h old, else re-auth
//   node scripts/e2e/auth.mjs --force  # always re-auth
//
// Primary path: signInWithPassword (this project keeps password grant enabled
// even though the UI uses email OTP). Fallback: admin.generateLink('magiclink')
// + verifyOtp with the service role, for instances where password auth is off.
// The session value is captured from a storage shim so it byte-matches exactly
// what supabase-js writes in the browser under sb-<ref>-auth-token.

import { createClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync, existsSync, statSync } from "node:fs";

try { process.loadEnvFile(".env.local"); } catch { /* env may already be set */ }

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const EMAIL = process.env.E2E_EMAIL;
const PASSWORD = process.env.E2E_PASSWORD;
const BASE = process.env.E2E_BASE_URL || "https://matchday-clubhouse.vercel.app";
const OUT = ".auth/state.json";
const force = process.argv.includes("--force");

if (!SUPA_URL || !ANON) { console.error("Missing Supabase public env"); process.exit(1); }
const ref = new URL(SUPA_URL).host.split(".")[0];
const STORAGE_KEY = `sb-${ref}-auth-token`;

// reuse a fresh state file (Supabase access tokens live ~1h)
if (!force && existsSync(OUT)) {
  const ageMin = (Date.now() - statSync(OUT).mtimeMs) / 60000;
  if (ageMin < 55) {
    console.log(`Reusing ${OUT} (${ageMin.toFixed(0)} min old). Use --force to refresh.`);
    process.exit(0);
  }
}

// capture exactly what supabase-js persists, via a storage shim.
const store = {};
const shim = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = v; },
  removeItem: (k) => { delete store[k]; },
};
const sb = createClient(SUPA_URL, ANON, {
  auth: { storage: shim, persistSession: true, autoRefreshToken: false, detectSessionInUrl: false },
});

let method = "";
let session = null;

if (EMAIL && PASSWORD) {
  const { data, error } = await sb.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
  if (!error && data.session) { session = data.session; method = "signInWithPassword"; }
  else console.warn("password auth unavailable:", error?.message);
}

if (!session) {
  // fallback: mint a session server-side via a magic-link token, then verify it
  // on the shim client so the browser storage format is produced.
  if (!SERVICE || !EMAIL) { console.error("Cannot fall back: need SERVICE key + E2E_EMAIL"); process.exit(1); }
  const admin = createClient(SUPA_URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
  const link = await admin.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
  if (link.error) { console.error("generateLink failed:", link.error.message); process.exit(1); }
  const tokenHash = link.data.properties?.hashed_token;
  const v = await sb.auth.verifyOtp({ type: "magiclink", token_hash: tokenHash });
  if (v.error || !v.data.session) { console.error("verifyOtp failed:", v.error?.message); process.exit(1); }
  session = v.data.session;
  method = "generateLink+verifyOtp";
}

// give the shim a tick to receive the write, then read the exact stored value.
await new Promise((r) => setTimeout(r, 50));
const value = store[STORAGE_KEY] ?? JSON.stringify(session);

const state = {
  cookies: [],
  origins: [{ origin: BASE, localStorage: [{ name: STORAGE_KEY, value }] }],
};
mkdirSync(".auth", { recursive: true });
writeFileSync(OUT, JSON.stringify(state, null, 2));
console.log(`Wrote ${OUT} via ${method}. origin=${BASE} key=${STORAGE_KEY} expires_in=${session.expires_in}s`);
