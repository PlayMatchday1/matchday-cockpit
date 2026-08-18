// SET ONE PERMISSION FLAG (or the display name) ON ONE ACCOUNT — server-side, admin-gated,
// logged, verdict by re-read.
//
// WHAT THIS REPLACES. AdminUsersView toggled straight from the browser:
//
//     setUsers((prev) => prev.map(u => u.id === user.id ? { ...u, [key]: newValue } : u)); // optimistic
//     const { error } = await supabase.from("app_users").update({ [key]: newValue }).eq("id", user.id);
//     if (error) { setUsers(original); alert(error.message); }
//
// RLS on app_users grants SELECT to authenticated callers and nothing else, so that UPDATE matched
// ZERO rows and returned no error — measured: `.update().select()` → []. The code checked only
// `error`, the rollback could never fire, and the switch had already moved. Reload and it was back.
// NOT ONE broad-flag change appears in change_log in the table's entire history, which is what a
// control that has never once written looks like.
//
// WHY NOBODY NOTICED: is_admin SHORT-CIRCUITS the page flags. canAccess() returns true for an admin
// before it reads any can_access_* column, and authenticateMatchOpsRead / growthAuth / crmAuth are
// all `is_admin OR the flag`. The people using this screen are admins, so toggling their own
// can_access_* changed nothing observable in either direction.
//
// THE REVOKE DIRECTION IS WHY THIS MATTERS. A grant that silently fails leaves someone with less
// access than intended, which is safe. A revoke that silently fails leaves them with MORE, and the
// screen looked identical either way.
//
// THE WRITE GRANTS ARE NOT DECORATIVE, even for an admin: can_send_messages, can_edit_credits,
// can_manage_promos and can_edit_matches are each read independently of is_admin. A failed revoke
// on one of those left a real capability in place.
import { randomUUID } from "node:crypto";
import { authenticateAdmin } from "@/lib/adminAuth";
import { recordWrite, supabaseLogStore } from "@/lib/changeLog";
import type { Change } from "@/lib/changeLogModel";
import { mapAppUsersConstraint } from "@/lib/appUsersConstraint";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// AN ALLOWLIST, NOT THE REQUEST'S WORD FOR IT. `key` becomes a column name in an UPDATE; accepting
// whatever arrives would let a caller write any column on app_users — including is_service_account
// or city_identifier — through a route that only claims to flip permissions.
const BOOLEAN_KEYS = [
  "is_admin",
  "can_access_home", "can_access_finance", "can_access_growth", "can_access_membership",
  "can_access_matchops", "can_access_chats", "can_access_tech", "can_access_org",
  "can_manage_promos", "can_edit_matches", "can_edit_credits", "can_send_messages",
] as const;
const TEXT_KEYS = ["full_name"] as const;

const LABEL: Record<string, string> = {
  is_admin: "Admin",
  can_access_home: "Home", can_access_finance: "Finance", can_access_growth: "Player Lifecycle",
  can_access_membership: "Membership", can_access_matchops: "Match Ops", can_access_chats: "Chats",
  can_access_tech: "Tech", can_access_org: "Org",
  can_manage_promos: "Manage promos", can_edit_matches: "Edit matches",
  can_edit_credits: "Edit credits", can_send_messages: "Send messages",
  full_name: "Name",
};

