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
import { gunzipSync } from "node:zlib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

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
  if (new URL(req.url).searchParams.get("apple") === "deep") return Response.json(await appleDeep(), { headers: { "Cache-Control": "no-store" } });

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

/* ── APPLE, DEEP, READ ONLY (?apple=deep) ─────────────────────────────────────────────────────────
 * For the two report requests: the download and discovery reports, every instance Apple lists for
 * them (granularity, processing date), and for the newest instance of each granularity the first
 * segment's file — its column header, the dates it covers, and the values in the source columns.
 * GETs only; the file is read and summarised here, nothing is stored. */
const REQUESTS = { ONGOING: "25012829-700a-4d29-9af5-a8a355f4b59b", ONE_TIME_SNAPSHOT: "bdc34702-e989-4c4f-a06e-f23edee877c8" };
const WANT = /^(App Downloads (Standard|Detailed)|App Store Discovery and Engagement (Standard|Detailed))$/;

async function appleDeep(): Promise<Record<string, unknown>> {
  let token: string;
  try { token = mintToken().token; } catch (e) { return { error: e instanceof AppleAuthError ? e.message : "could not sign a token" }; }
  const get = async (path: string) => {
    const res = await fetch(path.startsWith("http") ? path : `${ASC}${path}`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, ok: res.ok, j };
  };
  const all = async (path: string) => {
    const out: Res[] = []; let next: string | null = path; let status = 200;
    while (next) {
      const r = await get(next); status = r.status;
      if (!r.ok) return { status, items: out, error: JSON.stringify(r.j.errors ?? r.j).slice(0, 300) };
      out.push(...((r.j.data as Res[]) ?? []));
      next = ((r.j.links as { next?: string } | undefined)?.next) ?? null;
    }
    return { status, items: out, error: null as string | null };
  };
  const out: Record<string, unknown> = { checkedAt: new Date().toISOString() };
  for (const [kind, reqId] of Object.entries(REQUESTS)) {
    const req = await get(`/v1/analyticsReportRequests/${reqId}`);
    const reports = await all(`/v1/analyticsReportRequests/${reqId}/reports?limit=200`);
    const wanted = reports.items.filter((r) => WANT.test(String(r.attributes?.name)));
    const perReport: Record<string, unknown>[] = [];
    for (const rep of wanted) {
      const inst = await all(`/v1/analyticsReports/${rep.id}/instances?limit=200`);
      const instances = inst.items.map((i) => ({ id: i.id, granularity: i.attributes?.granularity, processingDate: i.attributes?.processingDate }));
      const byGran: Record<string, { count: number; first: string | null; last: string | null }> = {};
      for (const i of instances) {
        const g = String(i.granularity); const d = String(i.processingDate ?? "");
        const e = byGran[g] ?? (byGran[g] = { count: 0, first: null, last: null });
        e.count++; if (!e.first || d < e.first) e.first = d; if (!e.last || d > e.last) e.last = d;
      }
      // The newest instance of each granularity: open its first segment.
      const samples: Record<string, unknown>[] = [];
      for (const g of Object.keys(byGran)) {
        const newest = instances.filter((i) => i.granularity === g).sort((a, b) => String(b.processingDate).localeCompare(String(a.processingDate)))[0];
        if (!newest) continue;
        const segs = await all(`/v1/analyticsReportInstances/${newest.id}/segments?limit=50`);
        const seg = segs.items[0];
        const url = seg?.attributes?.url as string | undefined;
        if (!url) { samples.push({ granularity: g, instance: newest.processingDate, segments: segs.items.length, note: segs.error ?? "no segment url" }); continue; }
        try {
          const fileRes = await fetch(url, { cache: "no-store" });
          const buf = Buffer.from(await fileRes.arrayBuffer());
          let text: string; try { text = gunzipSync(buf).toString("utf8"); } catch { text = buf.toString("utf8"); }
          const lines = text.split(/\r?\n/).filter(Boolean);
          const header = (lines[0] ?? "").split("\t");
          const rows = lines.slice(1).map((l) => l.split("\t"));
          const col = (name: string) => header.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());
          const distinct = (name: string, n = 40) => {
            const i = col(name); if (i < 0) return null;
            const c: Record<string, number> = {}; for (const r of rows) c[r[i] ?? ""] = (c[r[i] ?? ""] ?? 0) + 1;
            return Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, n);
          };
          const dates = distinct("Date", 1000)?.map(([d]) => d).sort() ?? [];
          samples.push({
            granularity: g, instance: newest.processingDate, segments: segs.items.length, httpStatus: fileRes.status,
            rows: rows.length, header,
            dates: dates.length ? { first: dates[0], last: dates[dates.length - 1], distinct: dates.length } : null,
            sourceType: distinct("Source Type"), sourceInfo: distinct("Source Info"), campaign: distinct("Campaign"),
            downloadType: distinct("Download Type"), pageType: distinct("Page Type"), event: distinct("Event"),
            sampleRows: rows.slice(0, 3),
          });
        } catch (e) { samples.push({ granularity: g, instance: newest.processingDate, error: e instanceof Error ? e.message : String(e) }); }
      }
      perReport.push({ name: rep.attributes?.name, category: rep.attributes?.category, reportId: rep.id, instancesStatus: inst.status, instancesError: inst.error, instanceCount: instances.length, byGranularity: byGran, samples });
    }
    out[kind] = { requestStatus: req.status, request: (req.j.data as Res | undefined)?.attributes ?? req.j.errors, reportsListed: reports.items.length, reportsError: reports.error, reports: perReport };
  }
  return out;
}
