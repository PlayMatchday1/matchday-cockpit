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
// Auth: is_admin, via the grantAccess capability (capabilityAuth).
// by UID. is_admin is intentionally NOT enough — adding users is a
// separate capability from holding admin permissions. Bearer pattern
// mirrors src/app/api/manager-pay/week/route.ts.
//
// Idempotency: re-running with the same email is safe. app_users
// upserts onConflict=email, and inviteUserByEmail's "already
// registered" error is caught and surfaced as a success with status
// "already-registered" — useful when a backfill or manual auth-panel
// add happened between the row write and the invite call.

import { authenticateCapability } from "@/lib/capabilityAuth";
import { createClient } from "@supabase/supabase-js";
import { mapAppUsersConstraint, cityManagerConstraintMessage } from "@/lib/appUsersConstraint";

import { resolveCityScope } from "@/lib/cityScope";
export const runtime = "nodejs";
export const maxDuration = 30;

// rmancuso@playmatchday.com. Verified by hand-querying auth.users
// against this exact UID before this route was wired up. If ownership
// ever transfers, rotate this constant; don't widen the check.

type PermissionFlags = {
  is_admin?: boolean;
  can_access_home?: boolean;
  can_access_finance?: boolean;
  can_access_lifecycle?: boolean;
  can_access_growth?: boolean;
  can_access_membership?: boolean;
  can_access_matchops?: boolean;
  can_access_chats?: boolean;
  can_access_tech?: boolean;
  // Phase 29 — the CITY MANAGER tier. is_city_manager is a boolean like the rest;
  // city_identifier is the only STRING in this allowlist and is validated against the
  // scope list rather than merely accepted (see pickPermissions).
  is_city_manager?: boolean;
  city_identifier?: string | null;
};

// Whitelist of accepted permission keys. Any other key in
// body.permissions is ignored — prevents arbitrary column writes if
// the modal ever drifts or a request is hand-crafted.
// Boolean keys only — city_identifier is the one string and is handled explicitly below.
type BoolPermissionKey = Exclude<keyof PermissionFlags, "city_identifier">;
const PERMISSION_KEYS: BoolPermissionKey[] = [
  "is_admin",
  "is_city_manager",
  "can_access_home",
  "can_access_finance",
  "can_access_lifecycle",
  "can_access_growth",
  "can_access_membership",
  "can_access_matchops",
  "can_access_chats",
  "can_access_tech",
];

// The allowlist stays an ALLOWLIST: city_identifier is named explicitly and validated, not a
// door held open for arbitrary columns. It is also the only key here that is not a boolean, which
// is why it is picked separately rather than by loosening the loop's type check.
function pickPermissions(input: unknown): PermissionFlags {
  if (!input || typeof input !== "object") return {};
  const src = input as Record<string, unknown>;
  const out: PermissionFlags = {};
  for (const k of PERMISSION_KEYS) {
    if (typeof src[k] === "boolean") (out as Record<string, boolean>)[k] = src[k] as boolean;
  }
  // CITY MANAGER and ADMIN are mutually exclusive — the city gate refuses admins, so an invite
  // carrying both would create an account that can use neither tier. Admin wins and the tier is
  // dropped, because the tier without a working page is the more misleading of the two.
  if (out.is_city_manager && out.is_admin) { out.is_city_manager = false; }
  if (out.is_city_manager) {
    // EXACT match against the known scopes. An unknown value is dropped along with the tier
    // rather than stored: a free-text city scopes the account to nothing and looks correct.
    const scope = resolveCityScope(src.city_identifier);
    if (!scope) { out.is_city_manager = false; }
    else out.city_identifier = scope.identifier;
  }
  // The tier off means no scope — mirrors the 0120 trigger rather than fighting it.
  if (!out.is_city_manager) out.city_identifier = null;
  return out;
}

