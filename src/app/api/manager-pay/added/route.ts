/* POST / DELETE /api/manager-pay/added — pay someone who is NOT on the schedule that week.
 *
 * THIS WRITES CLUBHOUSE'S OWN STORE, NOT THE MATCHDAY API. There is no host guard and no
 * endpoint deny-list to satisfy, because no request leaves for playmatchday.herokuapp.com. What
 * does apply is everything about money: it is real payroll, it reaches Gusto, and a wrong row
 * pays a person who should not be paid or pays them twice.
 *
 * ── IT IS AN ADJUSTMENT ROW, NOT A NEW KIND OF THING ──────────────────────────────────────────
 * manager_pay_adjustments already held identity (manager_email), scope (week_start), the money
 * (amount) and the reason (notes), and its UNIQUE (manager_email, week_start) is already the
 * duplicate guard. The one thing missing was PLACEMENT: managerPayCompute derives a row's city
 * from the dominant city of its MATCHES, and a person with none has no city. Migration 0156 adds
 * city_identifier for exactly that, and its presence is also what marks a row as manually added.
 *
 * ── FOUR REFUSALS, ALL BEFORE THE WRITE ───────────────────────────────────────────────────────
 *   no Gusto mapping    a name split off a string does not pay, and looks identical to one that
 *                       does. Refused with the person named.
 *   already has a row   two rows for one person in one week is a double-pay in Gusto.
 *   no reason           money with no match behind it, unexplained, is unauditable in three weeks.
 *   the run has gone    see THE LOCK below.
 *
 * ── THE LOCK, AND WHAT IT IS ACTUALLY CALLED ──────────────────────────────────────────────────
 * THERE IS NO "completed" OR "locked" STATE IN THIS CODEBASE. I looked: no pay-run status table,
 * no column, no flag. `payRun` on the payload is a DERIVED DATE from bankingDays.payRunDate() —
 * the Tuesday after the week's Sunday, moved forward if that Tuesday is a Fed holiday. It says
 * when the run is submitted, not whether it was.
 *
 * So the lock here is that DERIVED DATE, and nothing else: once today is past the pay-run date,
 * the file has gone to Gusto and an edit changes a number nobody will ever act on — or worse,
 * gets picked up by a re-export and pays twice. Both add and delete refuse from that date onward.
 * It is honest, it needs no new state, and it is stated in the refusal so the operator knows
 * which rule stopped them. A real completed/locked flag would be better and is not built.
 */

import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { authenticateCapability } from "@/lib/capabilityAuth";
import { recordWrite, supabaseLogStore } from "@/lib/changeLog";
import { payRunDate } from "@/lib/bankingDays";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;

const ISO_DATE_RX = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TABLE = "manager_pay_adjustments";

const service = () =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!.trim(), process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });

/** weekStart is a MONDAY; payRunDate takes the week's SUNDAY. Six days on, as text — these are
 *  plain calendar dates and a Date here would re-shift them by the server's offset. */
