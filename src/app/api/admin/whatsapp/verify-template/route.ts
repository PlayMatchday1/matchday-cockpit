// TEMPORARY admin-only diagnostic route.
//
// GET /api/admin/whatsapp/verify-template?name=support_followup&key=...
//
// Fetches a message template's definition straight from Meta's Graph
// API so we can read back its real language, status, and category and
// reconcile the local template registry. Read-only — no DB writes, no
// Meta mutations.
//
// Auth: gated by a shared secret in the query string
// (VERIFY_TEMPLATE_KEY) rather than a session check. This app stores
// its Supabase session in localStorage, not a cookie, so a plain
// browser URL visit sends no session for the server to validate. The
// secret key lets the route be hit by just pasting the URL into the
// address bar while we reconcile the registry.
//
// Remove this file AND the VERIFY_TEMPLATE_KEY env var once the
// template registry is fixed (follow-up commit).

import { timingSafeEqual } from "node:crypto";

export const runtime = "nodejs";
export const maxDuration = 15;

// Matches GRAPH_VERSION in src/lib/whatsapp.ts.
const GRAPH_VERSION = "v21.0";

function constantTimeMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;

  const expectedKey = process.env.VERIFY_TEMPLATE_KEY;
  if (!expectedKey) {
    return Response.json(
      { error: "VERIFY_TEMPLATE_KEY not configured" },
      { status: 500 },
    );
  }
  const key = params.get("key") ?? "";
  if (!constantTimeMatch(key, expectedKey)) {
    return Response.json({ error: "Invalid or missing key" }, { status: 401 });
  }

  const name = params.get("name")?.trim();
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
