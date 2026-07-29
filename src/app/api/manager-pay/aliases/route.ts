// Manager → Gusto name aliases for the payroll CSV. Optional, one row per
// manager, keyed by lower(manager_email).
//
//   GET    → { aliases: { [lowerEmail]: { firstName, lastName, note } } }
//   PUT    { managerEmail, firstName, lastName, note? } → upsert one
//   DELETE ?email=... → remove one (clear the alias)
//
// Admin-only on app_users.is_admin (authenticateAdmin) — this decides who a
// payroll row pays. Writes go through the service role; the table's RLS only
// grants authenticated SELECT (mirrors manager_pay_adjustments). Nothing here
// touches a synced mdapi_* table.

import { authenticateAdmin } from "@/lib/adminAuth";

export const runtime = "nodejs";
export const maxDuration = 10;

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TABLE = "manager_gusto_aliases";

export async function GET(req: Request) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const { data, error } = await auth.supabase
    .from(TABLE)
    .select("manager_email, gusto_first_name, gusto_last_name, note");
  if (error) {
    return Response.json({ error: `alias read failed: ${error.message}` }, { status: 500 });
  }
  const aliases: Record<string, { firstName: string; lastName: string; note: string | null }> = {};
  for (const r of (data ?? []) as {
    manager_email: string;
    gusto_first_name: string;
    gusto_last_name: string;
    note: string | null;
  }[]) {
    // Key on lower(email) — the same key the pay compute accumulates on.
    aliases[r.manager_email.toLowerCase()] = {
      firstName: r.gusto_first_name,
      lastName: r.gusto_last_name,
      note: r.note,
    };
  }
  return Response.json({ aliases });
}

type PutBody = {
  managerEmail?: unknown;
  firstName?: unknown;
  lastName?: unknown;
  note?: unknown;
};

export async function PUT(req: Request) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  let body: PutBody;
  try {
    body = (await req.json()) as PutBody;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Normalize the key to lowercase so it can never fail to match a match row
  // (the CHECK(manager_email = lower(manager_email)) enforces this at the DB
  // too — belt and suspenders).
  const managerEmail =
    typeof body.managerEmail === "string" ? body.managerEmail.trim().toLowerCase() : "";
  const firstName = typeof body.firstName === "string" ? body.firstName.trim() : "";
  const lastName = typeof body.lastName === "string" ? body.lastName.trim() : "";
  const note =
    typeof body.note === "string" && body.note.trim() !== "" ? body.note.trim() : null;

  if (!EMAIL_RX.test(managerEmail)) {
    return Response.json({ error: "Invalid managerEmail" }, { status: 400 });
  }
  if (!firstName || !lastName) {
    return Response.json(
      { error: "Both first and last name are required (that's the point — no empty last names)." },
      { status: 400 },
    );
  }

  const { error } = await auth.supabase.from(TABLE).upsert(
    {
      manager_email: managerEmail,
      gusto_first_name: firstName,
      gusto_last_name: lastName,
      note,
      updated_at: new Date().toISOString(),
      updated_by: auth.appUserId,
    },
    { onConflict: "manager_email" },
  );
  if (error) {
    // 23505 = the unique index on (lower(first), lower(last)) — another
    // manager already maps to this Gusto worker. Surface it as a conflict.
    if (error.code === "23505") {
      return Response.json(
        { error: `Another manager is already mapped to "${firstName} ${lastName}". Two managers can't share a Gusto worker.` },
        { status: 409 },
      );
    }
    if (error.code === "23514") {
      return Response.json({ error: `Rejected by a constraint: ${error.message}` }, { status: 400 });
    }
    return Response.json({ error: `alias upsert failed: ${error.message}` }, { status: 500 });
  }

  return Response.json({ saved: { managerEmail, firstName, lastName, note } });
}

export async function DELETE(req: Request) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const email = (new URL(req.url).searchParams.get("email") ?? "").trim().toLowerCase();
  if (!EMAIL_RX.test(email)) {
    return Response.json({ error: "Invalid email" }, { status: 400 });
  }
  const { error } = await auth.supabase.from(TABLE).delete().eq("manager_email", email);
  if (error) {
    return Response.json({ error: `alias delete failed: ${error.message}` }, { status: 500 });
  }
  return Response.json({ deleted: true, email });
}
