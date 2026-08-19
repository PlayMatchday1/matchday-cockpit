// Admin CRUD for the Veo code→field map (veo_codes). Admin-only (service role
// behind the Match Ops capability, via authenticateCapability). veo_codes has no client write RLS,
// so all edits go through here.
//
//   GET  /api/veo/codes — code rows + the venue/field options for the editor.
//   POST /api/veo/codes — create a code.

import { authenticateCapability } from "@/lib/capabilityAuth";
import { validateVeoCodeInput } from "@/lib/veo";
import {
  fetchVeoCodeRows,
  invalidateVeoCodesCache,
  loadVenueFieldOptions,
  validateFieldOwnership,
} from "@/lib/veoCodes";

export const runtime = "nodejs";
export const maxDuration = 15;

export async function GET(req: Request) {
  const auth = await authenticateCapability(req, "matchops");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  try {
    const [codes, venueFields] = await Promise.all([
      fetchVeoCodeRows(auth.supabase),
      loadVenueFieldOptions(auth.supabase),
    ]);
    return Response.json({ codes, venueFields }, { status: 200 });
  } catch (err) {
    console.error("[veo:codes] GET failed", err);
    return Response.json({ error: "DB error" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const auth = await authenticateCapability(req, "matchops");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const body = await req.json().catch(() => null);
  if (!body) return Response.json({ error: "Invalid request body." }, { status: 400 });

  const v = validateVeoCodeInput(body);
  if (!v.ok) return Response.json({ error: v.error }, { status: 400 });

  const ownErr = await validateFieldOwnership(auth.supabase, v.value.fin_venue_id, v.value.field_ids);
  if (ownErr) return Response.json({ error: ownErr }, { status: 400 });

  const ins = await auth.supabase
    .from("veo_codes")
    .insert(v.value)
    .select("id")
    .maybeSingle();
  if (ins.error) {
    if (ins.error.code === "23505") {
      return Response.json({ error: `Code "${v.value.code}" already exists.` }, { status: 409 });
    }
    console.error("[veo:codes] insert failed", ins.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }

  invalidateVeoCodesCache();
  console.log(`[veo:codes] created code=${v.value.code} by=${auth.appUserId}`);
  return Response.json({ ok: true, id: ins.data!.id }, { status: 200 });
}
