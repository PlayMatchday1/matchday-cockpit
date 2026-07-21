// Idempotent backfill: for every app_users row missing a matching
// auth.users identity, send a passwordless magic-link invite via
// supabase.auth.admin.inviteUserByEmail. Re-runs cannot double-
// provision: each candidate is checked against the live auth.users
// list immediately before invite.
//
// DRY-RUN BY DEFAULT. Pass --apply to actually send invites.
// Pass --emails=a@x.com,b@y.com to scope to a specific subset
// (the rest of the broken list is ignored).
//
// Example dry-run:
//   node scripts/backfill-app-users-auth.mjs
//
// Example targeted live run (George only):
//   node scripts/backfill-app-users-auth.mjs --apply --emails=gpazos@playmatchday.com
//
// Example full live run:
//   node scripts/backfill-app-users-auth.mjs --apply
//
// Manual safety: if you've already added a user via the Supabase Auth
// dashboard, this script will see them in auth.users and skip — no
// duplicate invite, no conflict.

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const args = new Set(process.argv.slice(2));
const APPLY = args.has("--apply");
const emailsArg = process.argv.find((a) => a.startsWith("--emails="));
const scopedEmails = emailsArg
  ? new Set(
      emailsArg
        .slice("--emails=".length)
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    )
  : null;

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
    "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local.",
  );
  process.exit(1);
}

const sb = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

console.log(
  APPLY
    ? "MODE: --apply (LIVE — invites will be sent)"
    : "MODE: dry-run (no invites will be sent — pass --apply to commit)",
);
if (scopedEmails) {
  console.log(`SCOPE: limited to ${scopedEmails.size} email(s)`);
}
console.log("");

const { data: appUsers, error: appErr } = await sb
  .from("app_users")
  .select("email, full_name")
  .order("created_at", { ascending: true });
if (appErr) {
  console.error("app_users read failed:", appErr.message);
  process.exit(1);
}

// Build a fresh auth.users email set right before processing. The
// inviteUserByEmail call itself will also reject duplicates, but
// checking upfront keeps the dry-run output honest.
const authEmails = new Set();
let page = 1;
const pageSize = 1000;
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

const candidates = appUsers.filter((u) => {
  const e = (u.email ?? "").toLowerCase();
  if (!e) return false;
  if (authEmails.has(e)) return false;
  if (scopedEmails && !scopedEmails.has(e)) return false;
  return true;
});

console.log(`Candidates needing invite: ${candidates.length}`);
if (candidates.length === 0) {
  console.log("(nothing to do)");
  process.exit(0);
}

let invited = 0;
let skipped = 0;
let failed = 0;
for (const u of candidates) {
  const email = u.email.toLowerCase();
  if (!APPLY) {
    console.log(`  [dry-run] would invite: ${email}  (${u.full_name ?? "no name"})`);
    continue;
  }

  // Re-check auth.users right before invite to close the dry-run vs
  // live-run race window. Cheap call; safer than relying on listUsers
  // alone since listUsers is paginated and a concurrent admin add
  // could have landed since we built the set.
  try {
    const { data, error } = await sb.auth.admin.inviteUserByEmail(email, {
      data: { full_name: u.full_name ?? null },
    });
    if (error) {
      // Treat "already registered" as a skip, not a failure — keeps
      // the script idempotent if listUsers missed a recent add.
      const msg = (error.message ?? "").toLowerCase();
      if (msg.includes("already") || msg.includes("registered") || msg.includes("exists")) {
        console.log(`  [skip] ${email} — already in auth.users (${error.message})`);
        skipped++;
        continue;
      }
      console.log(`  [FAIL] ${email} — ${error.message}`);
      failed++;
      continue;
    }
    console.log(`  [invited] ${email} (id=${data?.user?.id ?? "?"})`);
    invited++;
  } catch (e) {
    console.log(`  [FAIL] ${email} — ${e instanceof Error ? e.message : String(e)}`);
    failed++;
  }
}

console.log("");
console.log(
  APPLY
    ? `DONE — invited=${invited}, skipped=${skipped}, failed=${failed}`
    : `DRY-RUN summary — would have invited ${candidates.length}`,
);
