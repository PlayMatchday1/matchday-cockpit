// ACQUISITION PAGE — the three Google syncs (Ryan, 2026-10-04). Node only; never import from a
// client component.
//
//   gsc-pages  Search Console, https://www.playmatchday.com/, clicks / impressions / position per
//              page per day                                              → acq_gsc_page_daily
//              and per page × "soccer" query per day (0209)              → acq_gsc_query_daily
//   ga4-web    GA4 property 485975225: sessions / users / views per page per day → acq_web_page_daily
//              and store clicks per page per day                         → acq_web_store_click_daily
//   ga4-app    GA4 property 349835849 (Firebase matchday-sc): first_open and dynamic_link_first_open
//              per platform and source bucket per day                    → acq_app_event_daily
//
// READ ONLY AGAINST GOOGLE. searchAnalytics.query and runReport are POSTs that only query. The
// service account (GOOGLE_ANALYTICS_SA_KEY_B64) is Restricted in Search Console and Viewer on both
// GA4 properties; the key is decoded here and never logged, returned or put in an error.
//
// EVERY RUN RE-READS A TRAILING WINDOW and upserts on the primary key, so late data (Search Console
// runs ~2 days behind, GA4 about one) overwrites rather than freezes. A backfill is the same call
// with an explicit window. A day Google returns no row for is not written, never written as zero.
//
// STORE CLICKS — WHAT IS COUNTED. 'outbound_link' is GA4's enhanced-measurement `click` event whose
// linkUrl goes to apps.apple.com or play.google.com: the same measure from April 2025 to today, so
// it is THE store-click count the page shows. From Oct 1 the store buttons also fire
// `app_store_click` with store and tag; those land as 'app_store_click' rows for the tag split and
// are NOT added to the outbound count (the same press fires both). The outbound link itself carries
// the tag from Oct 1 (…&ct=web-austin), so the tag is also read from it.

import "server-only";
import { JWT } from "google-auth-library";
import type { SupabaseClient } from "@supabase/supabase-js";

export const GSC_SITE = "https://www.playmatchday.com/";
export const GA4_WEB = "485975225";
export const GA4_APP = "349835849";
/** The backfill floor Ryan set. */
export const ACQ_FLOOR = "2026-07-01";
/** Days re-read on every scheduled run. */
export const ACQ_TRAILING_DAYS = 7;

export async function googleAnalyticsToken(): Promise<string> {
  const b64 = process.env.GOOGLE_ANALYTICS_SA_KEY_B64?.trim();
  if (!b64) throw new Error("GOOGLE_ANALYTICS_SA_KEY_B64 is not set");
  let k: { client_email?: string; private_key?: string };
  try { k = JSON.parse(Buffer.from(b64, "base64").toString("utf8")); }
  catch { throw new Error("GOOGLE_ANALYTICS_SA_KEY_B64 did not base64-decode to JSON"); }
  if (!k.client_email || !k.private_key) throw new Error("service-account JSON is missing client_email / private_key");
  const jwt = new JWT({ email: k.client_email, key: k.private_key,
    scopes: ["https://www.googleapis.com/auth/webmasters.readonly", "https://www.googleapis.com/auth/analytics.readonly"] });
  const { token } = await jwt.getAccessToken();
  if (!token) throw new Error("no Google access token");
  return token;
}

async function post<T>(token: string, url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body), cache: "no-store",
  });
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(`${new URL(url).pathname}: HTTP ${res.status} ${String((j.error as { message?: string })?.message ?? "")}`.slice(0, 300));
  return j as T;
}

/** "20261003" → "2026-10-03" (GA4's date dimension). */
const gaDate = (s: string) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;

