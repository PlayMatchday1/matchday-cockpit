// GET /api/diag/appstore-token — TEMPORARY diagnostic for the App Store Connect
// 401. Guarded exactly like the Run-now endpoints (Bearer: CRON_SECRET OR a valid
// user session). Builds a REAL token from the production credentials, reports its
// shape, and makes ONE live call to /v1/apps?limit=1 (needs no report params, so
// it isolates auth from every other variable). The .p8 bytes / base64 are NEVER
// returned or logged — only the derived PUBLIC key hash and shape metadata.
// DELETE THIS ROUTE once the 401 is understood.

import { timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { buildTokenDiagnostic } from "@/lib/appStoreInstallsSync";

export const runtime = "nodejs";
export const maxDuration = 30;

function constantTimeMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export async function GET(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return Response.json({ error: "Missing Authorization header" }, { status: 401 });
  const token = auth.slice("Bearer ".length).trim();
  if (!token) return Response.json({ error: "Empty bearer token" }, { status: 401 });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const cronSecret = process.env.CRON_SECRET;
  if (!supabaseUrl || !publishableKey) return Response.json({ error: "Supabase env not configured" }, { status: 500 });

  if (!(cronSecret && constantTimeMatch(token, cronSecret))) {
    const sessionClient = createClient(supabaseUrl, publishableKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await sessionClient.auth.getUser(token);
    if (error || !data?.user) return Response.json({ error: "Invalid session" }, { status: 401 });
  }

  let diag: Record<string, unknown>;
  let apiToken: string;
  try {
    const built = buildTokenDiagnostic();
    diag = built.diag;
    apiToken = built.token;
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "diagnostic build failed" }, { status: 200 });
  }

  // One live, parameter-free call — isolates auth from report params.
  let appleStatus = 0;
  let appleBody = "";
  const appleHeaders: Record<string, string | null> = {};
  try {
    const res = await fetch("https://api.appstoreconnect.apple.com/v1/apps?limit=1", {
      headers: { Authorization: `Bearer ${apiToken}` },
    });
    appleStatus = res.status;
    appleBody = (await res.text().catch(() => "")).slice(0, 800);
    appleHeaders["x-request-id"] = res.headers.get("x-request-id");
    appleHeaders["retry-after"] = res.headers.get("retry-after");
    appleHeaders["www-authenticate"] = res.headers.get("www-authenticate");
  } catch (e) {
    appleBody = `fetch error: ${e instanceof Error ? e.message : String(e)}`;
  }

  // apiToken is deliberately NOT returned.
  return Response.json({ ...diag, appleStatus, appleBody, appleHeaders }, { status: 200 });
}