export async function POST(req: Request) {
  // WHO MAY INVITE: is_admin, through the same capability every other gate now reads.
  //
  // This was a single hardcoded UID that refused even is_admin holders. Under the rule the User
  // access screen now follows — is_admin gates exactly one thing, which is who may grant
  // permissions — a lock narrower than is_admin makes the Admin checkbox mean less than it says.
  // This is a REAL widening: any admin can now create accounts, where before only one person could.
  const auth = await authenticateCapability(req, "grantAccess");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
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

  // THE COMBINATION THAT LEAKED, refused BEFORE the write (Phase 29b). pickPermissions already
  // makes City Manager and Admin exclusive; the broad access flags are the other half, and they
  // are what actually opened the estate. Refusing here means the invite never reaches the CHECK,
  // so the operator gets a sentence rather than a database error.
  if (perms.is_city_manager === true) {
    const broad = ["can_access_matchops", "can_access_home", "can_access_finance", "can_access_lifecycle",
      "can_access_growth", "can_access_membership", "can_access_chats", "can_access_tech",
      "can_access_org"] as const;
    const held = broad.filter((k) => (perms as unknown as Record<string, unknown>)[k] === true);
    if (held.length > 0) {
      return Response.json({
        error: cityManagerConstraintMessage(perms as unknown as Record<string, unknown>),
        conflict: "city-manager-exclusive", held, rowCreated: false,
      }, { status: 409 });
    }
  }

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
    // Migration 0124's CHECK would otherwise arrive here as a 500 with a raw Postgres string
    // naming the constraint. Inviting an EXISTING city manager is a real path (the upsert merges
    // on email), so it reads as a stated 409 instead — the same wording as the grant route.
    const mapped = mapAppUsersConstraint(upsertErr, perms as unknown as Record<string, unknown>);
    if (mapped) return Response.json({ error: mapped.error, conflict: mapped.conflict, rowCreated: false }, { status: mapped.status });
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
  // ── WHAT THIS ROUTE CAN AND CANNOT KNOW ───────────────────────────────────────────────────────
  // inviteUserByEmail returning without an error means Supabase ACCEPTED the request. It does NOT
  // mean an email was delivered — delivery happens downstream (SMTP relay, the recipient's spam
  // filter) and nothing here observes it. This used to return status "invited", the modal said
  // success, and a real invite silently never arrived. Same rule as every other write in this
  // codebase: a 2xx is not proof it landed.
  const acceptedAt = new Date().toISOString();
  const { data: invited, error: inviteErr } = await admin.auth.admin.inviteUserByEmail(
    email,
    { data: { full_name: fullName } },
  );

  if (inviteErr) {
    const msg = inviteErr.message ?? "";
    const lower = msg.toLowerCase();
    const alreadyExists = lower.includes("already") || lower.includes("registered") || lower.includes("exists");

    // ALREADY REGISTERED — the auth identity exists (a prior invite, a backfill, the Supabase
    // dashboard). The app_users row is now in sync, so the PERMISSIONS half succeeded. But NO
    // EMAIL WAS SENT, and reporting a bare success here is what hid the problem: nothing arrives
    // and the screen looks fine. Say it plainly and point at the recovery path.
    if (alreadyExists) {
      return Response.json({
        ok: true,
        status: "already-registered",
        email,
        rowCreated: true,
        emailSent: false,
        deliveryConfirmed: false,
        message: "The permissions row is saved, but NO invite email was sent — this address already has a sign-in identity. Use Re-send on their row to send a fresh sign-in link.",
      });
    }

    // RATE LIMITED — the one failure most likely to look like nothing happening. Named separately
    // so the modal can say "wait and retry" rather than "invite failed".
    const rateLimited = /rate limit|too many|429/i.test(msg) || (inviteErr as { status?: number }).status === 429;
    return Response.json({
      ok: false,
      status: rateLimited ? "rate-limited" : "invite-failed",
      email,
      rowCreated: true,      // step 1 already succeeded — say so, or it looks like nothing happened
      emailSent: false,
      deliveryConfirmed: false,
      error: rateLimited
        ? `The permissions row is saved, but the email was REFUSED: ${msg}. This is the auth email quota — wait and use Re-send on their row.`
        : `The permissions row is saved, but the invite email failed: ${msg}`,
    }, { status: rateLimited ? 429 : 502 });
  }

  return Response.json({
    ok: true,
    status: "invited",
    email,
    user_id: invited?.user?.id ?? null,
    rowCreated: true,
    // ACCEPTED, not delivered. The distinction is the whole point of this change.
    emailAccepted: true,
    acceptedAt,
    deliveryConfirmed: false,
    message: `Row created. Supabase accepted the invite at ${acceptedAt}. Delivery is NOT confirmed — the row shows Signed in once they actually arrive.`,
  });
}
