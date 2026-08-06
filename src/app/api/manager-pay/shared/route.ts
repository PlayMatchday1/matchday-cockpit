// GET /api/manager-pay/shared?token=<share-token>&week=YYYY-MM-DD
//
// The PUBLIC, read-only surface for the shareable manager link. Purpose-built —
// NOT the admin route with a public flag, NOT a branch of it. It returns EXACTLY
// the whitelisted SharedManagerPayPayload (src/lib/managerPaySharedPayload.ts) and
// nothing else, so a field added to the admin payload can never silently publish.
//
// Auth = the unguessable token in the URL, compared (constant-time) against the
// stored SHA-256 hash. A wrong, missing, or rotated token → 404 (never 403: a 403
// would confirm the URL shape and invite guessing). No session, no writes; this
// handler cannot trigger any work.

import { createClient } from "@supabase/supabase-js";
import { computeManagerPayForWeek, ISO_DATE_RX, weekdayUtc } from "@/lib/managerPayCompute";
import { getArrivalInfo } from "@/lib/managerPayArrival";
import { toSharedPayload } from "@/lib/managerPaySharedPayload";
import { tokenMatchesHash } from "@/lib/managerPayShareToken";

export const runtime = "nodejs";
export const maxDuration = 30;
export const dynamic = "force-dynamic";

const notFound = () => Response.json({ error: "Not found" }, { status: 404 });

export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") ?? "";
  const weekParam = url.searchParams.get("week");

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!supabaseUrl || !serviceKey) {
    return Response.json({ error: "Supabase env not configured" }, { status: 500 });
  }
  const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  // Validate the token FIRST — a bad token is a 404 regardless of the week.
  if (!token) return notFound();
  const row = await sb.from("manager_pay_share_token").select("token_hash").eq("id", 1).maybeSingle();
  if (row.error || !row.data?.token_hash) return notFound(); // no link configured yet
  if (!tokenMatchesHash(token, row.data.token_hash as string)) return notFound();

  // Token is valid → validate the week and serve the whitelisted payload.
  if (!weekParam || !ISO_DATE_RX.test(weekParam)) {
    return Response.json({ error: "Missing or malformed ?week=YYYY-MM-DD" }, { status: 400 });
  }
  if (weekdayUtc(weekParam) !== 1) {
    return Response.json({ error: "?week must be a Monday (YYYY-MM-DD)" }, { status: 400 });
  }

  try {
    // isAdmin:false → emails are never populated; the whitelist mapper drops them anyway.
    const full = await computeManagerPayForWeek(sb, weekParam, { isAdmin: false });
    const arrival = await getArrivalInfo(sb, weekParam);
    return Response.json(toSharedPayload(full, arrival));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
