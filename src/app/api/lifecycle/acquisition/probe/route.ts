/* GET /api/lifecycle/acquisition/probe — READ-ONLY checks for the Acquisition page's sources.
 *
 * Step 1 of the Acquisition build (Ryan, 2026-10-04): find out what Apple's Analytics Reports API
 * actually returns with the EXISTING App Store Connect key (and, with ?google=1, the Google service
 * account) before any sync is written. Every call
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
import { JWT } from "google-auth-library";

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
  if (new URL(req.url).searchParams.get("google") === "1") return Response.json(await googleChecks(), { headers: { "Cache-Control": "no-store" } });

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

/* ── GOOGLE, READ ONLY (?google=1) ──────────────────────────────────────────────────────────────
 * The clubhouse-analytics service account (GOOGLE_ANALYTICS_SA_KEY_B64): Restricted in Search
 * Console, Viewer on both GA4 properties. Every call reads — searchAnalytics.query and runReport are
 * POSTs that only query. Returns statuses, error messages and row samples; never the key. */
const GSC_SITE = "https://www.playmatchday.com/";
const GA4_WEB = "485975225";
const GA4_APP = "349835849";
const SINCE = "2026-07-01";

type GCall = { what: string; status: number; ok: boolean; error?: string; data?: unknown };

async function googleToken(): Promise<string> {
  const b64 = process.env.GOOGLE_ANALYTICS_SA_KEY_B64?.trim();
  if (!b64) throw new Error("GOOGLE_ANALYTICS_SA_KEY_B64 is not set");
  let k: { client_email?: string; private_key?: string };
  try { k = JSON.parse(Buffer.from(b64, "base64").toString("utf8")); }
  catch { throw new Error("GOOGLE_ANALYTICS_SA_KEY_B64 did not base64-decode to JSON"); } // no value in the message
  if (!k.client_email || !k.private_key) throw new Error("service-account JSON is missing client_email / private_key");
  const jwt = new JWT({ email: k.client_email, key: k.private_key,
    scopes: ["https://www.googleapis.com/auth/webmasters.readonly", "https://www.googleapis.com/auth/analytics.readonly"] });
  const { token } = await jwt.getAccessToken();
  if (!token) throw new Error("no Google access token");
  return token;
}

async function gq(token: string, what: string, url: string, body?: unknown, pick: (j: Record<string, unknown>) => unknown = (j) => j): Promise<GCall> {
  const res = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined, cache: "no-store",
  });
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) return { what, status: res.status, ok: false, error: String((j.error as { message?: string })?.message ?? res.statusText) };
  return { what, status: res.status, ok: true, data: pick(j) };
}

type GaRow = { dimensionValues?: { value: string }[]; metricValues?: { value: string }[] };
const rowsOf = (j: Record<string, unknown>) => ({
  rowCount: j.rowCount ?? 0,
  rows: ((j.rows as GaRow[]) ?? []).map((r) => [...(r.dimensionValues ?? []).map((d) => d.value), ...(r.metricValues ?? []).map((m) => m.value)]),
});
const run = (prop: string) => `https://analyticsdata.googleapis.com/v1beta/properties/${prop}:runReport`;