/** A page path as both sources should key it: path only, no query or fragment, trailing slash. */
export function normPath(urlOrPath: string): string {
  let p = urlOrPath.trim();
  try { if (/^https?:\/\//i.test(p)) p = new URL(p).pathname; } catch { /* keep as given */ }
  p = p.split("?")[0].split("#")[0] || "/";
  if (!p.startsWith("/")) p = `/${p}`;
  if (!p.endsWith("/") && !/\.[a-z0-9]{2,5}$/i.test(p)) p = `${p}/`;
  return p.toLowerCase();
}

async function upsert(sb: SupabaseClient, table: string, rows: Record<string, unknown>[], onConflict: string): Promise<number> {
  for (let i = 0; i < rows.length; i += 1000) {
    const { error } = await sb.from(table).upsert(rows.slice(i, i + 1000), { onConflict });
    if (error) throw new Error(`${table}: ${error.message}`);
  }
  return rows.length;
}

/* ── SEARCH CONSOLE ───────────────────────────────────────────────────────────────────────────── */
type GscRow = { keys: string[]; clicks: number; impressions: number; position: number };

export async function syncGsc(sb: SupabaseClient, token: string, since: string, until: string): Promise<{ rows: number; days: number; queryRows: number }> {
  const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(GSC_SITE)}/searchAnalytics/query`;
  // Several full URLs can normalise to one path (a query string, a missing slash); they are summed.
  const acc = new Map<string, { day: string; page_url: string; clicks: number; impressions: number; px: number }>();
  for (let startRow = 0; ; startRow += 25000) {
    const j = await post<{ rows?: GscRow[] }>(token, url,
      { startDate: since, endDate: until, dimensions: ["date", "page"], rowLimit: 25000, startRow, dataState: "final" });
    const rows = j.rows ?? [];
    for (const r of rows) {
      const day = r.keys[0], page = normPath(r.keys[1]);
      const k = `${day}|${page}`;
      const a = acc.get(k) ?? { day, page_url: page, clicks: 0, impressions: 0, px: 0 };
      a.clicks += r.clicks; a.impressions += r.impressions; a.px += r.position * r.impressions;
      acc.set(k, a);
    }
    if (rows.length < 25000) break;
  }
  const out = [...acc.values()].map((a) => ({
    day: a.day, page_url: a.page_url, clicks: Math.round(a.clicks), impressions: Math.round(a.impressions),
    position_x_impressions: Math.round(a.px * 100) / 100, synced_at: new Date().toISOString(),
  }));
  await upsert(sb, "acq_gsc_page_daily", out, "day,page_url");

  /* BY QUERY TOO (0209), for the Website table's Google rank. Only queries containing "soccer" —
   * Search Console filters server-side — so the table stays small; the page picks the exact rank
   * queries ("pickup soccer [city]" …) out of these. Same normalised path, same summing. */
  const qacc = new Map<string, { day: string; page_url: string; query: string; clicks: number; impressions: number; px: number }>();
  for (let startRow = 0; ; startRow += 25000) {
    const j = await post<{ rows?: GscRow[] }>(token, url, {
      startDate: since, endDate: until, dimensions: ["date", "page", "query"], rowLimit: 25000, startRow, dataState: "final",
      dimensionFilterGroups: [{ filters: [{ dimension: "query", operator: "contains", expression: "soccer" }] }],
    });
    const rows = j.rows ?? [];
    for (const r of rows) {
      const day = r.keys[0], page = normPath(r.keys[1]), query = r.keys[2].trim().toLowerCase();
      const k = `${day}|${page}|${query}`;
      const a = qacc.get(k) ?? { day, page_url: page, query, clicks: 0, impressions: 0, px: 0 };
      a.clicks += r.clicks; a.impressions += r.impressions; a.px += r.position * r.impressions;
      qacc.set(k, a);
    }
    if (rows.length < 25000) break;
  }
  const qout = [...qacc.values()].map((a) => ({
    day: a.day, page_url: a.page_url, query: a.query, clicks: Math.round(a.clicks), impressions: Math.round(a.impressions),
    position_x_impressions: Math.round(a.px * 100) / 100, synced_at: new Date().toISOString(),
  }));
  await upsert(sb, "acq_gsc_query_daily", qout, "day,page_url,query");
  return { rows: out.length, days: new Set(out.map((r) => r.day)).size, queryRows: qout.length };
}

/* ── GA4 ──────────────────────────────────────────────────────────────────────────────────────── */
type GaRow = { dimensionValues?: { value: string }[]; metricValues?: { value: string }[] };
type GaReport = { rows?: GaRow[]; rowCount?: number };

async function runAll(token: string, property: string, body: Record<string, unknown>): Promise<string[][]> {
  const out: string[][] = [];
  for (let offset = 0; ; offset += 100000) {
    const j = await post<GaReport>(token, `https://analyticsdata.googleapis.com/v1beta/properties/${property}:runReport`,
      { ...body, limit: 100000, offset });
    for (const r of j.rows ?? []) out.push([...(r.dimensionValues ?? []).map((d) => d.value), ...(r.metricValues ?? []).map((m) => m.value)]);
    if (offset + 100000 >= (j.rowCount ?? 0)) break;
  }
  return out;
}

const storeOf = (s: string): "" | "apple" | "google" =>
  /apps\.apple\.com|^apple$/i.test(s) ? "apple" : /play\.google\.com|^google$/i.test(s) ? "google" : "";
const tagOfUrl = (u: string): string => { try { return new URL(u).searchParams.get("ct") ?? ""; } catch { return ""; } };
const clean = (v: string) => (v === "(not set)" ? "" : v);

