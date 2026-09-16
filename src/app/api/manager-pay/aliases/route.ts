// Manager → Gusto name aliases for the payroll CSV. Optional, one row per
// manager, keyed by lower(manager_email).
//
//   GET    → { aliases: { [lowerEmail]: { firstName, lastName, email, note } } }
//   PUT    { managerEmail, firstName, lastName, email?, note? } → upsert one
//   DELETE ?email=... → remove one (clear the alias)
//
// ══ THE GATE IS MATCH OPS, AND THAT IS DELIBERATE ════════════════════════════════════════════
// This header used to read "Admin-only on app_users.is_admin (authenticateAdmin)". That has been
// false for some time — every method here gates on authenticateCapability(req, "matchops") — and it
// was false about MONEY, which is the worst thing for a stale comment to be false about.
//
// Ryan's call, 2026-09-15: anyone with Match Ops. THIS ROUTE DECIDES WHO A PAYROLL ROW PAYS. The
// Gusto CSV matches on First + Last, so the mapping written here is the difference between a row
// that pays a person and a row that looks identical on the sheet and pays nobody. That is not a
// reason to keep it admin-only — the people doing the work are the people who know the names — but
// it IS the reason every write here goes through recordWrite, which they did not until today.
//
// Writes go through the service role; the table's RLS only grants authenticated SELECT (mirrors
// manager_pay_adjustments). Nothing here touches a synced mdapi_* table.

import { randomUUID } from "node:crypto";
import { authenticateCapability } from "@/lib/capabilityAuth";
import { recordWrite, supabaseLogStore } from "@/lib/changeLog";

export const runtime = "nodejs";
export const maxDuration = 10;

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TABLE = "manager_gusto_aliases";

export async function GET(req: Request) {
  const auth = await authenticateCapability(req, "matchops");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const { data, error } = await auth.supabase
    .from(TABLE)
    // select("*") NOT a column list: code deploys before migrations apply, and naming
    // gusto_email before 0127 has run would 500 this read for everyone. A missing column then
    // reads as undefined and the alias simply carries no email override.
    .select("*");
  if (error) {
    return Response.json({ error: `alias read failed: ${error.message}` }, { status: 500 });
  }
  const aliases: Record<string, { firstName: string; lastName: string; email: string | null; note: string | null }> = {};
  for (const r of (data ?? []) as {
    manager_email: string;
    gusto_first_name: string;
    gusto_last_name: string;
    gusto_email?: string | null;
    note: string | null;
  }[]) {
    // Key on lower(email) — the same key the pay compute accumulates on.
    aliases[r.manager_email.toLowerCase()] = {
      firstName: r.gusto_first_name,
      lastName: r.gusto_last_name,
      // Absent column (pre-0127) and an unset override are the same thing here: no override.
      email: r.gusto_email ?? null,
      note: r.note,
    };
  }
  return Response.json({ aliases });
}

type PutBody = {
  managerEmail?: unknown;
  firstName?: unknown;
  lastName?: unknown;
  email?: unknown;
  note?: unknown;
};