export function weekSundayFromMonday(monday: string): string {
  const d = new Date(`${monday}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 6);
  return d.toISOString().slice(0, 10);
}

/** THE LOCK. True once the pay run for this week has been submitted. `todayYmd` is injected so
 *  the suite can assert both sides without waiting a week. */
export function payRunHasGone(weekStartMonday: string, todayYmd: string): boolean {
  return todayYmd > payRunDate(weekSundayFromMonday(weekStartMonday));
}

const todayCentral = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());

type Body = {
  managerEmail?: unknown; weekStart?: unknown; cityIdentifier?: unknown;
  amount?: unknown; reason?: unknown; managerId?: unknown;
};

export async function POST(req: Request) {
  const auth = await authenticateCapability(req, "matchops");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  let body: Body;
  try { body = (await req.json()) as Body; }
  catch { return Response.json({ error: "Invalid JSON body" }, { status: 400 }); }

  const managerEmail = (typeof body.managerEmail === "string" ? body.managerEmail : "").trim().toLowerCase();
  const weekStart = typeof body.weekStart === "string" ? body.weekStart : "";
  const cityIdentifier = (typeof body.cityIdentifier === "string" ? body.cityIdentifier : "").trim();
  const amount = Number(body.amount);
  const reason = (typeof body.reason === "string" ? body.reason : "").trim();
  const managerId = typeof body.managerId === "number" && Number.isFinite(body.managerId) ? body.managerId : null;

  if (!managerEmail || !EMAIL_RX.test(managerEmail)) return Response.json({ error: "Pick a person from the directory." }, { status: 400 });
  if (!ISO_DATE_RX.test(weekStart)) return Response.json({ error: "Invalid weekStart (YYYY-MM-DD)" }, { status: 400 });
  if (!cityIdentifier) return Response.json({ error: "Missing city" }, { status: 400 });
  if (!Number.isFinite(amount) || amount === 0) return Response.json({ error: "Enter an amount." }, { status: 400 });
  if (amount < -10000 || amount > 10000) return Response.json({ error: "Amount out of range (-10000 to 10000)" }, { status: 400 });
  // THE REASON IS NOT OPTIONAL. This is money with no match behind it.
  if (!reason) return Response.json({ error: "A reason is required — this is pay with no match behind it." }, { status: 400 });

  if (payRunHasGone(weekStart, todayCentral())) {
    return Response.json({
      error: `The pay run for the week of ${weekStart} went out on ${payRunDate(weekSundayFromMonday(weekStart))}. ` +
        `Rows for a submitted run are read-only.`,
    }, { status: 409 });
  }

  const sb = service();

  /* THE GUSTO MAPPING IS CHECKED SERVER-SIDE TOO. The dialog blocks it, but a dialog is a
   * courtesy — a row with no mapping reaches payroll as a First/Last split off a string and does
   * not pay, which is indistinguishable on the sheet from one that does. */
  const alias = await sb.from("manager_gusto_aliases").select("*").ilike("manager_email", managerEmail).maybeSingle();
  const hasGusto = !!(alias.data && (String(alias.data.gusto_first_name ?? "").trim() || String(alias.data.gusto_last_name ?? "").trim()));
  if (!hasGusto) {
    return Response.json({
      error: `${managerEmail} has no Gusto mapping. Set them up in Gusto and add the mapping first — ` +
        `a row without one reaches payroll looking identical to one that pays, and does not pay.`,
    }, { status: 409 });
  }

  /* DUPLICATE. The UNIQUE (manager_email, week_start) would reject it anyway, but a constraint
   * violation is a 500 with a Postgres string in it; this is a refusal that says where to go. */
  const existing = await sb.from(TABLE).select("*").ilike("manager_email", managerEmail).eq("week_start", weekStart).maybeSingle();
  if (existing.data) {
    return Response.json({
      error: `${managerEmail} already has a pay row for the week of ${weekStart}. Use "+ Add adjustment" on ` +
        `their existing row instead — two rows for one person in one week double-pays them in Gusto.`,
      existing: { amount: existing.data.amount, city: existing.data.city_identifier ?? null },
    }, { status: 409 });
  }

  const readRow = async (): Promise<Record<string, unknown>> => {
    const r = await sb.from(TABLE).select("*").ilike("manager_email", managerEmail).eq("week_start", weekStart).maybeSingle();
    return { row: r.data ?? null };
  };

  const { outcome, error, logged } = await recordWrite(
    {
      env: "production", source: "Manager Pay — added", actorName: auth.email, actorEmail: auth.email,
      saveId: randomUUID(), matchId: null, matchName: null,
      method: "POST", path: `/manager-pay/added/${weekStart}/${cityIdentifier}`,
      /* THE LOGGED BODY IS THE FIVE FACTS AND NOTHING ELSE: week, city, person, amount, reason.
       * No phone. The email is the manager identity change_log already carries for every pay row;
       * nothing beyond it is added here. */
      body: { weekStart, cityIdentifier, managerEmail, amount, reason },
      keys: [], label: (k) => k,
      applied: (_b, a) => (a.row as Record<string, unknown> | null) != null,
      changes: [
        { key: "added", field: "Added to pay sheet", before: "—", after: `${managerEmail} · ${cityIdentifier} · week of ${weekStart}` },
        { key: "amount", field: "Amount", before: 0, after: amount },
        { key: "reason", field: "Reason", before: "—", after: reason },
      ],
    },
    {
      readResource: readRow,
      write: async () => {
        const { error: e } = await sb.from(TABLE).insert({
          manager_email: managerEmail, manager_id: managerId, week_start: weekStart,
          city_identifier: cityIdentifier, amount, notes: reason,
          updated_at: new Date().toISOString(),
        });
        if (e) throw Object.assign(new Error(e.message), { name: "WriteFailedError" });
        return { ok: true };
      },
      now: () => new Date().toISOString(),
    },
    supabaseLogStore(),
  );

  if (error) return Response.json({ error: error.message, outcome }, { status: 500 });
  // THE VERDICT IS THE READ-BACK, not the absence of an error.
  return Response.json({ outcome, logRecorded: logged }, { status: outcome === "landed" ? 200 : 502 });
}

export async function DELETE(req: Request) {
  const auth = await authenticateCapability(req, "matchops");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const url = new URL(req.url);
  const id = Number(url.searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Invalid id" }, { status: 400 });

  const sb = service();
  const row = await sb.from(TABLE).select("*").eq("id", id).maybeSingle();
  if (!row.data) return Response.json({ error: "That row no longer exists." }, { status: 404 });

  /* ONLY MANUALLY ADDED ROWS. An inline Additional Pay cell carries no city and is edited by
   * typing in its own field; deleting it from here would remove a row this control never made. */
  if (!row.data.city_identifier) {
    return Response.json({ error: "That row was not added by this control — clear its Additional Pay cell instead." }, { status: 409 });
  }
  const weekStart = String(row.data.week_start);
  if (payRunHasGone(weekStart, todayCentral())) {
    return Response.json({
      error: `The pay run for the week of ${weekStart} went out on ${payRunDate(weekSundayFromMonday(weekStart))}. ` +
        `Rows for a submitted run are read-only.`,
    }, { status: 409 });
  }

  const readRow = async (): Promise<Record<string, unknown>> => {
    const r = await sb.from(TABLE).select("*").eq("id", id).maybeSingle();
    return { row: r.data ?? null };
  };

  const { outcome, error, logged } = await recordWrite(
    {
      env: "production", source: "Manager Pay — added", actorName: auth.email, actorEmail: auth.email,
      saveId: randomUUID(), matchId: null, matchName: null,
      method: "DELETE", path: `/manager-pay/added/${id}`,
      body: {
        weekStart, cityIdentifier: row.data.city_identifier,
        managerEmail: row.data.manager_email, amount: row.data.amount, reason: row.data.notes,
      },
      keys: [], label: (k) => k,
      applied: (_b, a) => (a.row as Record<string, unknown> | null) == null,
      changes: [
        { key: "removed", field: "Removed from pay sheet", before: `${row.data.manager_email} · ${row.data.city_identifier} · week of ${weekStart}`, after: "—" },
        { key: "amount", field: "Amount", before: row.data.amount, after: 0 },
      ],
    },
    {
      readResource: readRow,
      write: async () => {
        const { error: e } = await sb.from(TABLE).delete().eq("id", id);
        if (e) throw Object.assign(new Error(e.message), { name: "WriteFailedError" });
        return { ok: true };
      },
      now: () => new Date().toISOString(),
    },
    supabaseLogStore(),
  );

  if (error) return Response.json({ error: error.message, outcome }, { status: 500 });
  return Response.json({ outcome, logRecorded: logged }, { status: outcome === "landed" ? 200 : 502 });
}