export async function POST(req: Request) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const supabase = auth.supabase;

  const body = (await req.json().catch(() => null)) as { id?: unknown; key?: unknown; value?: unknown } | null;
  const id = typeof body?.id === "string" ? body.id : "";
  const key = typeof body?.key === "string" ? body.key : "";
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });

  const isBool = (BOOLEAN_KEYS as readonly string[]).includes(key);
  const isText = (TEXT_KEYS as readonly string[]).includes(key);
  if (!isBool && !isText) {
    return Response.json({ error: `\`${key}\` is not a permission this route may set.` }, { status: 400 });
  }
  if (isBool && typeof body?.value !== "boolean") {
    return Response.json({ error: `${key} must be true or false` }, { status: 400 });
  }
  const value: boolean | string | null = isBool
    ? (body!.value as boolean)
    : (typeof body?.value === "string" && body.value.trim() ? body.value.trim() : null);

  const { data: target } = await supabase
    .from("app_users").select("id, email, is_admin").eq("id", id).maybeSingle();
  if (!target) return Response.json({ error: "No such user", outcome: "NOT APPLIED" }, { status: 404 });
  const email = String(target.email ?? "");

  // YOU CANNOT REMOVE YOUR OWN ADMIN. The client greys it, but a hand-made request must not be able
  // to lock the last admin out of the screen that grants admin — the same reason self-delete is
  // refused on the delete route.
  if (key === "is_admin" && value === false && email.toLowerCase() === auth.email.toLowerCase()) {
    return Response.json({ error: "You cannot remove your own admin access.", outcome: "NOT APPLIED" }, { status: 400 });
  }

  const readRow = async (): Promise<Record<string, unknown>> => {
    const { data } = await supabase.from("app_users").select(`id, ${key}`).eq("id", id).maybeSingle();
    return { [key]: (data as Record<string, unknown> | null)?.[key] ?? null };
  };
  const before = await readRow();

  // NOT APPLIED, STATED — not a silent success. Writing a value that is already set would produce a
  // change_log entry claiming a change nobody made.
  if (before[key] === value) {
    return Response.json({ ok: true, outcome: "NOT APPLIED", reason: "already set", key, value });
  }

  let constraintErr: { error: string; conflict: string; status: number } | null = null;

  const changes: Change[] = [
    { key, field: `${email} · ${LABEL[key] ?? key}`, before: String(before[key] ?? "—"), after: String(value ?? "—") },
  ];

  const { error: writeErr, outcome } = await recordWrite(
    {
      env: "production", source: "User admin · permissions",
      actorName: auth.email, actorEmail: auth.email, saveId: randomUUID(),
      matchId: null, matchName: null,
      method: "PATCH", path: `/admin/users/${id}/permissions`,
      // EMAIL ONLY, plus which flag moved. No name, no phone, no other columns.
      body: { email, key, value },
      keys: [key],
      label: (k) => LABEL[k] ?? k,
      // THE VERDICT IS A RE-READ. `error: null` is exactly what hid this for the table's whole
      // history, so it is not what decides the outcome here.
      applied: (_b, a) => a[key] === value,
      changes,
    },
    {
      readResource: readRow,
      write: async () => {
        // ONE ATTEMPT. `.select()` is what turns a zero-row UPDATE into an observable failure —
        // its absence is the entire bug being fixed.
        const { data, error } = await supabase
          .from("app_users").update({ [key]: value }).eq("id", id).select("id");
        if (error) {
          // MIGRATION 0124 STILL BINDS. Granting a broad flag to a city manager violates
          // app_users_city_manager_is_exclusive; that must surface as a stated 409, never as a
          // silent no-op — which is the failure mode this whole route exists to end.
          const mapped = mapAppUsersConstraint(error, { [key]: value });
          if (mapped) { constraintErr = mapped; throw new Error(mapped.error); }
          throw new Error(error.message);
        }
        if (!data || data.length === 0) {
          throw new Error("The update matched no rows — nothing was changed.");
        }
        return true;
      },
      now: () => new Date().toISOString(),
    },
    supabaseLogStore(),
  );

  const after = await readRow();
  const OUT: Record<string, string> = { landed: "LANDED", failed: "FAILED", "not applied": "NOT APPLIED", unknown: "UNKNOWN" };
  const reported = OUT[outcome] ?? "UNKNOWN";

  if (constraintErr) {
    const c = constraintErr as { error: string; conflict: string };
    return Response.json({ ok: false, outcome: "FAILED", conflict: c.conflict, error: c.error }, { status: 409 });
  }
  if (after[key] !== value) {
    return Response.json({
      ok: false, outcome: reported,
      error: writeErr?.message ?? "The change was not applied.",
      key, value: after[key],
    }, { status: 502 });
  }
  return Response.json({ ok: true, outcome: reported, key, value: after[key] });
}