export async function PUT(req: Request) {
  const auth = await authenticateCapability(req, "matchops");
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
  // CLEARING IS A REAL ACTION. An empty box means "go back to the schedule email", which is NULL —
  // not an empty string. Writing "" would put a blank Email column in a file that pays people.
  const gustoEmail =
    typeof body.email === "string" && body.email.trim() !== "" ? body.email.trim().toLowerCase() : null;

  if (!EMAIL_RX.test(managerEmail)) {
    return Response.json({ error: "Invalid managerEmail" }, { status: 400 });
  }
  if (!firstName || !lastName) {
    return Response.json(
      { error: "Both first and last name are required (that's the point — no empty last names)." },
      { status: 400 },
    );
  }
  // A malformed override would silently pay nobody, so it is refused here rather than written.
  // Blank is NOT malformed — it is how the override is removed.
  if (gustoEmail !== null && !EMAIL_RX.test(gustoEmail)) {
    return Response.json({ error: "The Gusto email is not a valid address. Leave it blank to use the schedule email." }, { status: 400 });
  }

  const sb = auth.supabase;
  /* THE BEFORE IS READ, NOT ASSUMED. An alias change REDIRECTS A PAYROLL ROW from one Gusto worker
   * to another, so "what did it used to say" is the whole value of the log entry. Logging a dash
   * where a real mapping stood would make every edit look like a first-time setup. */
  const readRow = async (): Promise<Record<string, unknown>> => {
    const r = await sb.from(TABLE).select("*").eq("manager_email", managerEmail).maybeSingle();
    return { row: r.data ?? null };
  };
  const prior = ((await readRow()).row ?? null) as Record<string, unknown> | null;
  const priorName = prior ? `${prior.gusto_first_name ?? ""} ${prior.gusto_last_name ?? ""}`.trim() : null;

  const { outcome, error: writeErr, logged } = await recordWrite(
    {
      env: "production", source: "Manager Pay — Gusto alias", actorName: auth.email, actorEmail: auth.email,
      saveId: randomUUID(), matchId: null, matchName: null,
      method: "PUT", path: `/manager-pay/aliases/${managerEmail}`,
      body: { managerEmail, firstName, lastName, email: gustoEmail, note },
      keys: [], label: (k) => k,
      /* THE VERDICT IS THE READ-BACK. A 2xx from the upsert is not evidence the row says what was
       * asked for, and this row decides who gets paid. */
      applied: (_b, a) => {
        const row = (a.row ?? null) as Record<string, unknown> | null;
        return !!row && row.gusto_first_name === firstName && row.gusto_last_name === lastName;
      },
      changes: [
        { key: "gusto_name", field: "Gusto name", before: priorName || "—", after: `${firstName} ${lastName}` },
        { key: "gusto_email", field: "Gusto email", before: (prior?.gusto_email as string | null) ?? "—", after: gustoEmail ?? "—" },
        { key: "note", field: "Note", before: (prior?.note as string | null) ?? "—", after: note ?? "—" },
      ],
    },
    {
      readResource: readRow,
      write: async () => {
        const { error } = await sb.from(TABLE).upsert(
          {
            manager_email: managerEmail,
            gusto_first_name: firstName,
            gusto_last_name: lastName,
            gusto_email: gustoEmail,
            note,
            updated_at: new Date().toISOString(),
            updated_by: auth.appUserId,
          },
          { onConflict: "manager_email" },
        );
        if (error) throw Object.assign(new Error(error.message), { name: "WriteFailedError", code: error.code });
        return { ok: true };
      },
      now: () => new Date().toISOString(),
    },
    supabaseLogStore(),
  );

  if (writeErr) {
    const code = (writeErr as { code?: string }).code;
    // 23505 = the unique index on (lower(btrim(first)), lower(btrim(last))) from migration 0083 —
    // another manager already maps to this Gusto worker. Surface it as a conflict.
    if (code === "23505") {
      return Response.json(
        { error: `Another manager is already mapped to "${firstName} ${lastName}". Two managers cannot share a Gusto worker.` },
        { status: 409 },
      );
    }
    if (code === "23514") {
      return Response.json({ error: `Rejected by a constraint: ${writeErr.message}` }, { status: 400 });
    }
    return Response.json({ error: `alias upsert failed: ${writeErr.message}` }, { status: 500 });
  }
  if (outcome !== "landed") {
    return Response.json({ error: "The mapping reported success but read back different. Nothing was retried.", outcome }, { status: 409 });
  }

  return Response.json({ saved: { managerEmail, firstName, lastName, email: gustoEmail, note }, outcome, logRecorded: logged });
}

export async function DELETE(req: Request) {
  const auth = await authenticateCapability(req, "matchops");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const email = (new URL(req.url).searchParams.get("email") ?? "").trim().toLowerCase();
  if (!EMAIL_RX.test(email)) {
    return Response.json({ error: "Invalid email" }, { status: 400 });
  }
  const sb = auth.supabase;
  const readRow = async (): Promise<Record<string, unknown>> => {
    const r = await sb.from(TABLE).select("*").eq("manager_email", email).maybeSingle();
    return { row: r.data ?? null };
  };
  const prior = ((await readRow()).row ?? null) as Record<string, unknown> | null;
  /* CLEARING AN ALIAS IS A MONEY CHANGE TOO. The CSV falls back to the schedule name, which may or
   * may not be what Gusto holds — so a DELETE is logged with exactly the same weight as a PUT, and
   * the BEFORE is the only record of what the mapping used to be. */
  const priorName = prior ? `${prior.gusto_first_name ?? ""} ${prior.gusto_last_name ?? ""}`.trim() : null;

  const { outcome, error: writeErr, logged } = await recordWrite(
    {
      env: "production", source: "Manager Pay — Gusto alias", actorName: auth.email, actorEmail: auth.email,
      saveId: randomUUID(), matchId: null, matchName: null,
      method: "DELETE", path: `/manager-pay/aliases/${email}`,
      body: { managerEmail: email },
      keys: [], label: (k) => k,
      applied: (_b, a) => (a.row ?? null) === null,
      changes: [
        { key: "gusto_name", field: "Gusto name", before: priorName || "—", after: "— (cleared, falls back to the schedule name)" },
        { key: "gusto_email", field: "Gusto email", before: (prior?.gusto_email as string | null) ?? "—", after: "—" },
      ],
    },
    {
      readResource: readRow,
      write: async () => {
        const { error } = await sb.from(TABLE).delete().eq("manager_email", email);
        if (error) throw Object.assign(new Error(error.message), { name: "WriteFailedError" });
        return { ok: true };
      },
      now: () => new Date().toISOString(),
    },
    supabaseLogStore(),
  );

  if (writeErr) return Response.json({ error: `alias delete failed: ${writeErr.message}` }, { status: 500 });
  return Response.json({ deleted: true, email, outcome, logRecorded: logged });
}
