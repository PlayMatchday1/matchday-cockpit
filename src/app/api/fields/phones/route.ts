/* FIELD CANCELLATION NUMBERS.
 *
 *   GET    /api/fields/phones?fieldId=       -> GET    /admin/fields/{id}/phone-numbers
 *   POST   /api/fields/phones?fieldId=       -> POST   /admin/fields/{id}/phone-numbers {phoneNumber}
 *   DELETE /api/fields/phones?fieldId=&phoneId=
 *
 * The row is { id, fieldId, phoneNumber, isEnabled, createdAt, updatedAt }. MANY per field. There
 * is NO LABEL FIELD — the mockup's "Field contact" and "Groundskeeper" do not exist in the API and
 * are not invented here. isEnabled is real.
 *
 * WHAT TRIGGERS THE SEND IS UNKNOWN. These numbers receive a text when a match at the field is
 * cancelled, but the send is MatchDay-side: nothing in the API surface or our tables shows the
 * trigger, the template, or the sender. Who else can read them is UNKNOWN beyond "any holder of
 * admin API credentials". Both are stated as UNKNOWN rather than described.
 *
 * ── NEVER LOG THE NUMBER ──────────────────────────────────────────────────────────────────────
 * change_log records THAT a number was added or removed on a field, and the field id. Not the
 * number. A phone number is player-adjacent PII and change_log is readable by more people than
 * this endpoint is; putting numbers in it would make the audit trail a second copy of contact
 * details with different access rules. recordWrite's body here is { fieldId, action } — two
 * values, neither of them a number that reaches a person.
 */

import { authenticateMatchOpsRead } from "@/lib/matchOpsAuth";
import { makeServerClient } from "@/lib/supabaseServer";
import { randomUUID } from "node:crypto";
import { apiGet, apiWrite } from "@/lib/matchdayStageApi";
import { recordWrite, supabaseLogStore } from "@/lib/changeLog";
import { validPhone, type PhoneRow } from "@/lib/fieldsModel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const ENV = "production" as const;
const path = (fieldId: number) => `/admin/fields/${fieldId}/phone-numbers`;
const list = (fieldId: number) => apiGet<PhoneRow[]>(ENV, path(fieldId));

const fieldIdOf = (req: Request) => {
  const n = Number(new URL(req.url).searchParams.get("fieldId"));
  return Number.isInteger(n) && n > 0 ? n : null;
};

export async function GET(req: Request) {
  const auth = await authenticateMatchOpsRead(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const fieldId = fieldIdOf(req);
  if (fieldId === null) return Response.json({ error: "fieldId required" }, { status: 400 });
  try {
    const rows = await list(fieldId);
    return Response.json({
      phones: (rows ?? []).map((p) => ({ id: p.id, phoneNumber: p.phoneNumber, isEnabled: p.isEnabled !== false })),
    });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message.slice(0, 160) : "read failed" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const auth = await authenticateMatchOpsRead(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const fieldId = fieldIdOf(req);
  if (fieldId === null) return Response.json({ error: "fieldId required" }, { status: 400 });

  const body = (await req.json().catch(() => null)) as { phoneNumber?: unknown } | null;
  const phoneNumber = String(body?.phoneNumber ?? "").trim();
  // NEVER SENDS "". A blank Add is refused here, not posted and left to the API.
  if (!phoneNumber || !validPhone(phoneNumber)) {
    return Response.json({ error: "a phone number is required" }, { status: 400 });
  }

  const saveId = randomUUID();
  const { outcome, error } = await recordWrite(
    {
      env: ENV, source: "Fields · phone added",
      actorName: auth.email, actorEmail: auth.email, saveId,
      matchId: null, matchName: null,
      method: "POST", path: path(fieldId),
      /* THE NUMBER IS NOT IN HERE. Only the field it was added to and the fact of the add. */
      body: { fieldId, action: "phone added" }, keys: ["fieldId", "action"], label: (k) => k,
      applied: (before, after) => Number(after.n ?? 0) > Number(before.n ?? 0),
    },
    {
      readResource: async () => ({ n: (await list(fieldId).catch(() => [])).length }),
      write: () => apiWrite(ENV, "POST", path(fieldId), { phoneNumber }, { canEditMatches: true, email: auth.email }),
      now: () => new Date().toISOString(),
    },
    supabaseLogStore(),
  );

  // READ-BACK, not the 2xx: is the number actually on the field now?
  const after = await list(fieldId).catch(() => null);
  const present = after?.some((p) => String(p.phoneNumber).replace(/[^0-9]/g, "") === phoneNumber.replace(/[^0-9]/g, "")) ?? false;
  return Response.json({
    verdict: present ? "LANDED" : after == null || outcome === "unknown" ? "UNKNOWN" : "FAILED",
    phones: (after ?? []).map((p) => ({ id: p.id, phoneNumber: p.phoneNumber, isEnabled: p.isEnabled !== false })),
    error: error ? error.message.slice(0, 160) : null,
  }, { status: present ? 200 : 502 });
}

export async function DELETE(req: Request) {
  const auth = await authenticateMatchOpsRead(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const url = new URL(req.url);
  const fieldId = fieldIdOf(req);
  const phoneId = Number(url.searchParams.get("phoneId"));
  if (fieldId === null) return Response.json({ error: "fieldId required" }, { status: 400 });
  if (!Number.isInteger(phoneId) || phoneId <= 0) return Response.json({ error: "phoneId required" }, { status: 400 });

  const saveId = randomUUID();
  const { outcome, error } = await recordWrite(
    {
      env: ENV, source: "Fields · phone removed",
      actorName: auth.email, actorEmail: auth.email, saveId,
      matchId: null, matchName: null,
      method: "DELETE", path: `${path(fieldId)}/${phoneId}`,
      body: { fieldId, action: "phone removed" }, keys: ["fieldId", "action"], label: (k) => k,
      applied: (before, after) => Number(after.n ?? 0) < Number(before.n ?? 0),
    },
    {
      readResource: async () => ({ n: (await list(fieldId).catch(() => [])).length }),
      write: () => apiWrite(ENV, "DELETE", `${path(fieldId)}/${phoneId}`, undefined, { canEditMatches: true, email: auth.email }),
      now: () => new Date().toISOString(),
    },
    supabaseLogStore(),
  );

  const after = await list(fieldId).catch(() => null);
  const gone = after != null && !after.some((p) => Number(p.id) === phoneId);
  return Response.json({
    verdict: gone ? "LANDED" : after == null || outcome === "unknown" ? "UNKNOWN" : "FAILED",
    phones: (after ?? []).map((p) => ({ id: p.id, phoneNumber: p.phoneNumber, isEnabled: p.isEnabled !== false })),
    error: error ? error.message.slice(0, 160) : null,
  }, { status: gone ? 200 : 502 });
}
