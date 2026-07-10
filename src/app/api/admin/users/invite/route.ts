// POST /api/admin/users/invite
//
// Single-shot user provisioning for the Admin > User access table:
// (a) upsert the app_users permissions row, then (b) create the
// Supabase auth identity via inviteUserByEmail so the new user
// receives a magic-link email. Both steps share the same lower-cased,
// trimmed email so the app_users row and the auth.users row stay
// joined by email.
//
// Pre-fix the AddUserModal only inserted into app_users. Auth identity
// was never provisioned, every added user got "Signups not allowed for
// otp" on first login, and the bug was silent because the insert
// succeeded. This route folds both writes into one server-side action
// so the modal can no longer drift apart.
//
// Auth: locked to the provisioning owner (rmancuso@playmatchday.com)
// by UID. is_admin is intentionally NOT enough — adding users is a
// separate capability from holding admin permissions. Bearer pattern
// mirrors src/app/api/manager-pay/week/route.ts.
//
// Idempotency: re-running with the same email is safe. app_users
// upserts onConflict=email, and inviteUserByEmail's "already
// registered" error is caught and surfaced as a success with status
// "already-registered" — useful when a backfill or manual auth-panel
// add happened between the row write and the invite call.

import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const maxDuration = 30;

// rmancuso@playmatchday.com. Verified by hand-querying auth.users
// against this exact UID before this route was wired up. If ownership
// ever transfers, rotate this constant; don't widen the check.
const PROVISIONING_OWNER_UID = "a211fbb6-d1a0-4a8a-bf2d-81a26d7c169e";

// Returns true only when the bearer-token's resolved Supabase UID
// equals PROVISIONING_OWNER_UID. Any other authenticated user — even
// is_admin holders — gets a false. The session-validation pattern
// matches manager-pay/week/route.ts's checkAdmin: build a per-request
// client with the publishable key and the caller's bearer, then call
// auth.getUser(token).
async function isProvisioningOwner(req: Request): Promise<boolean> {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return false;
  const token = auth.slice("Bearer ".length).trim();
  if (!token) return false;

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!supabaseUrl || !supabaseKey) return false;

  const sessionClient = createClient(supabaseUrl, supabaseKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await sessionClient.auth.getUser(token);
  if (error || !data?.user) return false;
  return data.user.id === PROVISIONING_OWNER_UID;
}

type PermissionFlags = {
  is_admin?: boolean;
  can_access_chats?: boolean;
  can_access_clubhouse?: boolean;
  can_access_cities?: boolean;
  can_access_data?: boolean;
  can_access_docs?: boolean;
  can_access_finance?: boolean;
};

// Whitelist of accepted permission keys. Any other key in
// body.permissions is ignored — prevents arbitrary column writes if
// the modal ever drifts or a request is hand-crafted.
const PERMISSION_KEYS: (keyof PermissionFlags)[] = [
  "is_admin",
  "can_access_chats",
  "can_access_clubhouse",
  "can_access_cities",
  "can_access_data",
  "can_access_docs",
  "can_access_finance",
];

function pickPermissions(input: unknown): PermissionFlags {
  if (!input || typeof input !== "object") return {};
  const src = input as Record<string, unknown>;
  const out: PermissionFlags = {};
  for (const k of PERMISSION_KEYS) {
    if (typeof src[k] === "boolean") out[k] = src[k] as boolean;
  }
  return out;
}

export async function POST(req: Request) {
  if (!(await isProvisioningOwner(req))) {
    return Response.json(
      { error: "Not authorized to provision users." },
      { status: 401 },
    );
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return Response.json(
      { error: "Supabase env not configured" },
      { status: 500 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const src = (body ?? {}) as Record<string, unknown>;

  const rawEmail = typeof src.email === "string" ? src.email : "";
  const email = rawEmail.trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return Response.json({ error: "Valid email required" }, { status: 400 });
  }

  const rawFullName = typeof src.full_name === "string" ? src.full_name : "";
  const fullName = rawFullName.trim() || null;

  const perms = pickPermissions(src.permissions);

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Step 1: upsert the permissions row. Idempotent on email so a
  // re-run after a partial failure (e.g. invite send hits a transient
  // SMTP issue) still finishes the row state cleanly.
  const { error: upsertErr } = await admin
    .from("app_users")
    .upsert(
      { email, full_name: fullName, ...perms },
      { onConflict: "email" },
    );
  if (upsertErr) {
    return Response.json(
      { error: `app_users upsert failed: ${upsertErr.message}` },
      { status: 500 },
    );
  }

  // Step 2: send the magic-link invite. The app is OTP-only, so we
  // never set a password — inviteUserByEmail creates an auth user and
  // emails them a one-click confirmation link that lands on the
  // configured Site URL. After confirmation they can request OTP
  // codes via the normal /login flow.
  const { data: invited, error: inviteErr } = await admin.auth.admin.inviteUserByEmail(
    email,
    { data: { full_name: fullName } },
  );
  if (inviteErr) {
    // "Already registered" means the auth identity was created out-
    // of-band (Supabase Auth dashboard, a prior invite, a backfill).
    // The app_users row is now in sync, so report success rather than
    // failing the whole call.
    const msg = (inviteErr.message ?? "").toLowerCase();
    const alreadyExists =
      msg.includes("already") ||
      msg.includes("registered") ||
      msg.includes("exists");
    if (alreadyExists) {
      return Response.json({ ok: true, status: "already-registered", email });
    }
    return Response.json(
      { error: `invite failed: ${inviteErr.message}` },
      { status: 500 },
    );
  }

  return Response.json({
    ok: true,
    status: "invited",
    email,
    user_id: invited?.user?.id ?? null,
  });
}
