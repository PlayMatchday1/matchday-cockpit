// TEMPORARY admin-only diagnostic route.
//
// GET /api/admin/whatsapp/verify-template?name=support_followup
//
// Fetches a message template's definition straight from Meta's Graph
// API so we can read back its real language, status, and category and
// reconcile the local template registry. Read-only — no DB writes, no
// Meta mutations.
//
// Auth: reuses authenticateCrm (session JWT or CRON_SECRET) and then
// gates strictly on is_admin=true. Chats-only users are rejected.
//
// Remove this file once the template registry is fixed (follow-up
// commit).

import { authenticateCrm } from "@/lib/crmAuth";

export const runtime = "nodejs";
export const maxDuration = 15;

// Matches GRAPH_VERSION in src/lib/whatsapp.ts.
const GRAPH_VERSION = "v21.0";

export async function GET(req: Request) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }
  if (!auth.isAdmin) {
    return Response.json({ error: "Admin access required" }, { status: 403 });
  }

  const name = new URL(req.url).searchParams.get("name")?.trim();
  if (!name) {
    return Response.json(
      { error: "Missing ?name= query param" },
      { status: 400 },
    );
  }

  const token = process.env.META_ACCESS_TOKEN;
  const wabaId = process.env.META_WABA_ID;
  if (!token || !wabaId) {
    return Response.json(
      { error: "Missing META_ACCESS_TOKEN or META_WABA_ID" },
      { status: 500 },
    );
  }

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${wabaId}/message_templates?name=${encodeURIComponent(name)}`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
  } catch (e) {
    return Response.json(
      { error: `Fetch to Meta failed: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 },
    );
  }

  // Pass Meta's raw JSON straight through, preserving its HTTP status
  // so template-not-found / token errors surface as-is.
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return Response.json(
      { error: "Meta returned a non-JSON response", meta_status: res.status },
      { status: 502 },
    );
  }

  return Response.json({ queried: name, meta_status: res.status, meta_response: json });
}