export async function syncGa4Web(sb: SupabaseClient, token: string, since: string, until: string): Promise<{ pageRows: number; clickRows: number }> {
  const dateRanges = [{ startDate: since, endDate: until }];
  // 1 — traffic per page per day
  const pages = await runAll(token, GA4_WEB, { dateRanges, dimensions: [{ name: "date" }, { name: "pagePath" }],
    metrics: [{ name: "sessions" }, { name: "totalUsers" }, { name: "screenPageViews" }] });
  const pAcc = new Map<string, { day: string; page_path: string; sessions: number; users: number; views: number }>();
  for (const [d, path, s, u, v] of pages) {
    const day = gaDate(d), page = normPath(path), k = `${day}|${page}`;
    const a = pAcc.get(k) ?? { day, page_path: page, sessions: 0, users: 0, views: 0 };
    a.sessions += Number(s); a.users += Number(u); a.views += Number(v); pAcc.set(k, a);
  }
  // 2 — outbound store clicks (the `click` event only)
  const outbound = await runAll(token, GA4_WEB, { dateRanges,
    dimensions: [{ name: "date" }, { name: "pagePath" }, { name: "linkUrl" }], metrics: [{ name: "eventCount" }],
    dimensionFilter: { andGroup: { expressions: [
      { filter: { fieldName: "eventName", stringFilter: { value: "click" } } },
      { orGroup: { expressions: [
        { filter: { fieldName: "linkUrl", stringFilter: { matchType: "CONTAINS", value: "apps.apple.com" } } },
        { filter: { fieldName: "linkUrl", stringFilter: { matchType: "CONTAINS", value: "play.google.com" } } }] } }] } } });
  // 3 — the tagged event, from Oct 1
  const tagged = await runAll(token, GA4_WEB, { dateRanges,
    dimensions: [{ name: "date" }, { name: "pagePath" }, { name: "customEvent:store" }, { name: "customEvent:tag" }],
    metrics: [{ name: "eventCount" }], dimensionFilter: { filter: { fieldName: "eventName", stringFilter: { value: "app_store_click" } } } });
  const cAcc = new Map<string, { day: string; page_path: string; method: string; store: string; tag: string; clicks: number }>();
  const add = (day: string, page: string, method: string, store: string, tag: string, n: number) => {
    const k = `${day}|${page}|${method}|${store}|${tag}`;
    const a = cAcc.get(k) ?? { day, page_path: page, method, store, tag, clicks: 0 };
    a.clicks += n; cAcc.set(k, a);
  };
  for (const [d, path, link, n] of outbound) add(gaDate(d), normPath(path), "outbound_link", storeOf(link), tagOfUrl(link), Number(n));
  for (const [d, path, st, tg, n] of tagged) add(gaDate(d), normPath(path), "app_store_click", storeOf(clean(st)), clean(tg), Number(n));

  const now = new Date().toISOString();
  const pRows = [...pAcc.values()].map((a) => ({ ...a, synced_at: now }));
  const cRows = [...cAcc.values()].map((a) => ({ ...a, synced_at: now }));
  await upsert(sb, "acq_web_page_daily", pRows, "day,page_path");
  await upsert(sb, "acq_web_store_click_daily", cRows, "day,page_path,method,store,tag");
  return { pageRows: pRows.length, clickRows: cRows.length };
}

/** Where a first open came from — the buckets the page.link split uses (Ryan, 2026-10-04). */
export function sourceBucket(source: string, medium: string): "share" | "ig_social" | "paid" | "other" {
  const s = source.toLowerCase(), m = medium.toLowerCase();
  if (s === "firebase" && m === "dynamic_link") return "share";
  if ((s === "ig" || s === "instagram") && m === "social") return "ig_social";
  if (["ig", "fb", "instagram", "facebook"].includes(s) && m === "paid") return "paid";
  return "other";
}

export const APP_EVENTS = ["first_open", "dynamic_link_first_open"] as const;

export async function syncGa4App(sb: SupabaseClient, token: string, since: string, until: string): Promise<{ rows: number }> {
  const rows = await runAll(token, GA4_APP, { dateRanges: [{ startDate: since, endDate: until }],
    dimensions: [{ name: "date" }, { name: "eventName" }, { name: "platform" }, { name: "sessionSource" }, { name: "sessionMedium" }],
    metrics: [{ name: "eventCount" }, { name: "totalUsers" }],
    dimensionFilter: { filter: { fieldName: "eventName", inListFilter: { values: [...APP_EVENTS] } } } });
  const acc = new Map<string, { day: string; event_name: string; platform: string; source_bucket: string; event_count: number; users: number }>();
  for (const [d, ev, pl, src, med, n, u] of rows) {
    const day = gaDate(d), bucket = sourceBucket(src, med), k = `${day}|${ev}|${pl}|${bucket}`;
    const a = acc.get(k) ?? { day, event_name: ev, platform: pl, source_bucket: bucket, event_count: 0, users: 0 };
    // Users summed across sources over-count a person seen under two sources; event counts are exact.
    a.event_count += Number(n); a.users += Number(u); acc.set(k, a);
  }
  const now = new Date().toISOString();
  const out = [...acc.values()].map((a) => ({ ...a, synced_at: now }));
  await upsert(sb, "acq_app_event_daily", out, "day,event_name,platform,source_bucket");
  return { rows: out.length };
}
