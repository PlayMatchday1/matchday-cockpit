// READ-ONLY: list every app_users row that has no matching auth.users
// identity. No writes, no invites, no auth creation. Output is sorted
// by created_at ascending so the oldest broken rows surface first.
//
// Why this exists: src/components/AddUserModal.tsx writes a permissions
// row but never provisions a Supabase auth identity. Every user added
// through the admin UI is therefore unable to log in (OTP returns
// "Signups not allowed for otp" because shouldCreateUser=false on the
// login page). This script enumerates the affected rows so we can
// eyeball which are real users to backfill vs stale/test rows to
// delete.
//
// Run:
//   node scripts/list-app-users-without-auth.mjs
//
// Requires SUPABASE_SERVICE_ROLE_KEY + NEXT_PUBLIC_SUPABASE_URL in
// .env.local. Production keys are Sensitive in Vercel, so they don't
// come down via `vercel env pull` — copy the service-role key out of
// the Supabase dashboard (Settings > API > service_role) into
// .env.local before running. Do NOT commit the populated .env.local.

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = readFileSync(
  "/Users/ryanmancuso/Code/matchday-cockpit/.env.local",
  "utf8",
);
function readEnv(name) {
  const m = env.match(new RegExp(`^${name}=(.*)$`, "m"));
  if (!m) return "";
  return m[1].trim().replace(/^"|"$/g, "");
}
const url = readEnv("NEXT_PUBLIC_SUPABASE_URL");
const serviceKey = readEnv("SUPABASE_SERVICE_ROLE_KEY");
if (!url || !serviceKey) {
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local. " +
      "Service-role key is Sensitive in Vercel — copy from Supabase dashboard.",
  );
  process.exit(1);
}

const sb = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Pull every app_users row. The table is small (admin-managed
// allowlist), so a single SELECT with no pagination is fine.
const { data: appUsers, error: appErr } = await sb
  .from("app_users")
  .select("*")
  .order("created_at", { ascending: true });
if (appErr) {
  console.error("app_users read failed:", appErr.message);
  process.exit(1);
}

// Walk auth.users with the admin paginated listing. Page size 1000 is
// the Supabase default cap. We collect into a Set of lowercased emails
// for O(1) membership checks.
const authEmails = new Set();
let page = 1;
let pageSize = 1000;
for (;;) {
  const { data, error } = await sb.auth.admin.listUsers({ page, perPage: pageSize });
  if (error) {
    console.error("auth.admin.listUsers failed:", error.message);
    process.exit(1);
  }
  for (const u of data.users) {
    if (u.email) authEmails.add(u.email.toLowerCase());
  }
  if (data.users.length < pageSize) break;
  page++;
}

// Identify permission columns dynamically by stripping the known
// non-permission columns. This survives future permission additions
// without needing to maintain a hardcoded list here.
const NON_PERM_COLS = new Set([
  "id",
  "email",
  "full_name",
  "created_at",
  "updated_at",
  "last_login_at",
  "invited_by",
  "invited_at",
]);
const permCols =
  appUsers.length > 0
    ? Object.keys(appUsers[0]).filter((c) => !NON_PERM_COLS.has(c))
    : [];

const broken = appUsers.filter(
  (u) => !authEmails.has((u.email ?? "").toLowerCase()),
);

console.log("\n=== app_users WITHOUT matching auth.users identity ===");
console.log(`total app_users: ${appUsers.length}`);
console.log(`total auth.users: ${authEmails.size}`);
console.log(`broken (no auth identity): ${broken.length}\n`);

if (broken.length === 0) {
  console.log("(none — every app_users row has a matching auth identity)");
  process.exit(0);
}

for (const u of broken) {
  const grantedPerms = permCols.filter((c) => u[c] === true);
  console.log(
    [
      `email:        ${u.email}`,
      `full_name:    ${u.full_name ?? "(null)"}`,
      `created_at:   ${u.created_at}`,
      `last_login:   ${u.last_login_at ?? "Never"}`,
      `permissions:  ${grantedPerms.length === 0 ? "(none)" : grantedPerms.join(", ")}`,
    ].join("\n"),
  );
  console.log("─".repeat(60));
}
