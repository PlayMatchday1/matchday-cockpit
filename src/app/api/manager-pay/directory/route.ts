/* GET /api/manager-pay/directory — the people who may be added to a pay sheet. READ ONLY.
 *
 * ── WHY A DIRECTORY AND NOT FREE TEXT ─────────────────────────────────────────────────────────
 * A hand-typed name has no Gusto mapping. It would land in the payroll CSV as a First/Last split
 * off a string, and a row that does not pay looks EXACTLY like a row that does — same shape, same
 * amount column, no error anywhere. The only difference is that the money never arrives, and
 * nobody finds out until the person says so. So the picker offers people who already exist and
 * nothing else.
 *
 * ── WHERE "EXISTS" COMES FROM ─────────────────────────────────────────────────────────────────
 * Two sources, unioned on lower(email):
 *   mdapi_matches        — anyone who has ever been assigned a match, primary or second. This is
 *                          the real roster of managers; there is no manager table upstream.
 *   manager_gusto_aliases — the Gusto mapping, and the authority on how the name reaches payroll.
 *
 * A person in the alias table but never on a match is still offered: they were set up in Gusto
 * deliberately, which is a stronger statement of "should be payable" than an old assignment.
 *
 * ── gusto: null IS THE ANSWER THE CALLER NEEDS ────────────────────────────────────────────────
 * It is returned rather than filtered out, so the dialog can show the person, say why they cannot
 * be saved, and send the operator to Gusto — instead of silently omitting them, which reads as
 * "this person does not exist" and sends the operator to type their name somewhere worse.
 */

import { authenticateCapability } from "@/lib/capabilityAuth";
import { selectAll } from "@/lib/supabasePagination";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export type DirectoryEntry = {
  email: string;
  name: string;
  /** The Gusto mapping, or null. Null is displayed, never hidden — see the header. */
  gusto: { firstName: string; lastName: string } | null;
  /** true when they have ever been assigned a match. Purely informational in the picker. */
  onSchedule: boolean;
};

const displayName = (first?: string | null, last?: string | null, email?: string | null): string =>
  [first, last].filter(Boolean).join(" ").trim() || (email ?? "");

export async function GET(req: Request) {
  const auth = await authenticateCapability(req, "matchops");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const sb = auth.supabase;

  try {
    const byEmail = new Map<string, DirectoryEntry>();

    /* EVERY MANAGER EVER ASSIGNED. Paged — mdapi_matches is well past the 1,000-row cap, and a
     * truncated directory is a picker that silently cannot find someone. */
    const matches = await selectAll<Record<string, unknown>>(() =>
      sb.from("mdapi_matches")
        .select("manager_email, manager_first_name, manager_last_name, second_manager_id, raw")
        .is("deleted_at", null)
        .order("api_id"),
    );
    for (const m of matches) {
      const email = String(m.manager_email ?? "").trim().toLowerCase();
      if (email) {
        byEmail.set(email, {
          email,
          name: displayName(m.manager_first_name as string, m.manager_last_name as string, email),
          gusto: null, onSchedule: true,
        });
      }
      // The second manager lives only in the raw payload — the same shape resolveSecond reads.
      const sm = (m.raw as { secondManager?: { email?: string; firstName?: string; lastName?: string } } | null)?.secondManager;
      const se = String(sm?.email ?? "").trim().toLowerCase();
      if (se && !byEmail.has(se)) {
        byEmail.set(se, { email: se, name: displayName(sm?.firstName, sm?.lastName, se), gusto: null, onSchedule: true });
      }
    }

    /* THE GUSTO MAPPING. select("*") not a column list — code deploys before migrations apply and
     * naming a column that has not shipped yet 500s the whole picker. */
    const aliases = await selectAll<Record<string, unknown>>(() =>
      sb.from("manager_gusto_aliases").select("*").order("manager_email"),
    );
    for (const a of aliases) {
      const email = String(a.manager_email ?? "").trim().toLowerCase();
      if (!email) continue;
      const gusto = {
        firstName: String(a.gusto_first_name ?? "").trim(),
        lastName: String(a.gusto_last_name ?? "").trim(),
      };
      const prev = byEmail.get(email);
      byEmail.set(email, {
        email,
        name: prev?.name || displayName(gusto.firstName, gusto.lastName, email),
        gusto: gusto.firstName || gusto.lastName ? gusto : null,
        onSchedule: prev?.onSchedule ?? false,
      });
    }

    const people = [...byEmail.values()].sort((a, b) => a.name.localeCompare(b.name));
    return Response.json(
      { people, withGusto: people.filter((p) => p.gusto).length },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    // LOUD. An empty picker and a failed read must never look the same.
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
