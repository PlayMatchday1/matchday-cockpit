// Guarded de-duplication for a doubled app_users account.
//
// Deletes BOTH the app_users row and the matching auth.users identity
// for a duplicate account — but only after a wall of safety checks, and
// only when passed --execute. Dry-run by default.
//
// Context: two "Deonna Garcia" accounts were created 2026-07-22
// (ggarcia@ and dgarcia@), both non-admin, both can_access_chats=true,
// both never signed in (last_login_at = null). Exactly one is canonical;
// the other must go so the assign dropdown doesn't list two identical
// operators. Which one is canonical is a human call (whichever email she
// actually logs in as) — this script refuses to guess.
//
// Usage (dry-run — prints what it WOULD do, changes nothing):
//   node scripts/dedup-app-user.mjs --keep dgarcia@playmatchday.com --delete ggarcia@playmatchday.com
//
// Execute (after she confirms which email she logs in as):
//   node scripts/dedup-app-user.mjs --keep <email> --delete <email> --execute
//
// Safety guards (any failure aborts before touching anything):
//   1. Both emails must resolve to exactly one app_users row.
//   2. They must share the same full_name (guards against fat-fingering
//      an unrelated account into --delete).
//   3. The --delete target must be is_admin = false.
//   4. The --delete target must have last_login_at = null. If the "spare"
//      has actually been signed into, this is no longer an obvious dup —
//      stop and let a human look.
//   5. --keep must exist and be a distinct row from --delete.

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = readFileSync(
  "/Users/ryanmancuso/Code/matchday-cockpit/.env.local",
  "utf8",
);
const rd = (n) => {
  const m = env.match(new RegExp(`^${n}=(.+)$`, "m"));
  return m ? m[1].trim().replace(/^['"]|['"]$/g, "") : null;
};

const args = process.argv.slice(2);
const getArg = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};
const keepEmail = (getArg("--keep") || "").toLowerCase().trim();
const deleteEmail = (getArg("--delete") || "").toLowerCase().trim();
const execute = args.includes("--execute");

if (!keepEmail || !deleteEmail) {
  console.error(
    "Usage: node scripts/dedup-app-user.mjs --keep <email> --delete <email> [--execute]",
  );
  process.exit(2);
}
if (keepEmail === deleteEmail) {
  console.error("ABORT: --keep and --delete are the same email.");
  process.exit(2);
}

const sb = createClient(
  rd("NEXT_PUBLIC_SUPABASE_URL"),
  rd("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false } },
);

const cols =
  "id, email, full_name, is_admin, can_access_chats, last_login_at, created_at";
const keep = (
  await sb.from("app_users").select(cols).ilike("email", keepEmail).maybeSingle()
).data;
const del = (
  await sb.from("app_users").select(cols).ilike("email", deleteEmail).maybeSingle()
).data;

function show(label, u) {
  if (!u) return console.log(`  ${label}: (not found)`);
  console.log(
    `  ${label}: ${u.email} | admin=${u.is_admin} chats=${u.can_access_chats} last_login=${u.last_login_at ?? "null"} id=${u.id}`,
  );
}
console.log("Resolved accounts:");
show("KEEP  ", keep);
show("DELETE", del);
console.log();

const fail = (m) => {
  console.error("ABORT:", m);
  process.exit(1);
};
if (!keep) fail(`--keep ${keepEmail} not found in app_users.`);
if (!del) fail(`--delete ${deleteEmail} not found in app_users.`);
if (keep.id === del.id) fail("--keep and --delete resolved to the same row.");
if ((keep.full_name ?? "") !== (del.full_name ?? ""))
  fail(
    `full_name mismatch (keep="${keep.full_name}" delete="${del.full_name}") — not an obvious duplicate. Stopping.`,
  );
if (del.is_admin === true)
  fail("--delete target is is_admin=true. Refusing to delete an admin.");
if (del.last_login_at != null)
  fail(
    `--delete target has last_login_at=${del.last_login_at} — it has actually been used. Not an obvious dup; review by hand.`,
  );

// Find the matching auth.users identity for the delete target.
let authId = null;
for (let page = 1; page <= 20; page++) {
  const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 200 });
  if (error) fail(`auth.admin.listUsers failed: ${error.message}`);
  const hit = data.users.find(
    (u) => (u.email ?? "").toLowerCase() === deleteEmail,
  );
  if (hit) {
    authId = hit.id;
    break;
  }
  if (data.users.length < 200) break;
}
console.log(
  `auth.users identity for ${deleteEmail}: ${authId ?? "(none found)"}`,
);
console.log();

if (!execute) {
  console.log("DRY RUN — nothing changed. Would delete, in order:");
  console.log(`  1. app_users row      id=${del.id}`);
  console.log(
    `  2. auth.users identity id=${authId ?? "(none — skip)"}`,
  );
  console.log("\nRe-run with --execute to apply.");
  process.exit(0);
}

// Execute: app_users row first (so a partial failure leaves an orphan
// auth identity, which list-app-users-without-auth.mjs surfaces — the
// recoverable direction), then the auth identity.
const rowDel = await sb.from("app_users").delete().eq("id", del.id);
if (rowDel.error) fail(`app_users delete failed: ${rowDel.error.message}`);
console.log(`Deleted app_users row ${del.id}.`);

if (authId) {
  const { error } = await sb.auth.admin.deleteUser(authId);
  if (error)
    fail(
      `app_users row deleted but auth identity delete failed: ${error.message}. Delete auth user ${authId} by hand.`,
    );
  console.log(`Deleted auth.users identity ${authId}.`);
}
console.log(`\nDone. Canonical account kept: ${keep.email} (${keep.id}).`);
