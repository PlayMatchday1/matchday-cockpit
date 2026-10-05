/* GET /api/lifecycle/acquisition/probe — READ-ONLY checks for the Acquisition page's sources.
 *
 * Step 1 of the Acquisition build (Ryan, 2026-10-04): find out what Apple's Analytics Reports API
 * actually returns with the EXISTING App Store Connect key before any sync is written. Every call
 * here is a GET; nothing is created at Apple and nothing is written to our database.
 *
 * THE TWO REPORT REQUESTS EXIST (created 2026-10-05 with a short-lived Admin key, since revoked):
 *   ONGOING            25012829-700a-4d29-9af5-a8a355f4b59b
 *   ONE_TIME_SNAPSHOT  bdc34702-e989-4c4f-a06e-f23edee877c8
 * The everyday Sales-and-Reports key can read both and their reports; it cannot create requests
 * (403 FORBIDDEN_ERROR). Restarting a request that Apple stops for inactivity needs Admin again.
 *
 * Returns HTTP statuses, Apple error codes/titles and report metadata — never the token, the key
 * or any credential. Gated on can_access_lifecycle, like every page in the section.
 */

import { authenticateLifecycle } from "@/lib/lifecycleAuth";
import { mintToken, AppleAuthError } from "@/lib/appStoreInstallsSync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const APP_ID = "1666868601";
const ASC = "https://api.appstoreconnect.apple.com";

type Call = { path: string; status: number; ok: boolean; errors?: { code?: string; title?: string; detail?: string }[]; data?: unknown };

async function ascGet(token: string, path: string, pick: (j: Record<string, unknown>) => unknown): Promise<Call> {
  const res = await fetch(`${ASC}${path}`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const errs = (j.errors as { code?: string; title?: string; detail?: string }[] | undefined) ?? [];
    return { path, status: res.status, ok: false, errors: errs.map((e) => ({ code: e.code, title: e.title, detail: e.detail })) };
  }
  return { path, status: res.status, ok: true, data: pick(j) };
}

type Res = { id: string; attributes?: Record<string, unknown> };

export async function GET(req: Request) {
  const auth = await authenticateLifecycle(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  let token: string;
  try { token = mintToken().token; }
  catch (e) { return Response.json({ apple: { error: e instanceof AppleAuthError ? e.message : "could not sign an App Store Connect token" } }); }

  const calls: Call[] = [];
  // 1 — can this key see the app at all?
  calls.push(await ascGet(token, `/v1/apps/${APP_ID}?fields[apps]=name,bundleId`, (j) => (j.data as Res)?.attributes));
  // 2 — the report requests that already exist for the app (none is created here)
  const reqs = await ascGet(token, `/v1/apps/${APP_ID}/analyticsReportRequests?limit=50`,
    (j) => ((j.data as Res[]) ?? []).map((r) => ({ id: r.id, ...r.attributes })));
  calls.push(reqs);
  // 3 — for each existing request, its reports; for the download reports, their latest instances
  if (reqs.ok) {
    for (const r of ((reqs.data as { id: string }[]) ?? []).slice(0, 5)) {
      const reports = await ascGet(token, `/v1/analyticsReportRequests/${r.id}/reports?limit=200`,
        (j) => ((j.data as Res[]) ?? []).map((x) => ({ id: x.id, name: x.attributes?.name, category: x.attributes?.category })));
      calls.push(reports);
      if (!reports.ok) continue;
      const downloads = ((reports.data as { id: string; name?: string }[]) ?? []).filter((x) => /download/i.test(String(x.name)));
      for (const d of downloads.slice(0, 4)) {
        calls.push(await ascGet(token, `/v1/analyticsReports/${d.id}/instances?limit=5`,
          (j) => ((j.data as Res[]) ?? []).map((x) => ({ id: x.id, report: d.name, ...x.attributes }))));
      }
    }
  }
  return Response.json({ checkedAt: new Date().toISOString(), appId: APP_ID, apple: calls }, { headers: { "Cache-Control": "no-store" } });
}
