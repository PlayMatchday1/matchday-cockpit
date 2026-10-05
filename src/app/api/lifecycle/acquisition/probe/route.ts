/* GET /api/lifecycle/acquisition/probe — READ-ONLY checks for the Acquisition page's sources.
 *
 * Step 1 of the Acquisition build (Ryan, 2026-10-04): find out what Apple's Analytics Reports API
 * actually returns with the EXISTING App Store Connect key before any sync is written. GET makes
 * GET calls only. POST (below) is the one write: it creates the two report requests at Apple, once,
 * after Ryan approved it. Nothing here writes to our database.
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

/* POST — CREATE THE TWO REPORT REQUESTS, ONCE (Ryan said "go", 2026-10-04). The only write this file
 * makes, and it is to Apple, not to us: one ONGOING (daily from now) and one ONE_TIME_SNAPSHOT
 * (history) analytics report request for the app. Each is created ONLY IF no request of that
 * access type exists already — a second press cannot duplicate one — and it is never retried. The
 * response re-reads the app's requests, so what it reports is what Apple now holds, not what we
 * sent. To be removed once the sync reads the reports. */
export async function POST(req: Request) {
  const auth = await authenticateLifecycle(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  // THE SETUP KEY (Admin), not the sync key: the Sales-and-Reports key was refused with 403
  // FORBIDDEN_ERROR on 2026-10-05. Revoked once both requests exist.
  let token: string;
  try { token = mintToken("setup").token; }
  catch (e) { return Response.json({ error: e instanceof AppleAuthError ? e.message : "could not sign an App Store Connect token" }, { status: 500 }); }

  const list = async () => ascGet(token, `/v1/apps/${APP_ID}/analyticsReportRequests?limit=50`,
    (j) => ((j.data as Res[]) ?? []).map((r) => ({ id: r.id, ...r.attributes })));
  const before = await list();
  if (!before.ok) return Response.json({ step: "read existing requests", before }, { status: 502 });
  const have = new Set(((before.data as { accessType?: string }[]) ?? []).map((r) => r.accessType));

  const created: Call[] = [];
  for (const accessType of ["ONGOING", "ONE_TIME_SNAPSHOT"]) {
    if (have.has(accessType)) { created.push({ path: `skip ${accessType} (already exists)`, status: 0, ok: true }); continue; }
    const res = await fetch(`${ASC}/v1/analyticsReportRequests`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ data: { type: "analyticsReportRequests", attributes: { accessType },
        relationships: { app: { data: { type: "apps", id: APP_ID } } } } }),
      cache: "no-store",
    });
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    created.push(res.ok
      ? { path: `POST ${accessType}`, status: res.status, ok: true, data: { id: (j.data as Res)?.id, ...(j.data as Res)?.attributes } }
      : { path: `POST ${accessType}`, status: res.status, ok: false,
          errors: ((j.errors as { code?: string; title?: string; detail?: string }[]) ?? []).map((e) => ({ code: e.code, title: e.title, detail: e.detail })) });
  }
  const after = await list();
  return Response.json({ checkedAt: new Date().toISOString(), created, after }, { headers: { "Cache-Control": "no-store" } });
}