async function googleChecks(): Promise<Record<string, unknown>> {
  let token: string;
  try { token = await googleToken(); } catch (e) { return { google: { error: e instanceof Error ? e.message : String(e) } }; }
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  const out: GCall[] = [];
  const gsc = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(GSC_SITE)}/searchAnalytics/query`;

  // SEARCH CONSOLE — the sites the account can see, the latest day with data, and top pages
  out.push(await gq(token, "gsc sites", "https://www.googleapis.com/webmasters/v3/sites", undefined, (j) => j.siteEntry));
  out.push(await gq(token, "gsc by date (first and last days)", gsc, { startDate: SINCE, endDate: today, dimensions: ["date"], rowLimit: 200 },
    (j) => { const r = (j.rows as { keys: string[]; clicks: number; impressions: number }[]) ?? []; return { days: r.length, first: r[0], last: r.slice(-3) }; }));
  out.push(await gq(token, "gsc top pages since Jul 1", gsc, { startDate: SINCE, endDate: today, dimensions: ["page"], rowLimit: 30 },
    (j) => { const r = (j.rows as { keys: string[]; clicks: number; impressions: number; position: number }[]) ?? []; return { pages: r.length, rows: r.map((x) => [x.keys[0], x.clicks, x.impressions, Math.round(x.position * 10) / 10]) }; }));
  out.push(await gq(token, "gsc distinct pages since Jul 1", gsc, { startDate: SINCE, endDate: today, dimensions: ["page"], rowLimit: 25000 },
    (j) => ((j.rows as unknown[]) ?? []).length));

  // GA4 WEBSITE — custom dimensions on record, pages, outbound store clicks, the tagged event
  out.push(await gq(token, "ga4 web metadata: custom dimensions", `https://analyticsdata.googleapis.com/v1beta/properties/${GA4_WEB}/metadata`, undefined,
    (j) => ((j.dimensions as { apiName: string; uiName: string; customDefinition?: boolean }[]) ?? []).filter((d) => d.customDefinition).map((d) => [d.apiName, d.uiName])));
  out.push(await gq(token, "ga4 web top pages since Jul 1", run(GA4_WEB), {
    dateRanges: [{ startDate: SINCE, endDate: today }], dimensions: [{ name: "pagePath" }],
    metrics: [{ name: "sessions" }, { name: "totalUsers" }, { name: "screenPageViews" }],
    orderBys: [{ metric: { metricName: "sessions" }, desc: true }], limit: 25 }, rowsOf));
  const storeLink = { orGroup: { expressions: [
    { filter: { fieldName: "linkUrl", stringFilter: { matchType: "CONTAINS", value: "apps.apple.com" } } },
    { filter: { fieldName: "linkUrl", stringFilter: { matchType: "CONTAINS", value: "play.google.com" } } }] } };
  out.push(await gq(token, "ga4 web outbound store clicks by month", run(GA4_WEB), {
    dateRanges: [{ startDate: "2025-01-01", endDate: today }], dimensions: [{ name: "yearMonth" }, { name: "eventName" }],
    metrics: [{ name: "eventCount" }], dimensionFilter: storeLink, orderBys: [{ dimension: { dimensionName: "yearMonth" } }], limit: 100 }, rowsOf));
  out.push(await gq(token, "ga4 web outbound store clicks by page since Jul 1", run(GA4_WEB), {
    dateRanges: [{ startDate: SINCE, endDate: today }], dimensions: [{ name: "pagePath" }, { name: "linkUrl" }],
    metrics: [{ name: "eventCount" }], dimensionFilter: storeLink, orderBys: [{ metric: { metricName: "eventCount" }, desc: true }], limit: 25 }, rowsOf));
  out.push(await gq(token, "ga4 web app_store_click by page, store, tag", run(GA4_WEB), {
    dateRanges: [{ startDate: "2026-09-25", endDate: today }], dimensions: [{ name: "pagePath" }, { name: "customEvent:store" }, { name: "customEvent:tag" }],
    metrics: [{ name: "eventCount" }], dimensionFilter: { filter: { fieldName: "eventName", stringFilter: { value: "app_store_click" } } },
    orderBys: [{ metric: { metricName: "eventCount" }, desc: true }], limit: 30 }, rowsOf));

  // GA4 APP — dynamic_link_first_open over time, by platform, and what it carries
  out.push(await gq(token, "ga4 app metadata: custom dimensions", `https://analyticsdata.googleapis.com/v1beta/properties/${GA4_APP}/metadata`, undefined,
    (j) => ((j.dimensions as { apiName: string; uiName: string; customDefinition?: boolean }[]) ?? []).filter((d) => d.customDefinition).map((d) => [d.apiName, d.uiName])));
  out.push(await gq(token, "ga4 app dynamic_link_first_open / first_open by month and platform", run(GA4_APP), {
    dateRanges: [{ startDate: "2024-01-01", endDate: today }], dimensions: [{ name: "yearMonth" }, { name: "eventName" }, { name: "platform" }],
    metrics: [{ name: "eventCount" }], dimensionFilter: { filter: { fieldName: "eventName", inListFilter: { values: ["dynamic_link_first_open", "dynamic_link_app_open", "first_open"] } } },
    orderBys: [{ dimension: { dimensionName: "yearMonth" } }], limit: 300 }, rowsOf));
  out.push(await gq(token, "ga4 app dynamic_link_first_open by source / medium / campaign since Jul 1", run(GA4_APP), {
    dateRanges: [{ startDate: SINCE, endDate: today }], dimensions: [{ name: "sessionSource" }, { name: "sessionMedium" }, { name: "sessionCampaignName" }],
    metrics: [{ name: "eventCount" }], dimensionFilter: { filter: { fieldName: "eventName", stringFilter: { value: "dynamic_link_first_open" } } },
    orderBys: [{ metric: { metricName: "eventCount" }, desc: true }], limit: 30 }, rowsOf));
  return { checkedAt: new Date().toISOString(), today, google: out };
}
