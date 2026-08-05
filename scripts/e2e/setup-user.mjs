// One-time setup: create a dedicated, read-only automation identity for the E2E
// harness. Node-only (uses the service role key from .env.local — NEVER import
// this from application code). Idempotent: safe to re-run.
//
// It creates a Supabase auth user (email pre-confirmed), sets a password so the
// harness can signInWithPassword, and inserts the minimum app_users row that
// grants READ on every tab (all can_access_* = true) with is_admin = false — so
// this identity can open every page but cannot reach any admin-gated write path
// (those check is_admin). Credentials are appended to .env.local (gitignored) as
// E2E_EMAIL / E2E_PASSWORD.
//
//   node scripts/e2e/setup-user.mjs

import { createClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";
import { readFileSync, appendFileSync, existsSync } from "node:fs";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !service) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (source .env.local first).");
  process.exit(1);
}

const EMAIL = process.env.E2E_EMAIL || "clubhouse-e2e@playmatchday.com";
const PASSWORD = process.env.E2E_PASSWORD || randomBytes(18).toString("base64url");

const sb = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });

// find-or-create the auth user
async function findUser(email) {
  // admin.listUsers is paginated; scan for the email.
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const hit = data.users.find((u) => (u.email || "").toLowerCase() === email.toLowerCase());
    if (hit) return hit;
    if (data.users.length < 200) break;
  }
  return null;
}

let user = await findUser(EMAIL);
if (user) {
  // ensure password + confirmation are set so signInWithPassword works.
  const { data, error } = await sb.auth.admin.updateUserById(user.id, {
    password: PASSWORD,
    email_confirm: true,
  });
  if (error) throw error;
  user = data.user;
  console.log("auth user exists, password reset:", user.id);
} else {
  const { data, error } = await sb.auth.admin.createUser({
    email: EMAIL,
    password: PASSWORD,
    email_confirm: true,
  });
  if (error) throw error;
  user = data.user;
  console.log("auth user created:", user.id);
}

// minimum app_users row: read on every tab, no admin.
const row = {
  id: user.id,
  email: EMAIL,
  full_name: "Clubhouse E2E (read-only)",
  is_admin: false,
  can_access_home: true,
  can_access_finance: true,
  can_access_growth: true,
  can_access_membership: true,
  can_access_matchops: true,
  can_access_chats: true,
  can_access_tech: true,
  can_access_org: true,
};
const up = await sb.from("app_users").upsert(row, { onConflict: "email" }).select("id").maybeSingle();
if (up.error) throw up.error;
console.log("app_users row upserted (is_admin=false, all reads=true):", up.data?.id);

// persist creds to .env.local if not already present
const envPath = ".env.local";
const cur = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
const toAppend = [];
if (!/^E2E_EMAIL=/m.test(cur)) toAppend.push(`E2E_EMAIL=${EMAIL}`);
if (!/^E2E_PASSWORD=/m.test(cur)) toAppend.push(`E2E_PASSWORD=${PASSWORD}`);
if (toAppend.length) {
  appendFileSync(envPath, (cur.endsWith("\n") || cur === "" ? "" : "\n") + "\n# E2E automation identity (read-only)\n" + toAppend.join("\n") + "\n");
  console.log("appended to .env.local:", toAppend.map((l) => l.split("=")[0]).join(", "));
} else {
  console.log(".env.local already has E2E_EMAIL / E2E_PASSWORD");
}
console.log("\nDONE. Email:", EMAIL);
